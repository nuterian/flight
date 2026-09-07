import * as THREE from 'three/webgpu';
import { softParam } from './boxes.js';
import { groundAt, isWaterAt } from './terrain.js';

const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), e = new THREE.Euler();
const col = new THREE.Color(), col2 = new THREE.Color(), UP = new THREE.Vector3(0, 1, 0), Z_AXIS = new THREE.Vector3(0, 0, 1), STILL = new THREE.Vector3();
const FLAT = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);   // soft disc lying on the water
const rnd = (a, b) => a + Math.random() * (b - a);
// Wreckage pieces: a wing, a tail, a chunk of fuselage. [sx, sy, sz]
const WRECK_PARTS = [[6, 0.4, 2.2], [2, 2, 1], [2.2, 2.2, 4]];

// Every particle is one record and one box in a batch. A kind names the batch, the gravity and drag it falls with,
// and how its box is drawn from the record at a fraction `f` of its life; the record carries everything else.
const tumbling = (it) => q.setFromEuler(e.set(it.a.x, it.a.y, it.a.z));
const KIND = {
  // debris: gravity, tumble, shrink out over the last quarter
  shard: { batch: 'lit', g: 30, drag: 0.9, draw: (fx, it, f) => fx.lit.matrix(it.i, m.compose(it.p, tumbling(it), s.setScalar(it.size * (f > 0.75 ? (1 - f) / 0.25 : 1)))) },
  // heavy tumbling pieces that smoke and stop at the ground (splashing into the sea)
  wreck: { batch: 'lit', g: 30, drag: 0.4, ground: true, draw: (fx, it) => fx.lit.matrix(it.i, m.compose(it.p, tumbling(it), it.dim)) },
  // smoke and fire: rise, expand, fade hot colours to grey, then shrink out
  puff: {
    batch: 'lit', g: -6, drag: 2.2, draw: (fx, it, f) => {
      const sz = it.size * (0.4 + Math.min(1, f * 4) * 0.9) * (f > 0.6 ? 1 - (f - 0.6) / 0.4 : 1);
      if (it.hot) fx.lit.color(it.i, col.set(it.hex).lerp(col2.set(0x7d8390), Math.min(1, f * 2.2)), 1.8 - 1.2 * Math.min(1, f * 2));
      fx.lit.matrix(it.i, m.compose(it.p, q.setFromAxisAngle(UP, it.rot + f), s.setScalar(Math.max(0.001, sz))));
    },
  },
  // a glow that pops then vanishes
  flash: { batch: 'glow', g: 0, drag: 0, draw: (fx, it, f) => fx.glow.matrix(it.i, m.compose(it.p, q.setFromAxisAngle(UP, f * 2), s.setScalar(it.size * (0.3 + Math.sin(f * Math.PI) * 0.9)))) },
  // a soft ring that spreads and thins while it fades: on the water, or standing in the air as the vapour cone
  ring: {
    batch: 'soft', g: 0, drag: 0, draw: (fx, it, f) => {
      const d = (4 + it.radius * (1 - (1 - f) * (1 - f))) * 2;
      fx.soft.scalar(it.i, softParam(it.alpha * (1 - f), it.inner + it.spread * f));
      fx.soft.matrix(it.i, m.compose(it.p, it.q, s.set(d, d, 1)));
    },
  },
};

export class Effects {
  constructor(lit, glow, soft) {
    this.lit = lit; this.glow = glow; this.soft = soft;
    this.particles = []; this.pool = [];
    this.shake = 0;
  }

  /** A particle of `kind` at `pos` moving at `vel`: takes a box from the kind's batch (the live particle nearest its
   *  end when the batch is full) and a record from the pool, so a burst allocates nothing. Null when there is no room. */
  spawn(kind, pos, vel, life) {
    const K = KIND[kind], batch = this[K.batch];
    if (!batch) return null;
    let i = batch.alloc();
    if (i < 0) {
      let k = -1, kf = -1;
      this.particles.forEach((it, n) => { const f = it.t / it.life; if (KIND[it.kind].batch === K.batch && f > kf) { kf = f; k = n; } });
      if (k < 0) return null;
      i = this.drop(k).i;
    }
    const it = this.pool.pop() || { p: new THREE.Vector3(), v: new THREE.Vector3(), r: new THREE.Vector3(), a: new THREE.Vector3(), dim: new THREE.Vector3(), q: new THREE.Quaternion() };
    it.kind = kind; it.i = i; it.t = 0; it.life = life;
    it.p.copy(pos); it.v.copy(vel); it.r.set(0, 0, 0); it.a.set(0, 0, 0);
    this.particles.push(it);
    return it;
  }
  /** Retires the particle at index `k`: its box goes back to the batch, its record to the pool. */
  drop(k) {
    const L = this.particles, it = L[k];
    this[KIND[it.kind].batch].release(it.i);
    L[k] = L[L.length - 1]; L.pop(); this.pool.push(it);
    return it;
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
      const it = this.spawn('wreck', pos, vel, 3.5); if (!it) return;
      this.lit.color(it.i, colors[k % colors.length]); this.lit.scalar(it.i, 0.6);
      it.v.multiplyScalar(0.6).add(s.set(rnd(-12, 12), rnd(4, 16), rnd(-12, 12)));
      it.r.set(rnd(-6, 6), rnd(-6, 6), rnd(-6, 6)); it.a.set(rnd(0, 6), rnd(0, 6), rnd(0, 6));
      it.dim.set(part[0], part[1], part[2]); it.smoke = 0;
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
    const it = this.spawn('ring', pos, STILL, 0.4); if (!it) return;
    this.soft.color(it.i, 0xffffff);
    it.q.setFromUnitVectors(Z_AXIS, forward);
    it.radius = 20; it.alpha = 0.7; it.inner = 0.3; it.spread = 0.1;
  }

  trailSmoke(pos, vel, heavy) {
    this.spawnPuff(pos, s.set(rnd(-2, 2), rnd(0, 3), rnd(-2, 2)).addScaledVector(vel, 0.1), heavy ? 0x3a3f4a : 0x8b929c, heavy ? 1.6 : 1.0, heavy ? 1.6 : 1.0, heavy && Math.random() < 0.3);
  }

  spawnShard(pos, vel, hex, size, life) {
    const it = this.spawn('shard', pos, vel, life); if (!it) return;
    this.lit.color(it.i, hex); this.lit.scalar(it.i, 0.7);
    it.size = size; it.r.set(rnd(-8, 8), rnd(-8, 8), rnd(-8, 8)); it.a.set(rnd(0, 6), rnd(0, 6), rnd(0, 6));
  }
  spawnPuff(pos, vel, hex, size, life, hot) {
    const it = this.spawn('puff', pos, vel, life); if (!it) return;
    this.lit.color(it.i, hex, hot ? 1.8 : 1); this.lit.scalar(it.i, 1);
    it.size = size * 1.6; it.hot = hot; it.hex = hex; it.rot = rnd(0, 6);
  }
  spawnFlash(pos, size, life) {
    const it = this.spawn('flash', pos, STILL, life); if (!it) return;
    this.glow.color(it.i, 0xffd27a); this.glow.scalar(it.i, 4.5);
    it.size = size * 1.4;
  }
  spawnRing(pos, delay, radius) {
    const it = this.spawn('ring', pos, STILL, 1.6); if (!it) return;
    this.soft.color(it.i, 0xffffff);
    it.p.y = 0.6; it.q.copy(FLAT); it.t = -delay;
    it.radius = radius; it.alpha = 0.85; it.inner = 0.38; it.spread = 0.07;
  }

  update(dt) {
    this.shake = Math.max(0, this.shake - dt * 2.2);
    const L = this.particles;
    for (let k = L.length - 1; k >= 0; k--) {
      const it = L[k], K = KIND[it.kind];
      it.t += dt;
      if (it.t < 0) continue;   // a ring waiting its turn
      const f = it.t / it.life;
      const floor = K.ground ? groundAt(it.p.x, it.p.z) + 1 : -Infinity;
      if (f >= 1 || it.p.y < floor) {
        if (it.p.y < floor && isWaterAt(it.p.x, it.p.z)) { it.p.y = 0.6; this.splash(it.p, 0.35); }
        this.drop(k); continue;
      }
      it.v.y -= K.g * dt; it.v.multiplyScalar(1 - dt * K.drag);
      it.p.addScaledVector(it.v, dt);
      it.a.addScaledVector(it.r, dt);
      if (K.ground) {   // wreckage smokes as it falls, black at first
        it.smoke -= dt;
        if (it.smoke <= 0) { it.smoke = 0.07; this.spawnPuff(it.p, s.set(rnd(-1, 1), rnd(1, 4), rnd(-1, 1)), it.t < 0.8 ? 0x3a3f4a : 0x8b929c, 1.1, 1.1, it.t < 0.5 && Math.random() < 0.4); }
      }
      K.draw(this, it, f);
    }
  }

  clear() { while (this.particles.length) this.drop(this.particles.length - 1); }
}
