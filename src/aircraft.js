import * as THREE from 'three/webgpu';
import { GUNS } from './plane.js';

const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0), NEG_Z = new THREE.Vector3(0, 0, -1), NEG_Y = new THREE.Vector3(0, -1, 0);
const tq = new THREE.Quaternion(), tq2 = new THREE.Quaternion(), vq = new THREE.Quaternion();
const ONE = new THREE.Vector3(1, 1, 1), vp = new THREE.Vector3(), tv = new THREE.Vector3();
const smoothstep = THREE.MathUtils.smoothstep;
const GEAR_UP_SPEED = 58, GEAR_FOLD = 1.5;

export const PLAYER_STATS = { minSpeed: 42, cruise: 70, maxSpeed: 125, pitchRate: 1.7, rollRate: 3.4, yawRate: 0.9, bankTurn: 1.15, autoLevel: 0.9, accel: 1.6, radius: 5 };
export const ENEMY_STATS = { minSpeed: 40, cruise: 66, maxSpeed: 100, pitchRate: 1.5, rollRate: 3.0, yawRate: 0.8, bankTurn: 1.1, autoLevel: 0.6, accel: 1.4, radius: 5 };

export class Aircraft {
  constructor(plane, stats, team) {
    this.plane = plane;
    this.pos = new THREE.Vector3();
    this.quat = new THREE.Quaternion();
    this.matrix = new THREE.Matrix4();
    this.stats = stats;
    this.team = team;
    this.speed = stats.cruise;
    this.velocity = new THREE.Vector3();
    this.forward = new THREE.Vector3(0, 0, -1);
    this.right = new THREE.Vector3(1, 0, 0);
    this.up = new THREE.Vector3(0, 1, 0);
    this.input = { pitch: 0, roll: 0, yaw: 0, throttle: 0, fire: false };
    this.pitchVel = 0; this.rollVel = 0; this.yawVel = 0;
    this.maxHealth = 100; this.health = 100;
    this.alive = true;
    this.gunTimer = 0; this.gunSide = 0;
    this.smokeTimer = 0;
    this.hitFlash = 0;
    // Presentation-only state: none of it feeds back into the flight model, guns or AI.
    this.age = Math.random() * 10; this.flex = 0; this.gear = 0;
    this.lookTarget = null;             // a Vector3 the pilot keeps an eye on
    this.headYaw = 0; this.headPitch = 0;
    this.scorchLevel = 0; this.shedTip = false; this.flashShown = 0;
  }

  reset(pos, quat, speed = this.stats.cruise) {
    this.pos.copy(pos); this.quat.copy(quat);
    this.speed = speed; this.health = this.maxHealth; this.alive = true;
    this.pitchVel = this.rollVel = this.yawVel = 0;
    this.flex = 0; this.gear = speed > GEAR_UP_SPEED ? 0 : 1;
    this.plane.lostTip = -1; this.scorchLevel = 0; this.plane.scorch(0); this.shedTip = false;
    this.updateAxes();
    this.sync();
  }

  /** Writes this aircraft's boxes into the batch, with the visual-only bob, vibration and lean layered on top. */
  sync() {
    const inp = this.input, t = this.age, a = this.plane.angles;
    const vib = Math.sin(t * 97) * 0.0025 * (0.6 + Math.max(0, inp.throttle));
    const pitch = Math.sin(t * 1.7) * 0.012 + this.pitchVel * 0.03 + vib;
    const roll = Math.sin(t * 1.1) * 0.01 + this.rollVel * 0.06 + inp.yaw * 0.12;   // lean into the roll, bank with the rudder
    const yaw = this.yawVel * 0.1;
    vq.setFromAxisAngle(X, pitch).multiply(tq.setFromAxisAngle(NEG_Z, roll)).multiply(tq2.setFromAxisAngle(NEG_Y, yaw));
    vq.premultiply(this.quat);
    vp.copy(this.pos).addScaledVector(this.up, Math.sin(t * 1.3) * 0.15);
    const frac = this.health / this.maxHealth;
    // nearly dead: the gear hangs loose and swings
    const dangle = frac < 0.2 ? 0.45 + Math.sin(t * 5.3) * 0.12 : 0;
    a.flex = this.flex; a.gear = (1 - Math.max(this.gear, dangle)) * GEAR_FOLD;
    a.disc = this.sputter ? 0 : smoothstep(this.speed, 60, 105) * 0.4;
    a.flame = Math.max(0, inp.throttle);
    a.fire = frac < 0.4 ? (0.4 - frac) / 0.4 : 0;
    a.headYaw = this.headYaw; a.headPitch = this.headPitch; a.headRoll = this.rollVel * 0.08;
    this.plane.place(this.matrix.compose(vp, vq, ONE));
  }
  hide() { this.plane.hide(); }

  updateAxes() {
    this.forward.copy(NEG_Z).applyQuaternion(this.quat);
    this.right.copy(X).applyQuaternion(this.quat);
    this.up.copy(Y).applyQuaternion(this.quat);
  }

  update(dt) {
    const s = this.stats, inp = this.input, q = this.quat;
    const k = Math.min(1, dt * 7);
    this.pitchVel += (inp.pitch * s.pitchRate - this.pitchVel) * k;
    this.rollVel += (inp.roll * s.rollRate - this.rollVel) * k;
    this.yawVel += (inp.yaw * s.yawRate - this.yawVel) * k;

    q.multiply(tq.setFromAxisAngle(X, this.pitchVel * dt));
    q.multiply(tq.setFromAxisAngle(NEG_Z, this.rollVel * dt));
    q.multiply(tq.setFromAxisAngle(NEG_Y, this.yawVel * dt));
    this.updateAxes();

    // Banked turn: the more you roll, the harder you turn. Reduced when pointing steeply up/down.
    const level = 1 - Math.abs(this.forward.y);
    q.premultiply(tq.setFromAxisAngle(Y, this.right.y * s.bankTurn * level * dt));
    // Gentle auto-level when the stick is centered so keyboard/tilt players don't drift inverted.
    if (Math.abs(inp.roll) < 0.08 && this.up.y > -0.2) {
      q.multiply(tq.setFromAxisAngle(NEG_Z, this.right.y * s.autoLevel * level * dt));
    }
    q.normalize();
    this.updateAxes();

    const target = inp.throttle >= 0 ? THREE.MathUtils.lerp(s.cruise, s.maxSpeed, inp.throttle) : THREE.MathUtils.lerp(s.cruise, s.minSpeed, -inp.throttle);
    this.speed += (target - this.speed) * Math.min(1, dt * s.accel);
    this.speed += -this.forward.y * 14 * dt; // dive to gain speed, climb to lose it
    this.speed = THREE.MathUtils.clamp(this.speed, s.minSpeed * 0.75, s.maxSpeed * 1.2);
    this.velocity.copy(this.forward).multiplyScalar(this.speed);
    this.pos.addScaledVector(this.velocity, dt);

    const a = this.plane.angles, k2 = Math.min(1, dt * 10);
    const frac = this.health / this.maxHealth;
    // below a quarter the engine coughs: the prop stalls in bursts
    this.sputter = frac < 0.25 && Math.sin(this.age * 6.3) > 0.25;
    a.prop += dt * (this.sputter ? 1.5 : 18 + this.speed * 0.25);
    a.aileron += (inp.roll * 0.6 - a.aileron) * k2;
    a.elevator += (inp.pitch * 0.55 - a.elevator) * k2;
    a.rudder += (-inp.yaw * 0.6 - a.rudder) * k2;
    // wings bend with the g you pull (a little static lift bend at rest); gear tucks up past takeoff speed
    this.age += dt;
    this.flex += (0.03 + this.pitchVel / s.pitchRate * 0.22 - this.flex) * Math.min(1, dt * 6);
    this.gear += ((this.speed > GEAR_UP_SPEED ? 0 : 1) - this.gear) * Math.min(1, dt * 1.6);
    // battle damage: paint scorches in steps, a wingtip goes at half health
    const bucket = Math.min(5, Math.floor((1 - frac) * 5 + 0.001));
    // a hit whitens the airframe for a tenth of a second (the paint is only rewritten when the state changes)
    const flash = this.hitFlash > 0 && this.team === 1 ? 1 : 0;
    if (bucket !== this.scorchLevel || flash !== this.flashShown) { this.scorchLevel = bucket; this.flashShown = flash; this.plane.scorch(bucket / 5, flash * 0.75); }
    if (frac < 0.5 && this.plane.lostTip < 0) { this.plane.lostTip = Math.random() < 0.5 ? 0 : 1; this.shedTip = true; }
    // the pilot: track the target (over the shoulder if it's behind), otherwise idly look around
    let yaw, pitch;
    if (this.lookTarget) {
      const l = this.toLocal(this.lookTarget, tv);
      yaw = THREE.MathUtils.clamp(Math.atan2(l.x, l.z), -1.5, 1.5);
      pitch = THREE.MathUtils.clamp(Math.atan2(l.y, Math.hypot(l.x, l.z)), -0.45, 0.85);
    } else { yaw = Math.sin(this.age * 0.6) * 0.3; pitch = Math.sin(this.age * 0.9) * 0.08; }
    const k3 = Math.min(1, dt * 5);
    this.headYaw += (yaw - this.headYaw) * k3; this.headPitch += (pitch - this.headPitch) * k3;
    this.sync();
    if (this.gunTimer > 0) this.gunTimer -= dt;
    if (this.hitFlash > 0) this.hitFlash -= dt;
  }

  /** Returns world-space muzzle position for the next shot, alternating wings. */
  nextMuzzle(out) {
    const g = GUNS[this.gunSide];
    this.gunSide ^= 1;
    return out.copy(g).applyQuaternion(this.quat).add(this.pos);
  }

  damage(amount) {
    if (!this.alive) return false;
    this.health -= amount;
    this.hitFlash = 0.12;
    if (this.health <= 0) { this.health = 0; this.alive = false; this.hide(); return true; }
    return false;
  }

  /** Local-frame vector to a world point: x right, y up, z forward (positive ahead). */
  toLocal(worldPoint, out) {
    out.copy(worldPoint).sub(this.pos);
    tq.copy(this.quat).invert();
    out.applyQuaternion(tq);
    out.z = -out.z;
    return out;
  }
}
