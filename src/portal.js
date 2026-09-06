// The bandits' way in: an obsidian frame that assembles itself in the sky out of flying blocks, fills with a swirling
// teal sheet, spits out the wave, then dissolves. 24 lit boxes and one glow box, reused every wave.
import * as THREE from 'three/webgpu';

const B = 5, COLS = 6, ROWS = 8, LIFT = 20;
const CELLS = [];
for (let c = 0; c < COLS; c++) CELLS.push([c, 0], [c, ROWS - 1]);
for (let r = 1; r < ROWS - 1; r++) CELLS.push([0, r], [COLS - 1, r]);
const m = new THREE.Matrix4(), p = new THREE.Vector3(), lp = new THREE.Vector3(), s = new THREE.Vector3(), q = new THREE.Quaternion(), qz = new THREE.Quaternion();
const Z = new THREE.Vector3(0, 0, 1);
const ease = (t) => { t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); };
const rnd = (a, b) => a + Math.random() * (b - a);

export class Portal {
  constructor(lit, glow) {
    this.lit = lit; this.glow = glow;
    this.blocks = lit.alloc(CELLS.length);
    for (let k = 0; k < CELLS.length; k++) { lit.color(this.blocks + k, 0x1c1226); lit.scalar(this.blocks + k, 0.35); }
    this.fill = glow.alloc();
    glow.color(this.fill, 0x3fe6d4); glow.scalar(this.fill, 1.6);
    this.pos = new THREE.Vector3(); this.quat = new THREE.Quaternion();
    this.from = CELLS.map(() => new THREE.Vector3());
    this.active = false; this.t = 0; this.life = 0;
  }

  /** Opens at `pos`, facing along the quaternion's -Z, for `life` seconds. */
  open(pos, quat, life) {
    this.pos.copy(pos); this.quat.copy(quat); this.t = 0; this.life = life; this.active = true;
    for (const f of this.from) f.set(rnd(-70, 70), rnd(-50, 50), rnd(-70, 70));
  }

  /** A point just in front of the sheet where a bandit appears. */
  emergePoint(out) {
    return out.set(rnd(-6, 6), LIFT + rnd(-6, 6), 6).applyQuaternion(this.quat).add(this.pos);
  }

  update(dt) {
    if (!this.active) return;
    this.t += dt;
    if (this.t >= this.life) { this.active = false; this.hide(); return; }
    const assemble = ease(this.t / 0.9), dissolve = ease((this.t - (this.life - 0.6)) / 0.6);
    for (let k = 0; k < CELLS.length; k++) {
      const [c, r] = CELLS[k];
      lp.set((c - (COLS - 1) / 2) * B, (r - (ROWS - 1) / 2) * B + LIFT, 0).applyQuaternion(this.quat).add(this.pos);
      p.copy(lp).add(this.from[k]).lerp(lp, assemble);
      const sc = B * (1 - dissolve) * Math.min(1, 0.3 + assemble);
      q.copy(this.quat).multiply(qz.setFromAxisAngle(Z, (1 - assemble) * 3));
      this.lit.matrix(this.blocks + k, m.compose(p, q, s.set(sc, sc, sc)));
    }
    const open = ease((this.t - 0.8) / 0.5) * (1 - dissolve);
    lp.set(0, LIFT, 0).applyQuaternion(this.quat).add(this.pos);
    q.copy(this.quat).multiply(qz.setFromAxisAngle(Z, this.t * 1.3));
    this.glow.scalar(this.fill, 1.3 + Math.sin(this.t * 9) * 0.35);
    this.glow.matrix(this.fill, m.compose(lp, q, s.set((COLS - 2) * B * 0.95 * open, (ROWS - 2) * B * 0.95 * open, 0.6)));
  }

  hide() { this.lit.hide(this.blocks, CELLS.length); this.glow.hide(this.fill); this.active = false; }
}
