// Homing missiles: few, earned, and the answer to a bandit you cannot get your nose on. Each is a glow box with a
// flickering motor and a ribbon of smoke turned to face the camera, widening as it fades. It leaves the wing at the
// plane's speed, accelerates, and turns toward where its target will be, at a rate the wave sets. A target that drops
// flares sends it chasing them instead.
import * as THREE from 'three/webgpu';
import { groundAt, isWaterAt } from './terrain.js';
import { Trails } from './trails.js';

const m = new THREE.Matrix4(), UP = new THREE.Vector3(0, 1, 0), ahead = new THREE.Vector3(), aim = new THREE.Vector3(), dir = new THREE.Vector3(), back = new THREE.Vector3(), side = new THREE.Vector3();
const BODY = new THREE.Vector3(0.6, 0.6, 3.4), MOTOR = new THREE.Vector3(0.9, 0.9, 1.4), flicker = new THREE.Vector3();
const TOP_SPEED = 230, BOOST = 170, LIFE = 4.5;

export class Missiles {
  constructor(scene, glow, max = 6) {
    this.glow = glow;
    this.smoke = new Trails(scene, max, 50, 0.7, { fade: 0.7, opacity: 0.8, sample: 0.03, widen: true, renderOrder: 5 });
    const base = glow.alloc(max * 2);
    this.list = Array.from({ length: max }, (_, k) => {
      glow.color(base + k * 2, 0xfff4dc); glow.scalar(base + k * 2, 2.2);
      glow.color(base + k * 2 + 1, 0xffa040); glow.scalar(base + k * 2 + 1, 5);
      return { slot: base + k * 2, ribbon: this.smoke.ribbon(), live: false, pos: new THREE.Vector3(), vel: new THREE.Vector3(), target: null, decoy: new THREE.Vector3(), decoyed: false, t: 0, turn: 0, flareAt: -1 };
    });
  }

  /** Fires at `target` from `pos` with `vel`. `turn` is how hard it can turn (radians a second); `flareAt` is when the
   *  target shakes it off with flares, in seconds after launch, or -1 if it never does. */
  launch(pos, vel, target, turn, flareAt = -1) {
    const it = this.list.find((x) => !x.live);
    if (!it) return null;
    it.live = true; it.pos.copy(pos); it.vel.copy(vel); it.target = target; it.decoyed = false; it.t = 0; it.turn = turn; it.flareAt = flareAt;
    this.smoke.reset(it.ribbon);
    return it;
  }

  kill(it) { it.live = false; this.glow.hide(it.slot, 2); }
  clear() { for (const it of this.list) { if (it.live) this.kill(it); this.smoke.reset(it.ribbon); } this.smoke.update(0); }

  /** `eye` is the camera's position (the smoke faces it). `onHit(target, point)` when one strikes, `onFlare(target)`
   *  when a target throws flares, `onDud(point, water)` when one hits the ground or runs out of motor. */
  update(dt, eye, onHit, onFlare, onDud) {
    this.smoke.update(dt);
    for (const it of this.list) {
      if (!it.live) continue;
      it.t += dt;
      const t = it.target;
      if (!it.decoyed && it.flareAt >= 0 && it.t >= it.flareAt && t.alive) {
        it.decoyed = true;
        it.decoy.copy(t.pos).addScaledVector(t.velocity, -0.4).add(aim.set(0, -12, 0));
        onFlare(t);
      }
      let speed = it.vel.length();
      speed = Math.min(TOP_SPEED, speed + BOOST * dt);
      dir.copy(it.vel).divideScalar(speed || 1);
      const homing = it.decoyed || (t && t.alive);
      if (homing) {
        // steer for where the target will be when the missile gets there (or for the flares)
        if (it.decoyed) aim.copy(it.decoy);
        else aim.copy(t.pos).addScaledVector(t.velocity, Math.min(2, it.pos.distanceTo(t.pos) / speed));
        aim.sub(it.pos).normalize();
        const ang = Math.acos(THREE.MathUtils.clamp(aim.dot(dir), -1, 1));
        if (ang > 1e-4) dir.lerp(aim, Math.min(1, it.turn * dt / ang)).normalize();
      }
      it.vel.copy(dir).multiplyScalar(speed);
      it.pos.addScaledVector(it.vel, dt);
      back.copy(it.pos).addScaledVector(dir, -2.4);
      this.smoke.push(it.ribbon, dt, back, side.crossVectors(dir, aim.copy(eye).sub(back)).normalize(), 1);
      const ground = groundAt(it.pos.x, it.pos.z);
      if (it.pos.y < ground + 1) { this.kill(it); onDud(it.pos, isWaterAt(it.pos.x, it.pos.z)); continue; }
      if (t && t.alive && !it.decoyed && it.pos.distanceToSquared(t.pos) < (t.stats.radius + 3) ** 2) { this.kill(it); onHit(t, it.pos); continue; }
      if (it.t > LIFE || (it.decoyed && it.pos.distanceToSquared(it.decoy) < 64)) { this.kill(it); onDud(it.pos, false); continue; }
      ahead.copy(it.pos).add(it.vel);
      m.lookAt(it.pos, ahead, UP).scale(BODY).setPosition(it.pos);
      this.glow.matrix(it.slot, m);
      m.lookAt(it.pos, ahead, UP).scale(flicker.copy(MOTOR).multiplyScalar(0.8 + Math.random() * 0.5)).setPosition(back.copy(it.pos).addScaledVector(dir, -2.2));
      this.glow.matrix(it.slot + 1, m);
    }
  }
}
