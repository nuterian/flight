// Every box in the game is an instance of one unit cube carrying a matrix, a color and one scalar: roughness when
// lit, glow intensity when emissive, packed radius/alpha when soft. Props, planes, particles, tracers and the sun
// share a handful of draw calls.
import * as THREE from 'three/webgpu';
import { attribute, varyingProperty, positionGeometry, length, smoothstep, floor, fract, hash, instanceIndex, vec3, dot } from 'three/tsl';

// The renderer writes each instance's color into this varying; reading it lets glow boxes emit their own color.
const instanceColor = varyingProperty('vec3', 'vInstanceColor');

const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
const UP = new THREE.Vector3(0, 1, 0);
const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), col = new THREE.Color();

/** Soft-batch scalar: integer part is the inner radius (x100), fraction is the alpha. */
export const softParam = (alpha, inner = 0) => Math.round(inner * 100) + Math.min(0.999, Math.max(0, alpha));

export class Boxes {
  constructor(scene, capacity, { glow = false, soft = false, positionNode = null } = {}) {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    this.param = new THREE.InstancedBufferAttribute(new Float32Array(capacity).fill(0.8), 1);
    geo.setAttribute('param', this.param);
    let mat;
    if (soft) {
      // Translucent cube masked to a disc (or a ring) in its local xy plane: prop blur discs, splash rings.
      // The side faces fall outside the radius so only the two flat faces ever show.
      mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
      const param = attribute('param', 'float');
      const r = length(positionGeometry.xy);
      const inner = floor(param).div(100);
      const disc = smoothstep(0.5, 0.44, r).mul(smoothstep(inner, inner.add(0.05), r));
      mat.opacityNode = disc.mul(fract(param));
    } else {
      mat = new THREE.MeshStandardNodeMaterial(glow ? { color: 0x000000, roughness: 1 } : { roughness: 1, metalness: 0.05 });
      if (glow) { mat.emissiveNode = instanceColor.mul(attribute('param', 'float')); mat.fog = false; }
      else {
        mat.roughnessNode = attribute('param', 'float');
        // a 4x4 grid of texels per face, jittered per instance, so props and planes read as pixel art up close
        const texel = floor(positionGeometry.add(0.5).mul(4).min(3.999));
        const grain = hash(dot(texel, vec3(1, 17.3, 91.7)).add(instanceIndex.toFloat().mul(0.731)).add(0.17)).mul(0.1).add(0.95);
        mat.colorNode = vec3(grain);
      }
    }
    if (positionNode) mat.positionNode = positionNode;
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3).fill(1), 3);
    this.mesh.castShadow = this.mesh.receiveShadow = !glow && !soft;
    this.mesh.frustumCulled = false;
    if (soft) this.mesh.renderOrder = 3;
    for (let i = 0; i < capacity; i++) this.mesh.setMatrixAt(i, ZERO);
    this.mesh.count = 0;
    this.capacity = capacity; this.top = 0; this.free = [];
    // Dirty tracking in buckets of 256 slots: a frame touches a few hundred scattered slots (animated props,
    // planes, particles), so uploading only the dirty buckets, merged into runs, beats one span over all of them.
    this.dirty = new Uint8Array(Math.ceil(capacity / BUCKET) + 1);
    this.any = false;
    scene.add(this.mesh);
  }

  /** One slot from the free list, or a contiguous run from the top. Returns -1 when full. */
  alloc(n = 1) {
    if (n === 1 && this.free.length) return this.free.pop();
    if (this.top + n > this.capacity) return -1;
    const i = this.top; this.top += n; return i;
  }
  release(i) { this.hide(i); this.free.push(i); }
  hide(i, n = 1) { for (let k = 0; k < n; k++) this.matrix(i + k, ZERO); }

  touch(i) { this.dirty[i >> BUCKET_SHIFT] = 1; this.any = true; }
  matrix(i, mtx) { this.mesh.setMatrixAt(i, mtx); this.touch(i); }
  color(i, c, mul = 1) { this.mesh.setColorAt(i, col.set(c).multiplyScalar(mul)); this.touch(i); }
  scalar(i, v) { this.param.setX(i, v); this.touch(i); }
  /** Static box: position, size, color, scalar, optional yaw. */
  box(i, x, y, z, sx, sy, sz, c, scalar = 0.8, ry = 0) {
    this.matrix(i, m.compose(p.set(x, y, z), q.setFromAxisAngle(UP, ry), s.set(sx, sy, sz)));
    this.color(i, c); this.scalar(i, scalar);
  }
  /** Place a run of boxes under a parent matrix. */
  place(start, locals, parent) {
    for (let k = 0; k < locals.length; k++) this.mesh.setMatrixAt(start + k, m.multiplyMatrices(parent, locals[k]));
    for (let b = start >> BUCKET_SHIFT, last = (start + locals.length - 1) >> BUCKET_SHIFT; b <= last; b++) this.dirty[b] = 1;
    this.any = true;
  }
  /** Paints a run of static parts [x, y, z, sx, sy, sz, color, roughness?] from `start` and returns their local
   *  matrices, ready for `place`. `rough` is the roughness a part does not name. */
  paint(start, parts, rough = 0.8) {
    parts.forEach((b, k) => { this.color(start + k, b[6]); this.scalar(start + k, b[7] ?? rough); });
    return parts.map((b) => local(b[0], b[1], b[2], b[3], b[4], b[5]));
  }
  /** A group is a run of boxes with local matrices, re-placed under a parent matrix each frame. */
  group(parts, rough) { const start = this.alloc(parts.length); return { start, locals: this.paint(start, parts, rough) }; }

  /** Upload only the buckets touched since the last flush, each run of them as one range. Call once per frame. */
  flush() {
    this.mesh.count = this.top;
    if (!this.any) return;
    const attrs = [this.mesh.instanceMatrix, this.mesh.instanceColor, this.param];
    for (const a of attrs) a.clearUpdateRanges();
    const d = this.dirty, nb = Math.ceil(this.top / BUCKET);
    for (let b = 0; b < nb; b++) {
      if (!d[b]) continue;
      let e = b;
      while (e + 1 < nb && d[e + 1]) e++;
      const lo = b * BUCKET, n = Math.min(this.top, (e + 1) * BUCKET) - lo;
      this.mesh.instanceMatrix.addUpdateRange(lo * 16, n * 16);
      this.mesh.instanceColor.addUpdateRange(lo * 3, n * 3);
      this.param.addUpdateRange(lo, n);
      b = e;
    }
    for (const a of attrs) a.needsUpdate = true;
    d.fill(0); this.any = false;
  }
}
const BUCKET_SHIFT = 8, BUCKET = 1 << BUCKET_SHIFT;

/** A box's local matrix inside a group. */
export const local = (x, y, z, sx, sy, sz) => new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion(), new THREE.Vector3(sx, sy, sz));
