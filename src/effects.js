import * as THREE from 'three/webgpu';
import { softParam } from './boxes.js';
import { groundAt, isWaterAt } from './terrain.js';

const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), e = new THREE.Euler();
const col = new THREE.Color(), col2 = new THREE.Color(), UP = new THREE.Vector3(0, 1, 0), Z_AXIS = new THREE.Vector3(0, 0, 1);
const FLAT = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);   // soft disc lying on the water
const rnd = (a, b) => a + Math.random() * (b - a);
// Wreckage pieces: a wing, a tail, a chunk of fuselage. [sx, sy, sz]
const WRECK_PARTS = [[6, 0.4, 2.2], [2, 2, 1], [2.2, 2.2, 4]];

export class Effects {
  constructor(lit, glow, soft) {
    this.lit = lit; this.glow = glow; this.soft = soft;
    this.shards = []; this.puffs = []; this.flashes = []; this.wrecks = []; this.rings = [];
    this.shake = 0;
  }

  /** Takes a slot from a batch, recycling the oldest particle of that kind when the batch is full. */
  slot(list, batch) {
    let i = batch.alloc();
    if (i < 0) { const old = list.shift(); if (!old) return -1; i = old.i; }
    return i;
  }

  explosion(pos, colors, size = 1) {
    // Flash
    this.spawnFlash(pos, 9 * size, 0.35);
    // Fireball puffs
    for (let k = 0; k < 10 * size; k++) {
      const hot = Math.random() < 0.7;
      this.spawnPuff(p.copy(pos).add(s.set(rnd(-3, 3), rnd(-3, 3), rnd(-3, 3))),
        s.set(rnd(-14, 14), rnd(-6, 22), rnd(-14, 14)), hot ? (Math.random() < 0.5 ? 0xff7a3d : 0xffc24a) : 0x7d8390,
        (hot ? rnd(1.5, 3.1) : rnd(1.2, 2.3)) * size, rnd(1.2, 2.2), hot);
    }
    // Confetti-style debris in the plane's colors
    for (let k = 0; k < 42 * size; k++) {
      const hex = colors[Math.floor(Math.random() * colors.length)];
      this.spawnShard(pos, s.set(rnd(-1, 1), rnd(-0.6, 1), rnd(-1, 1)).normalize().multiplyScalar(rnd(18, 55)), hex, rnd(0.6, 1.6), rnd(1.6, 3.2));
    }
  }

  /** Big tumbling pieces that carry the plane's momentum and trail smoke until they hit the ground or sea. */
  wreck(pos, vel, colors) {
    WRECK_PARTS.forEach((part, k) => {
      const i = this.slot(this.wrecks, this.lit); if (i < 0) return;
      this.lit.color(i, colors[k % colors.length]); this.lit.scalar(i, 0.6);
      this.wrecks.push({
        i, p: pos.clone(), v: vel.clone().multiplyScalar(0.6).add(s.set(rnd(-12, 12), rnd(4, 16), rnd(-12, 12))),
        r: new THREE.Vector3(rnd(-6, 6), rnd(-6, 6), rnd(-6, 6)), a: new THREE.Vector3(rnd(0, 6), rnd(0, 6), rnd(0, 6)),
        size: new THREE.Vector3(part[0], part[1], part[2]), life: 3.5, t: 0, smoke: 0,
      });
    });
  }

  hitSpark(pos) {
    this.spawnFlash(pos, 1.6, 0.08);
    for (let k = 0; k < 4; k++) this.spawnShard(pos, s.set(rnd(-1, 1), rnd(-1, 1), rnd(-1, 1)).normalize().multiplyScalar(rnd(10, 25)), 0xffd166, 0.35, 0.5);
  }

  muzzle(pos) { this.spawnFlash(pos, 0.7, 0.05); }

  groundHit(pos, water) {
    if (water) {
      for (let k = 0; k < 3; k++) this.spawnPuff(pos, s.set(rnd(-3, 3), rnd(6, 14), rnd(-3, 3)), 0xeafcff, rnd(0.8, 1.6), 0.7, false);
    } else {
      this.spawnPuff(pos, s.set(rnd(-2, 2), rnd(3, 6), rnd(-2, 2)), 0xd9c39a, 1.3, 0.8, false);
    }
  }

  splash(pos, size = 1) {
    for (let k = 0; k < 18 * size; k++) this.spawnPuff(p.copy(pos).add(s.set(rnd(-4, 4), 0, rnd(-4, 4))), s.set(rnd(-10, 10), rnd(15, 35), rnd(-10, 10)), 0xf0ffff, rnd(2, 5) * size, rnd(1, 1.8), false);
    this.spawnFlash(pos, 4 * size, 0.15);
    // two expanding rings spread out across the water
    this.spawnRing(pos, 0, 44 * size);
    this.spawnRing(pos, 0.3, 30 * size);
  }

  /** Sea spray kicked up when skimming the water. */
  spray(pos, vel) {
    for (let k = 0; k < 2; k++) this.spawnPuff(p.copy(pos).add(s.set(rnd(-3, 3), -2, rnd(-2, 2))), s.set(rnd(-4, 4), rnd(4, 9), rnd(-4, 4)).addScaledVector(vel, -0.12), 0xf2ffff, rnd(0.7, 1.3), 0.55, false);
  }
  /** Dust dragged up off a beach. */
  dust(pos, vel) {
    this.spawnPuff(p.copy(pos).add(s.set(rnd(-3, 3), -3, rnd(-2, 2))), s.set(rnd(-2, 2), rnd(2, 5), rnd(-2, 2)).addScaledVector(vel, -0.08), 0xdcc79a, rnd(1.0, 1.8), 0.9, false);
  }
  /** Fronds torn off a palm the plane clips. */
  leaves(pos, vel) {
    for (let k = 0; k < 3; k++) this.spawnShard(pos, s.set(rnd(-1, 1), rnd(0.2, 1), rnd(-1, 1)).normalize().multiplyScalar(rnd(6, 14)).addScaledVector(vel, 0.25), Math.random() < 0.5 ? 0x3fc45f : 0x2ea24d, rnd(0.5, 0.9), rnd(1.2, 2.0));
  }
  /** The vapour cone that blooms around the plane as it punches past its top speed. */
  cone(pos, forward) {
    if (!this.soft) return;
    const i = this.slot(this.rings, this.soft); if (i < 0) return;
    this.soft.color(i, 0xffffff);
    const qq = new THREE.Quaternion().setFromUnitVectors(Z_AXIS, forward);
    this.rings.push({ i, p: pos.clone(), t: 0, life: 0.4, radius: 20, q: qq, inner: 0.3, alpha: 0.7 });
  }

  trailSmoke(pos, vel, heavy) {
    this.spawnPuff(pos, s.set(rnd(-2, 2), rnd(0, 3), rnd(-2, 2)).addScaledVector(vel, 0.1), heavy ? 0x3a3f4a : 0x8b929c, heavy ? 1.6 : 1.0, heavy ? 1.6 : 1.0, heavy && Math.random() < 0.3);
  }

  spawnShard(pos, vel, hex, size, life) {
    const i = this.slot(this.shards, this.lit); if (i < 0) return;
    this.lit.color(i, hex); this.lit.scalar(i, 0.7);
    this.shards.push({ i, p: pos.clone(), v: vel.clone(), r: new THREE.Vector3(rnd(-8, 8), rnd(-8, 8), rnd(-8, 8)), a: new THREE.Vector3(rnd(0, 6), rnd(0, 6), rnd(0, 6)), size, life, t: 0 });
  }
  spawnPuff(pos, vel, hex, size, life, hot) {
    const i = this.slot(this.puffs, this.lit); if (i < 0) return;
    this.lit.color(i, hex, hot ? 1.8 : 1); this.lit.scalar(i, 1);
    this.puffs.push({ i, p: pos.clone(), v: vel.clone(), size: size * 1.6, life, t: 0, hot, hex, rot: rnd(0, 6) });
  }
  spawnFlash(pos, size, life) {
    const i = this.slot(this.flashes, this.glow); if (i < 0) return;
    this.glow.color(i, 0xffd27a); this.glow.scalar(i, 4.5);
    this.flashes.push({ i, p: pos.clone(), size: size * 1.4, life, t: 0 });
  }
  spawnRing(pos, delay, radius) {
    if (!this.soft) return;
    const i = this.slot(this.rings, this.soft); if (i < 0) return;
    this.soft.color(i, 0xffffff);
    this.rings.push({ i, p: pos.clone(), t: -delay, life: 1.6, radius });
  }

  update(dt) {
    this.shake = Math.max(0, this.shake - dt * 2.2);
    // shards: gravity, tumble, shrink at the end
    const sh = this.shards;
    for (let k = sh.length - 1; k >= 0; k--) {
      const it = sh[k];
      it.t += dt;
      if (it.t >= it.life) { this.lit.release(it.i); sh.splice(k, 1); continue; }
      it.v.y -= 30 * dt; it.v.multiplyScalar(1 - dt * 0.9);
      it.p.addScaledVector(it.v, dt);
      it.a.addScaledVector(it.r, dt);
      const f = it.t / it.life;
      const sz = it.size * (f > 0.75 ? (1 - f) / 0.25 : 1);
      e.set(it.a.x, it.a.y, it.a.z); q.setFromEuler(e);
      this.lit.matrix(it.i, m.compose(it.p, q, s.setScalar(sz)));
    }
    // wrecks: heavy tumbling pieces that smoke and stop at the ground (splashing into the sea)
    const wr = this.wrecks;
    for (let k = wr.length - 1; k >= 0; k--) {
      const it = wr[k];
      it.t += dt;
      const ground = groundAt(it.p.x, it.p.z);
      if (it.t >= it.life || it.p.y < ground + 1) {
        if (it.p.y < ground + 1 && isWaterAt(it.p.x, it.p.z)) { it.p.y = 0.6; this.splash(it.p, 0.35); }
        this.lit.release(it.i); wr.splice(k, 1); continue;
      }
      it.v.y -= 30 * dt; it.v.multiplyScalar(1 - dt * 0.4);
      it.p.addScaledVector(it.v, dt);
      it.a.addScaledVector(it.r, dt);
      it.smoke -= dt;
      if (it.smoke <= 0) { it.smoke = 0.07; this.spawnPuff(it.p, s.set(rnd(-1, 1), rnd(1, 4), rnd(-1, 1)), it.t < 0.8 ? 0x3a3f4a : 0x8b929c, 1.1, 1.1, it.t < 0.5 && Math.random() < 0.4); }
      e.set(it.a.x, it.a.y, it.a.z); q.setFromEuler(e);
      this.lit.matrix(it.i, m.compose(it.p, q, it.size));
    }
    // puffs: expand, rise, fade to gray then shrink out
    const pu = this.puffs;
    for (let k = pu.length - 1; k >= 0; k--) {
      const it = pu[k];
      it.t += dt;
      if (it.t >= it.life) { this.lit.release(it.i); pu.splice(k, 1); continue; }
      it.v.multiplyScalar(1 - dt * 2.2); it.v.y += 6 * dt;
      it.p.addScaledVector(it.v, dt);
      const f = it.t / it.life;
      const grow = Math.min(1, f * 4);
      const sz = it.size * (0.4 + grow * 0.9) * (f > 0.6 ? 1 - (f - 0.6) / 0.4 : 1);
      if (it.hot) this.lit.color(it.i, col.set(it.hex).lerp(col2.set(0x7d8390), Math.min(1, f * 2.2)), 1.8 - 1.2 * Math.min(1, f * 2));
      q.setFromAxisAngle(UP, it.rot + f);
      this.lit.matrix(it.i, m.compose(it.p, q, s.setScalar(Math.max(0.001, sz))));
    }
    // flashes: pop then vanish
    const fl = this.flashes;
    for (let k = fl.length - 1; k >= 0; k--) {
      const it = fl[k];
      it.t += dt;
      if (it.t >= it.life) { this.glow.release(it.i); fl.splice(k, 1); continue; }
      const f = it.t / it.life;
      const sz = it.size * (0.3 + Math.sin(f * Math.PI) * 0.9);
      this.glow.matrix(it.i, m.compose(it.p, q.setFromAxisAngle(UP, f * 2), s.setScalar(sz)));
    }
    // rings: spread out and thin while fading
    const rg = this.rings;
    for (let k = rg.length - 1; k >= 0; k--) {
      const it = rg[k];
      it.t += dt;
      if (it.t < 0) continue;
      if (it.t >= it.life) { this.soft.release(it.i); rg.splice(k, 1); continue; }
      const f = it.t / it.life, ease = 1 - (1 - f) * (1 - f);
      const d = (4 + it.radius * ease) * 2;
      if (it.q) {   // a free-standing ring (vapour cone)
        this.soft.scalar(it.i, softParam(it.alpha * (1 - f), it.inner + 0.1 * f));
        this.soft.matrix(it.i, m.compose(it.p, it.q, s.set(d, d, 1)));
        continue;
      }
      this.soft.scalar(it.i, softParam(0.85 * (1 - f), 0.38 + 0.07 * f));
      this.soft.matrix(it.i, m.compose(p.set(it.p.x, 0.6, it.p.z), FLAT, s.set(d, d, 1)));
    }
  }

  clear() {
    for (const it of this.shards) this.lit.release(it.i);
    for (const it of this.wrecks) this.lit.release(it.i);
    for (const it of this.puffs) this.lit.release(it.i);
    for (const it of this.flashes) this.glow.release(it.i);
    if (this.soft) for (const it of this.rings) this.soft.release(it.i);
    this.shards.length = this.wrecks.length = this.puffs.length = this.flashes.length = this.rings.length = 0;
  }
}
