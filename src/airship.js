// The airship: every fifth wave's boss. A long two-tone voxel envelope with four fins, engine pods with spinning
// props, a gondola slung underneath with lit windows, and two turrets that track you and fire in bursts. The
// envelope shrugs bullets off; only the gondola takes damage. When it dies it falls for a few seconds, exploding
// along its length, and goes up in the biggest blast in the game when it meets the ground or the sea.
import * as THREE from 'three/webgpu';
import { local } from './boxes.js';
import { groundAt, isWaterAt, BOUNDS } from './terrain.js';
import { BULLET_SPEED } from './bullets.js';

const CREAM = 0xf3e6c8, RED = 0xc7402e, DARK = 0x2b2f3a, BRASS = 0xd9a441, GLASS = 0xffd27a;
// [sx, sy, sz, x, y, z, color]. Nose toward -Z.
const RINGS = [[7, 5.5, 12, 0, 0, -42], [12, 9.5, 12, 0, 0, -30], [17, 13.5, 12, 0, 0, -18], [20, 16, 12, 0, 0, -6], [19, 15, 12, 0, 0, 6], [16, 12.5, 12, 0, 0, 18], [11, 8.5, 12, 0, 0, 30], [6, 4.5, 10, 0, 0, 41]];
const PARTS = [
  ...RINGS.map((r, k) => [...r, k % 2 ? RED : CREAM]),
  [1.2, 11, 9, 0, 8, 38, RED], [1.2, 11, 9, 0, -8, 38, RED], [11, 1.2, 9, 8, 0, 38, RED], [11, 1.2, 9, -8, 0, 38, RED],   // fins
  [7, 4.5, 16, 0, -10, 2, DARK], [5, 1.2, 12, 0, -12.6, 2, BRASS],                                                       // gondola and keel
  [3, 3, 6, 9.5, -6, 8, DARK], [3, 3, 6, -9.5, -6, 8, DARK],                                                             // engine pods
  [3, 2, 3, 0, 9, -12, BRASS], [3, 2, 3, 0, -8, 24, BRASS],                                                              // turret bases
];
const PART_LOCALS = PARTS.map((b) => local(b[3], b[4], b[5], b[0], b[1], b[2]));
const WINDOWS = [[4.2, 1.2, 0.4, 0, -9.6, -6.3], [4.2, 1.2, 0.4, 0, -9.6, 10.3]];
const WINDOW_LOCALS = WINDOWS.map((b) => local(b[3], b[4], b[5], b[0], b[1], b[2]));
const PROP_PIVOTS = [new THREE.Vector3(9.5, -6, 4.8), new THREE.Vector3(-9.5, -6, 4.8)];
const PROP_LOCAL = local(0, 0, 0, 0.35, 4.6, 0.25);
const TURRETS = [{ pivot: new THREE.Vector3(0, 10.5, -12), up: 1 }, { pivot: new THREE.Vector3(0, -9.5, 24), up: -1 }];
const BARREL_LOCAL = local(0, 0, -2.8, 0.8, 0.8, 4.5);
const SLOTS = PARTS.length + PROP_PIVOTS.length + TURRETS.length;
const m = new THREE.Matrix4(), m2 = new THREE.Matrix4(), q = new THREE.Quaternion(), q2 = new THREE.Quaternion(), p = new THREE.Vector3(), v = new THREE.Vector3(), e = new THREE.Euler(), ONE = new THREE.Vector3(1, 1, 1);
const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0), NEG_Z = new THREE.Vector3(0, 0, -1);
const rnd = (a, b) => a + Math.random() * (b - a);
const clamp = THREE.MathUtils.clamp;

/** A bullet target with the shape the pool expects: a sphere that may absorb (armour) or take damage (the gondola). */
class Hull {
  constructor(ship, radius, absorb) { this.ship = ship; this.pos = new THREE.Vector3(); this.velocity = ship.velocity; this.stats = { radius }; this.absorb = absorb; this.team = 1; this.alive = false; this.hitFlash = 0; }
  damage(d) { return this.absorb ? false : this.ship.hurt(d); }
}

export class Airship {
  constructor(lit, glow, effects) {
    this.lit = lit; this.glow = glow; this.effects = effects;
    this.base = lit.alloc(SLOTS);
    PARTS.forEach((b, k) => { lit.color(this.base + k, b[6]); lit.scalar(this.base + k, 0.75); });
    for (let k = 0; k < PROP_PIVOTS.length + TURRETS.length; k++) { lit.color(this.base + PARTS.length + k, k < 2 ? DARK : BRASS); lit.scalar(this.base + PARTS.length + k, 0.6); }
    this.windows = glow.alloc(WINDOWS.length);
    for (let k = 0; k < WINDOWS.length; k++) { glow.color(this.windows + k, GLASS); glow.scalar(this.windows + k, 1.5); }
    this.pos = new THREE.Vector3(); this.velocity = new THREE.Vector3(); this.quat = new THREE.Quaternion();
    this.heading = 0; this.speed = 14; this.alive = false; this.falling = 0; this.hp = 1; this.maxHp = 1;
    this.team = 1; this.prop = 0; this.smoke = 0; this.boom = 0;
    // the envelope as three armoured spheres and the gondola as the one that counts
    this.gondola = new Hull(this, 12, false);
    this.armour = [new Hull(this, 15, true), new Hull(this, 17, true), new Hull(this, 14, true)];
    this.targets = [this.gondola, ...this.armour];
    this.turrets = TURRETS.map(() => ({ yaw: 0, pitch: 0, timer: rnd(1, 2.5), burst: 0, gun: 0 }));
    this.tilt = 0; this.roll = 0;
    this.matrix = new THREE.Matrix4();
  }

  /** Drifts in from `from` toward `toward` at `y`, with `hp` on the gondola. */
  spawn(from, toward, y, hp) {
    this.pos.set(from.x, y, from.z);
    this.heading = Math.atan2(toward.x - from.x, toward.z - from.z);
    this.hp = this.maxHp = hp; this.alive = true; this.falling = 0; this.tilt = 0; this.roll = 0; this.smoke = 0; this.boom = 0;
    for (const t of this.targets) t.alive = true;
    this.place(0);
  }

  hurt(d) {
    if (!this.alive || this.falling > 0) return false;
    this.hp -= d; this.gondola.hitFlash = 0.12;
    if (this.hp <= 0) { this.hp = 0; this.falling = 1e-3; for (const t of this.targets) t.alive = false; return true; }
    return false;
  }

  hide() { this.lit.hide(this.base, SLOTS); this.glow.hide(this.windows, WINDOWS.length); this.alive = false; for (const t of this.targets) t.alive = false; }

  /** Slow flight inside the walls, turrets tracking the player, smoke when hurt, and the fall. Returns true the
   *  step it hits the ground, so the game can register the kill. */
  update(dt, player, fire) {
    if (!this.alive) return false;
    const ground = groundAt(this.pos.x, this.pos.z);
    if (this.falling > 0) {
      this.falling += dt;
      this.velocity.y -= 16 * dt; this.velocity.x *= 0.995; this.velocity.z *= 0.995;
      this.pos.addScaledVector(this.velocity, dt);
      this.tilt += (0.35 - this.tilt) * Math.min(1, dt * 0.6); this.roll += dt * 0.25;
      this.boom -= dt;
      if (this.boom <= 0) {   // explosions walk along the envelope as it goes down
        this.boom = 0.33;
        p.set(rnd(-6, 6), rnd(-8, 10), rnd(-40, 40)).applyQuaternion(this.quat).add(this.pos);
        this.effects.explosion(p, [CREAM, RED, DARK, BRASS], 1.1);
      }
      this.smoke -= dt;
      if (this.smoke <= 0) { this.smoke = 0.05; p.set(rnd(-6, 6), rnd(-4, 8), rnd(-30, 30)).applyQuaternion(this.quat).add(this.pos); this.effects.trailSmoke(p, this.velocity, true); }
      this.place(dt);
      if (this.pos.y < ground + 10 || this.falling > 9) {
        this.wreck(isWaterAt(this.pos.x, this.pos.z), ground);
        return true;
      }
      return false;
    }
    // cruise: a lazy turn back toward the middle when near a wall
    const edge = Math.max(Math.abs(this.pos.x), Math.abs(this.pos.z));
    if (edge > BOUNDS.half - 380) {
      const home = Math.atan2(-this.pos.x, -this.pos.z);
      let d = home - this.heading; d = Math.atan2(Math.sin(d), Math.cos(d));
      this.heading += clamp(d, -0.18 * dt, 0.18 * dt);
    }
    this.velocity.set(Math.sin(this.heading) * this.speed, 0, Math.cos(this.heading) * this.speed);
    this.pos.addScaledVector(this.velocity, dt);
    this.pos.y = Math.max(this.pos.y, ground + 90);
    // turrets: aim at your lead point and fire in bursts when you are close enough
    for (let k = 0; k < TURRETS.length; k++) {
      const t = this.turrets[k], T = TURRETS[k];
      p.copy(T.pivot).applyQuaternion(this.quat).add(this.pos);
      const dist = p.distanceTo(player.pos);
      v.copy(player.pos).addScaledVector(player.velocity, dist / BULLET_SPEED).sub(p);
      const wantYaw = Math.atan2(v.x, v.z) - this.heading;
      const wantPitch = Math.atan2(v.y, Math.hypot(v.x, v.z));
      let dy = wantYaw - t.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      t.yaw += clamp(dy, -0.9 * dt, 0.9 * dt); t.pitch += clamp(wantPitch - t.pitch, -0.8 * dt, 0.8 * dt);
      const inArc = T.up > 0 ? wantPitch > 0.12 : wantPitch < -0.12;   // each turret sees only its own side of the envelope
      t.timer -= dt; t.gun -= dt;
      if (t.burst > 0) { t.burst -= dt; if (player.alive && dist < 460 && t.gun <= 0 && inArc) { t.gun = 0.2; fire(p, v.normalize(), k); } }
      else if (t.timer <= 0) { t.timer = rnd(3.0, 4.4); if (player.alive && dist < 420 && inArc) t.burst = 0.45; }
    }
    if (this.hp < this.maxHp * 0.5) {
      this.smoke -= dt;
      if (this.smoke <= 0) { this.smoke = this.hp < this.maxHp * 0.25 ? 0.06 : 0.14; p.set(rnd(-3, 3), -9, rnd(-6, 8)).applyQuaternion(this.quat).add(this.pos); this.effects.trailSmoke(p, this.velocity, this.hp < this.maxHp * 0.25); }
    }
    if (this.gondola.hitFlash > 0) this.gondola.hitFlash -= dt;
    this.place(dt);
    return false;
  }

  /** The end: a chain of blasts, a shower of hull, rings on the water, and it is gone. */
  wreck(water, ground) {
    const fx = this.effects;
    this.pos.y = Math.max(this.pos.y, ground + 4);
    for (let k = 0; k < 5; k++) { p.set(rnd(-8, 8), rnd(-6, 10), -36 + k * 18).applyQuaternion(this.quat).add(this.pos); fx.explosion(p, [CREAM, RED, DARK, BRASS], 1.5); }
    fx.explosion(this.pos, [CREAM, RED, BRASS, DARK], 2.6);
    for (let k = 0; k < 40; k++) { p.set(rnd(-10, 10), rnd(-6, 10), rnd(-40, 40)).applyQuaternion(this.quat).add(this.pos); fx.spawnShard(p, v.set(rnd(-1, 1), rnd(0.2, 1), rnd(-1, 1)).normalize().multiplyScalar(rnd(25, 70)), k % 2 ? RED : CREAM, rnd(1.5, 3.5), rnd(2.5, 4.5)); }
    fx.wreck(this.pos, this.velocity, [RED, CREAM, DARK]);
    if (water) { fx.splash(this.pos, 2.2); } else { fx.spawnRing(this.pos, 0, 60); }
    this.hide();
  }

  place(dt) {
    this.prop += dt * 22;
    e.set(this.tilt, this.heading, Math.sin(this.roll) * (this.falling > 0 ? 0.5 : 0), 'YXZ');
    this.quat.setFromEuler(e);
    this.matrix.compose(this.pos, this.quat, ONE);
    this.lit.place(this.base, PART_LOCALS, this.matrix);
    for (let k = 0; k < PROP_PIVOTS.length; k++) {
      m.compose(PROP_PIVOTS[k], q.setFromAxisAngle(NEG_Z, this.prop + k * 1.3), ONE).multiply(PROP_LOCAL);
      this.lit.matrix(this.base + PARTS.length + k, m2.multiplyMatrices(this.matrix, m));
    }
    for (let k = 0; k < TURRETS.length; k++) {
      const t = this.turrets[k];
      q.setFromAxisAngle(Y, t.yaw).multiply(q2.setFromAxisAngle(X, -t.pitch));
      m.compose(TURRETS[k].pivot, q, ONE).multiply(BARREL_LOCAL);
      this.lit.matrix(this.base + PARTS.length + PROP_PIVOTS.length + k, m2.multiplyMatrices(this.matrix, m));
    }
    for (let k = 0; k < WINDOWS.length; k++) this.glow.matrix(this.windows + k, m2.multiplyMatrices(this.matrix, WINDOW_LOCALS[k]));
    // the hulls ride along: the gondola under the middle, the armour along the envelope
    this.gondola.pos.set(0, -11, 2).applyQuaternion(this.quat).add(this.pos);
    this.armour[0].pos.set(0, 0, -26).applyQuaternion(this.quat).add(this.pos);
    this.armour[1].pos.set(0, 0, 0).applyQuaternion(this.quat).add(this.pos);
    this.armour[2].pos.set(0, 0, 26).applyQuaternion(this.quat).add(this.pos);
  }
}
