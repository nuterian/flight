// The title, built out of the world's own blocks as riveted steel: light brushed plates on the face with dark seams
// between them, darker steel for the depth, a bolt head at every plate corner and the odd rust-stained plate.
// Lit and shadowed by the sun like everything else, dropping into place letter by letter and then floating, always
// turned to face the camera.
import * as THREE from 'three/webgpu';
import { local } from './boxes.js';

const GLYPHS = {
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  G: ['01110', '10001', '10000', '10011', '10001', '10001', '01110'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
};
const B = 10, GAP = 1, DEPTH = 5;
const PLATE = [0xa4adb6, 0x99a2ab, 0xafb8c0, 0x9ea9b3], DEEP = [0x4e545b, 0x565c64, 0x474d54], RUST = [0x8a5a3a, 0x7d4f33];
const BOLT = 0x4a5058, BOLT_R = 1.0;
const one = (set) => set[Math.floor(Math.random() * set.length)];
const pick = (d) => (d > 0 ? one(DEEP) : Math.random() < 0.09 ? one(RUST) : one(PLATE));
const m = new THREE.Matrix4(), g = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3(), eul = new THREE.Euler();
const ONE = new THREE.Vector3(1, 1, 1), UP = new THREE.Vector3(0, 1, 0);
const backOut = (t) => { t = t < 0 ? 0 : t > 1 ? 1 : t; const c = 1.7; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };

export class Title {
  constructor(lit, glow, word = 'FLIGHT') {
    this.lit = lit; this.glow = glow;
    this.pos = new THREE.Vector3(0, 240, 0);
    this.blocks = [];   // { local, letter, col, delay }
    const cols = word.length * 5 + (word.length - 1) * GAP;
    const x0 = -cols * B / 2 + B / 2;
    const bolts = new Set();
    [...word].forEach((ch, li) => {
      const rows = GLYPHS[ch];
      for (let r = 0; r < 7; r++) for (let c = 0; c < 5; c++) {
        if (rows[r][c] !== '1') continue;
        const col = li * (5 + GAP) + c, x = x0 + col * B, y = (6 - r) * B - 3 * B;
        const delay = (col / cols) * 1.1 + Math.random() * 0.12;
        for (let d = 0; d < DEPTH; d++) {
          // the face plate sits a hair smaller than its neighbours so a dark seam of the plate behind shows
          const sz = d === 0 ? B * 0.93 : B;
          this.blocks.push({ local: local(x, y, -d * B, sz, sz, d === 0 ? B * 1.06 : B), letter: li, col, delay: delay + d * 0.05, hex: pick(d), rough: d === 0 ? 0.38 : 0.6 });
        }
        // bolt heads at the plate corners, shared where plates meet
        for (const [ox, oy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
          const bx = x + ox * B * 0.38, by = y + oy * B * 0.38, key = `${Math.round(bx * 10)},${Math.round(by * 10)}`;
          if (bolts.has(key)) continue;
          bolts.add(key);
          this.blocks.push({ local: local(bx, by, B * 0.53 + 0.35, BOLT_R, BOLT_R, 0.9), letter: li, col, delay: delay + 0.08, hex: BOLT, rough: 0.45 });
        }
      }
    });
    this.base = lit.alloc(this.blocks.length);
    this.blocks.forEach((b, k) => { lit.color(this.base + k, b.hex); lit.scalar(this.base + k, b.rough); });
    this.letters = word.length;
    // a few twinkles drifting around the letters
    this.sparks = glow.alloc(6);
    for (let k = 0; k < 6; k++) { glow.color(this.sparks + k, 0xfff3c4); glow.scalar(this.sparks + k, 2.5); }
    this.t = -1; this.shown = false;
  }

  hide() {
    this.lit.hide(this.base, this.blocks.length);
    this.glow.hide(this.sparks, 6);
    this.shown = false;
  }

  update(dt, time, camera, visible) {
    if (!visible) { if (this.shown) this.hide(); return; }
    if (!this.shown) { this.shown = true; this.t = 0; } else this.t += dt;
    const t = this.t;
    // face the camera, float gently
    const yaw = Math.atan2(camera.position.x - this.pos.x, camera.position.z - this.pos.z);
    eul.set(Math.sin(time * 0.5) * 0.03, yaw, Math.sin(time * 0.4) * 0.02);
    p.copy(this.pos); p.y += Math.sin(time * 0.8) * 2;
    g.compose(p, q.setFromEuler(eul), ONE);
    for (let k = 0; k < this.blocks.length; k++) {
      const b = this.blocks[k];
      const u = (t - b.delay) / 0.7;
      if (u <= 0) { this.lit.hide(this.base + k); continue; }
      const e = backOut(u);
      const drop = (1 - e) * 70, bob = Math.sin(time * 1.1 + b.letter * 0.9) * 1.2;
      m.copy(b.local);
      m.elements[13] += drop + bob;
      const sc = Math.min(1, u * 3);
      m.elements[0] *= sc; m.elements[5] *= sc; m.elements[10] *= sc;
      this.lit.matrix(this.base + k, m.premultiply(g));
    }
    for (let k = 0; k < 6; k++) {
      const a = time * (0.25 + k * 0.05) + k * 1.05, r = 150 + Math.sin(time * 0.7 + k) * 20;
      const tw = Math.max(0, Math.sin(time * 3.1 + k * 2.3));
      p.set(Math.cos(a) * r, this.pos.y + Math.sin(time * 0.9 + k * 1.7) * 26 + 10, Math.sin(a) * r * 0.35);
      s.setScalar(0.4 + tw * 1.6);
      this.glow.scalar(this.sparks + k, 1.5 + tw * 2.5);
      this.glow.matrix(this.sparks + k, m.compose(p.applyQuaternion(q).add(this.pos), q, s));
    }
  }
}
