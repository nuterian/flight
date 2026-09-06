import * as THREE from 'three/webgpu';
import { local, softParam } from './boxes.js';

// Bold toy-plane liveries. Hounds come in every colour; interceptors are navy with orange or gold; the ace is
// black with red and gold.
export const SCHEMES = {
  player: { body: 0xff4a36, accent: 0xfff3d6, trim: 0x22304a },
  enemies: [
    { body: 0x2f6bff, accent: 0xffd233, trim: 0x1c2a5a },
    { body: 0x19c2a3, accent: 0xff7a3d, trim: 0x0f4d47 },
    { body: 0x35405f, accent: 0xff4a36, trim: 0x1a1f33 },
    { body: 0xffc233, accent: 0x22304a, trim: 0x8a5a12 },
    { body: 0xb45cff, accent: 0xfff3d6, trim: 0x4a2a7a },
    { body: 0x2a2f4a, accent: 0xa4f542, trim: 0x15182b },
  ],
  interceptors: [{ body: 0x1d2a44, accent: 0xff8a2a, trim: 0xe8eef7 }, { body: 0x2b3a55, accent: 0xffd233, trim: 0xdfe6f0 }],
  ace: { body: 0x111318, accent: 0xff2e2e, trim: 0xffc233 },
};
// Silhouettes you can tell apart from behind. `fixed` overrides boxes of FIXED by index; `extras` fill the spare
// slots every plane carries. The hound is the plain plane: one fin. The interceptor: a long nose, a narrow wing, a
// tall fin with a ventral fin under it (a cross). The ace: twin fins either side of the tail (an H) and a stripe
// across each wing.
export const VARIANTS = {
  hound: { fixed: {}, extras: [] },
  interceptor: {
    fixed: { 3: [0, 0, -4.5, 2.0, 1.9, 2.8, 'accent'], 7: [0, -0.3, -0.5, 11.5, 0.45, 2.3, 'body'], 9: [0, 2.35, 4.6, 0.5, 3.3, 1.5, 'accent'] },
    extras: [[0, -1.2, 4.6, 0.4, 1.8, 1.4, 'accent']],
  },
  ace: {
    fixed: { 9: [0, 1.4, 4.6, 0.4, 1.4, 1.4, 'accent'] },
    extras: [[-2.6, 1.7, 4.6, 0.4, 2.4, 1.5, 'accent'], [2.6, 1.7, 4.6, 0.4, 2.4, 1.5, 'accent'], [-3.2, -0.3, -0.7, 1.2, 0.56, 3.25, 'trim'], [3.2, -0.3, -0.7, 1.2, 0.56, 3.25, 'trim']],
  },
};
const EXTRA_SLOTS = 4;
const GLASS = 0xbfe9ff, SKIN = 0xf0c8a0, GOGGLES = 0x222a3a, HELMET = 0x6b4a2e, SCORCH = 0x2a2622;
export const GUNS = [new THREE.Vector3(3.4, -0.3, -2.4), new THREE.Vector3(-3.4, -0.3, -2.4)];

// The plane as data. Nose points toward -Z. [x, y, z, sx, sy, sz, color, roughness]
const FIXED = [
  [0, 0, -0.6, 2.4, 2.2, 5.2, 'body'], [0, 0.15, 3.4, 1.7, 1.7, 3.2, 'body'], [0, 0.35, 5.6, 1.1, 1.1, 1.4, 'body'],
  [0, 0, -3.9, 2.0, 1.9, 1.5, 'accent'],            // nose
  [0, 0, -3.2, 2.7, 2.5, 0.7, 'trim'],              // cowl ring
  [0, 1.45, -1.85, 1.5, 0.8, 0.3, GLASS, 0.1],      // windscreen (the cockpit is open so the pilot shows)
  [0, 1.3, 0.7, 0.9, 0.5, 0.9, 'trim'],             // headrest
  [0, -0.3, -0.7, 11.5, 0.5, 3.2, 'body'],          // main wing
  [0, 0.6, 4.6, 5.6, 0.4, 1.6, 'body'], [0, 1.9, 4.6, 0.5, 2.4, 1.6, 'accent'],   // tail
  [-1.45, -0.55, -2.2, 0.4, 0.4, 1.0, 'trim'], [1.45, -0.55, -2.2, 0.4, 0.4, 1.0, 'trim'],   // exhaust stubs
];
const PROP = [[0, 0, 0, 0.8, 0.8, 0.7, 'trim'], [0, 0, 0, 0.45, 5.6, 0.2, 'trim'], [0, 0, 0, 5.6, 0.45, 0.2, 'trim']];
// Hinged groups: a pivot on the plane, an axis, and the boxes hanging off it. `ctrl` names the angle that drives it.
const HINGES = [
  { pivot: [-4.6, -0.3, 0.9], axis: 'x', sign: 1, boxes: [[0, 0, 0.45, 3.6, 0.3, 0.9, 'trim']], ctrl: 'aileron' },
  { pivot: [4.6, -0.3, 0.9], axis: 'x', sign: -1, boxes: [[0, 0, 0.45, 3.6, 0.3, 0.9, 'trim']], ctrl: 'aileron' },
  { pivot: [0, 0.6, 5.4], axis: 'x', sign: 1, boxes: [[0, 0, 0.4, 5.6, 0.3, 0.8, 'trim']], ctrl: 'elevator' },
  { pivot: [0, 1.9, 5.4], axis: 'y', sign: 1, boxes: [[0, 0, 0.4, 0.35, 2.2, 0.8, 'trim']], ctrl: 'rudder' },
  // wingtips bend under g (and one can be shot off)
  { pivot: [-5.75, -0.3, -0.9], axis: 'z', sign: -1, boxes: [[-1.1, 0, 0, 2.2, 0.5, 2.8, 'accent']], ctrl: 'flex', tip: 0 },
  { pivot: [5.75, -0.3, -0.9], axis: 'z', sign: 1, boxes: [[1.1, 0, 0, 2.2, 0.5, 2.8, 'accent']], ctrl: 'flex', tip: 1 },
  // landing gear folds outward and up under the wing once airborne
  { pivot: [-2.2, -1.0, -1.4], axis: 'z', sign: -1, boxes: [[0, -0.5, 0, 0.5, 1.0, 0.5, 'trim'], [0, -1.0, 0, 0.7, 1.1, 1.1, 'trim']], ctrl: 'gear' },
  { pivot: [2.2, -1.0, -1.4], axis: 'z', sign: 1, boxes: [[0, -0.5, 0, 0.5, 1.0, 0.5, 'trim'], [0, -1.0, 0, 0.7, 1.1, 1.1, 'trim']], ctrl: 'gear' },
];
// The pilot: shoulders, head, goggles and helmet, turned as one about the neck.
const PILOT_PIVOT = new THREE.Vector3(0, 1.05, -0.55);
const PILOT = [[0, 0.1, 0, 0.95, 0.5, 0.7, 'trim'], [0, 0.62, 0, 0.8, 0.8, 0.8, SKIN], [0, 0.7, 0, 0.84, 0.22, 0.84, GOGGLES], [0, 0.95, 0, 0.86, 0.32, 0.86, HELMET]];
const HINGE_OFFSET = []; { let o = FIXED.length + PROP.length; for (const h of HINGES) { HINGE_OFFSET.push(o); o += h.boxes.length; } }
const PILOT_OFFSET = FIXED.length + PROP.length + HINGES.reduce((n, h) => n + h.boxes.length, 0);
const EXTRA_OFFSET = PILOT_OFFSET + PILOT.length;
const PROP_PIVOT = new THREE.Vector3(0, 0, -4.95);
const DISC_LOCAL = local(0, 0, -4.95, 5.4, 5.4, 0.06);          // prop blur disc lies in the prop's xy plane
const FLAME = [[-1.45, -0.55, -1.2], [1.45, -0.55, -1.2]];       // exhaust flames trail back from the stubs
const FIRE = [0, 1.15, -3.1];                                    // damage fire licks up from the cowl
export const PLANE_SLOTS = EXTRA_OFFSET + EXTRA_SLOTS;

const hinge = new THREE.Matrix4(), world2 = new THREE.Matrix4(), q = new THREE.Quaternion(), q2 = new THREE.Quaternion(), v = new THREE.Vector3(), ONE = new THREE.Vector3(1, 1, 1), fs = new THREE.Vector3();
const AXIS = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };
const IDENT = new THREE.Quaternion(), eul = new THREE.Euler(), tmpC = new THREE.Color(), scorchC = new THREE.Color(SCORCH), crazeC = new THREE.Color(0xf4f8ff);

/** A plane is a run of boxes in the shared batch; placing it is a matrix multiply per box. */
export class Plane {
  constructor({ lit, glow, soft }, scheme, variant = 'hound') {
    this.boxes = lit; this.glow = glow; this.soft = soft; this.scheme = scheme;
    this.base = lit.alloc(PLANE_SLOTS);
    // prop: spin. aileron/elevator/rudder: deflection. flex: wingtip bend. gear: fold angle (0 down). disc: blur alpha.
    // flame: 0..1 boost. fire: 0..1 damage fire. headYaw/headPitch/headRoll: where the pilot is looking.
    this.angles = { prop: 0, aileron: 0, elevator: 0, rudder: 0, flex: 0, gear: 0, disc: 0, flame: 0, fire: 0, headYaw: 0, headPitch: 0, headRoll: 0 };
    this.lostTip = -1;   // 0 or 1 once a wingtip has been shot off
    this.disc = soft ? soft.alloc() : -1;
    if (soft) soft.color(this.disc, scheme.trim);
    this.flames = glow ? glow.alloc(3) : -1;
    if (glow) {
      for (let k = 0; k < 2; k++) { glow.color(this.flames + k, 0xff9a3c); glow.scalar(this.flames + k, 2.2); }
      glow.color(this.flames + 2, 0xff6a2a); glow.scalar(this.flames + 2, 2.4);
    }
    this.setVariant(variant, scheme);
  }

  /** Reshapes and repaints the plane: a silhouette from VARIANTS and a livery. Used when a bandit is re-issued. */
  setVariant(variant, scheme) {
    const v = VARIANTS[variant] || VARIANTS.hound, b = this.boxes, base = this.base;
    this.variant = variant; this.scheme = scheme;
    // a part's colour is one of the scheme's names or a literal
    const tint = (parts) => parts.map((p) => [p[0], p[1], p[2], p[3], p[4], p[5], typeof p[6] === 'string' ? scheme[p[6]] : p[6], p[7]]);
    this.fixed = FIXED.map((f, k) => v.fixed[k] || f);
    this.extras = v.extras;
    this.fixedLocals = b.paint(base, tint(this.fixed), 0.6);
    this.propLocals = b.paint(base + FIXED.length, tint(PROP), 0.6);
    this.hingeLocals = HINGES.map((h, k) => b.paint(base + HINGE_OFFSET[k], tint(h.boxes), 0.6));
    this.pilotLocals = b.paint(base + PILOT_OFFSET, tint(PILOT), 0.7);
    this.extraLocals = b.paint(base + EXTRA_OFFSET, tint(this.extras), 0.6);
    b.hide(base + EXTRA_OFFSET + this.extras.length, EXTRA_SLOTS - this.extras.length);
    if (this.soft) this.soft.color(this.disc, scheme.trim);
  }

  /** Battle damage on the paint: 0 = factory fresh, 1 = charred. Also crazes the windscreen past half. `flash`
   *  whitens the whole airframe for the frames after a hit lands. */
  scorch(t, flash = 0) {
    const b = this.boxes;
    this.fixed.forEach((f, k) => {
      if (typeof f[6] === 'string') b.color(this.base + k, tmpC.set(this.scheme[f[6]]).lerp(scorchC, t * 0.65).lerp(crazeC, flash));
      else b.color(this.base + k, tmpC.set(f[6]).lerp(crazeC, t > 0.5 ? 0.8 : 0));
    });
    this.extras.forEach((e, k) => b.color(this.base + EXTRA_OFFSET + k, tmpC.set(this.scheme[e[6]]).lerp(scorchC, t * 0.65).lerp(crazeC, flash)));
  }

  place(world) {
    const b = this.boxes, a = this.angles;
    b.place(this.base, this.fixedLocals, world);
    if (this.extras.length) b.place(this.base + EXTRA_OFFSET, this.extraLocals, world);
    hinge.compose(PROP_PIVOT, q.setFromAxisAngle(AXIS.z, a.prop), ONE);
    b.place(this.base + FIXED.length, this.propLocals, world2.multiplyMatrices(world, hinge));
    for (let k = 0; k < HINGES.length; k++) {
      const h = HINGES[k];
      if (h.tip !== undefined && h.tip === this.lostTip) { b.hide(this.base + HINGE_OFFSET[k], h.boxes.length); continue; }
      hinge.compose(v.set(h.pivot[0], h.pivot[1], h.pivot[2]), q.setFromAxisAngle(AXIS[h.axis], a[h.ctrl] * h.sign), ONE);
      b.place(this.base + HINGE_OFFSET[k], this.hingeLocals[k], world2.multiplyMatrices(world, hinge));
    }
    // the pilot turns to look: yaw about the neck, then a nod, then a lean
    eul.set(a.headPitch, a.headYaw, a.headRoll, 'YXZ');
    hinge.compose(PILOT_PIVOT, q.setFromEuler(eul), ONE);
    b.place(this.base + PILOT_OFFSET, this.pilotLocals, world2.multiplyMatrices(world, hinge));
    if (this.soft) {
      this.soft.scalar(this.disc, softParam(a.disc));
      this.soft.matrix(this.disc, world2.multiplyMatrices(world, DISC_LOCAL));
    }
    if (this.glow) {
      for (let k = 0; k < 2; k++) {
        if (a.flame <= 0) { this.glow.hide(this.flames + k); continue; }
        const len = (0.9 + Math.random() * 0.7) * a.flame;
        hinge.compose(v.set(FLAME[k][0], FLAME[k][1], FLAME[k][2] + len * 0.5), IDENT, fs.set(0.3, 0.3, len));
        this.glow.matrix(this.flames + k, world2.multiplyMatrices(world, hinge));
      }
      if (a.fire <= 0) this.glow.hide(this.flames + 2);
      else {
        const h = (0.5 + Math.random() * 0.9) * a.fire;
        hinge.compose(v.set(FIRE[0] + (Math.random() - 0.5) * 0.6, FIRE[1] + h * 0.5, FIRE[2]), q2.setFromAxisAngle(AXIS.y, Math.random() * 6), fs.set(0.5 * a.fire + 0.2, h, 0.5 * a.fire + 0.2));
        this.glow.matrix(this.flames + 2, world2.multiplyMatrices(world, hinge));
      }
    }
  }

  hide() {
    this.boxes.hide(this.base, PLANE_SLOTS);
    if (this.soft) this.soft.hide(this.disc);
    if (this.glow) this.glow.hide(this.flames, 3);
  }
}
