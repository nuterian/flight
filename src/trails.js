// Vapor ribbons: every ribbon in the game is a strip inside one mesh, one geometry, one upload per frame.
// Wingtip trails and boat wakes are two instances with different width, fade and sample rates.
import * as THREE from 'three/webgpu';
import { attribute } from 'three/tsl';

const tmp = new THREE.Vector3();

export class Trails {
  constructor(scene, ribbons, n = 40, width = 0.34, { fade = 0.9, opacity = 0.62, sample = 0.028, widen = false, renderOrder = 5 } = {}) {
    this.n = n; this.width = width; this.fade = fade; this.sample = sample; this.widen = widen; this.ribbons = [];
    for (let r = 0; r < ribbons; r++) {
      const points = [];
      for (let i = 0; i < n; i++) points.push({ p: new THREE.Vector3(), side: new THREE.Vector3(0, 1, 0), a: 0 });
      this.ribbons.push({ points, timer: 0, fresh: true });
    }
    this.pos = new Float32Array(ribbons * n * 6);
    this.alpha = new Float32Array(ribbons * n * 2);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    const idx = [];
    for (let r = 0; r < ribbons; r++) for (let i = 0; i < n - 1; i++) { const a = (r * n + i) * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    geo.setIndex(idx);
    const mat = new THREE.MeshBasicNodeMaterial({ color: 0xffffff, transparent: true, depthWrite: false, side: THREE.DoubleSide });
    mat.opacityNode = attribute('alpha', 'float').mul(opacity);
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    this.next = 0;
    scene.add(this.mesh);
  }

  /** Claims a ribbon; returns its index. */
  ribbon() { return this.next++; }
  /** Empties a ribbon. The next push gathers every point onto the emitter, so no strip is ever drawn from where
   *  the ribbon used to be (or from the origin, on the first push) to where it is now. */
  reset(r) { const rb = this.ribbons[r]; for (const pt of rb.points) pt.a = 0; rb.fresh = true; }

  /** Call every step with the emitter position, the strip's side vector and a 0..1 intensity. */
  push(r, dt, position, side, intensity) {
    const rb = this.ribbons[r];
    if (rb.fresh) { rb.fresh = false; for (const pt of rb.points) { pt.p.copy(position); pt.side.copy(side); pt.a = 0; } }
    rb.timer -= dt;
    if (rb.timer <= 0) {
      rb.timer = this.sample;
      const pt = rb.points.shift();
      pt.p.copy(position); pt.side.copy(side); pt.a = intensity;
      rb.points.push(pt);
    } else {
      // keep the head glued to the emitter between samples so the ribbon never detaches
      const head = rb.points[this.n - 1];
      head.p.copy(position); head.side.copy(side); head.a = Math.max(head.a, intensity);
    }
  }

  update(dt) {
    let any = false;
    const n = this.n, fade = this.fade, widen = this.widen;
    this.ribbons.forEach((rb, r) => {
      for (let i = 0; i < n; i++) {
        const pt = rb.points[i];
        if (pt.a > 0) { pt.a = Math.max(0, pt.a - dt * fade); any = true; }
        // vapor thins as it fades; a wake spreads as it fades
        const w = this.width * (widen ? 1.6 - pt.a : 0.4 + pt.a * 0.8);
        tmp.copy(pt.side).multiplyScalar(w);
        const o = (r * n + i) * 6;
        this.pos[o] = pt.p.x + tmp.x; this.pos[o + 1] = pt.p.y + tmp.y; this.pos[o + 2] = pt.p.z + tmp.z;
        this.pos[o + 3] = pt.p.x - tmp.x; this.pos[o + 4] = pt.p.y - tmp.y; this.pos[o + 5] = pt.p.z - tmp.z;
        // fade the tail and the very tip so the strip never shows a hard edge
        const taper = Math.min(1, i / 6) * Math.min(1, (n - 1 - i) / 2 + 0.35);
        this.alpha[(r * n + i) * 2] = this.alpha[(r * n + i) * 2 + 1] = pt.a * taper;
      }
    });
    this.mesh.visible = any;
    if (any) { this.mesh.geometry.attributes.position.needsUpdate = true; this.mesh.geometry.attributes.alpha.needsUpdate = true; }
  }
}
