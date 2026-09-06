import * as THREE from 'three/webgpu';
import { groundAt, BOUNDS } from './terrain.js';

const tv = new THREE.Vector3(), aim = new THREE.Vector3(), ahead = new THREE.Vector3();
const clamp = THREE.MathUtils.clamp;
const rnd = (a, b) => a + Math.random() * (b - a);

export class EnemyBrain {
  constructor(aircraft, skill) {
    this.ac = aircraft;
    this.skill = skill;                // 0.35 .. 1
    this.state = 'pursue';
    this.timer = 0;
    this.evadeRoll = 1; this.evadePitch = 0.8;
    this.wander = new THREE.Vector3();
    this.wanderTimer = 0;
    this.checkTimer = rnd(0, 0.5);
    this.fireBurst = 0; this.fireGap = 0;
    this.wantsFire = false;
  }

  update(dt, player) {
    const ac = this.ac, inp = ac.input;
    this.timer -= dt; this.wanderTimer -= dt; this.checkTimer -= dt;
    if (this.wanderTimer <= 0) {
      this.wanderTimer = rnd(0.6, 1.4);
      const w = (1 - this.skill) * 28;
      this.wander.set(rnd(-w, w), rnd(-w, w), rnd(-w, w));
    }

    // --- emergency overrides: terrain, arena, ceiling
    ahead.copy(ac.pos).addScaledVector(ac.forward, 90);
    const groundHere = groundAt(ac.pos.x, ac.pos.z);
    const groundAhead = Math.max(groundAt(ahead.x, ahead.z), groundAt(ac.pos.x + ac.forward.x * 45, ac.pos.z + ac.forward.z * 45));
    if (ac.pos.y - groundHere < 40 || ahead.y - groundAhead < 30) {
      inp.pitch = 1; inp.roll = clamp(ac.right.y * 3, -1, 1); inp.yaw = 0; inp.throttle = 1; this.wantsFire = false;
      return;
    }
    if (ac.pos.y > BOUNDS.ceiling - 80) { inp.pitch = -0.6; inp.roll = clamp(ac.right.y * 2, -1, 1); inp.throttle = 0; this.wantsFire = false; return; }
    const edge = Math.max(Math.abs(ac.pos.x), Math.abs(ac.pos.z));
    if (edge > BOUNDS.half - 120 && this.state !== 'return') { this.state = 'return'; this.timer = 3; }

    let dist = ac.pos.distanceTo(player.pos);
    const toPlayer = ac.toLocal(player.pos, tv);
    const playerBehind = toPlayer.z < 0;

    // --- state transitions
    if (this.state === 'pursue') {
      if (!player.alive) { this.state = 'patrol'; this.timer = 2; }
      else if (dist < 42 && toPlayer.z > 0) { this.state = 'breakaway'; this.timer = rnd(1.4, 2.2); this.evadeRoll = Math.random() < 0.5 ? -1 : 1; }
      else if (this.checkTimer <= 0) {
        this.checkTimer = 0.45;
        const threatened = playerBehind && dist < 230 && player.forward.dot(tv.copy(ac.pos).sub(player.pos).normalize()) > 0.92;
        if ((ac.hitFlash > 0 && Math.random() < 0.35 + this.skill * 0.4) || (threatened && Math.random() < this.skill * 0.6)) {
          this.state = 'evade'; this.timer = rnd(1.2, 2.4);
          this.evadeRoll = Math.random() < 0.5 ? -1 : 1; this.evadePitch = rnd(0.5, 1);
        }
      }
    } else if (this.timer <= 0) {
      this.state = player.alive ? 'pursue' : 'patrol';
    }

    // --- behaviours
    inp.yaw = 0; this.wantsFire = false;
    if (this.state === 'pursue') {
      // steer toward a lead point so the enemy actually ends up behind you
      aim.copy(player.pos).addScaledVector(player.velocity, dist > 150 ? 0.9 : 0.35).add(this.wander);
      this.steerTo(aim, 1);
      inp.throttle = dist > 260 ? 1 : (dist < 70 ? -0.6 : (player.speed > ac.speed ? 0.5 : 0));
      // firing: only when the gun solution is good
      const gunAim = aim.copy(player.pos).addScaledVector(player.velocity, dist / 340);
      const l = ac.toLocal(gunAim, tv);
      const off = Math.atan2(Math.hypot(l.x, l.y), l.z);
      if (dist < 420 && off < 0.11 + (1 - this.skill) * 0.05) {
        this.fireGap -= dt;
        if (this.fireBurst > 0) { this.fireBurst -= dt; this.wantsFire = true; }
        else if (this.fireGap <= 0) { this.fireBurst = rnd(0.35, 0.8) * (0.6 + this.skill); this.fireGap = rnd(0.8, 1.8) * (1.6 - this.skill); }
      } else { this.fireBurst = 0; }
    } else if (this.state === 'evade') {
      inp.roll = this.evadeRoll; inp.pitch = this.evadePitch; inp.throttle = 1;
    } else if (this.state === 'breakaway') {
      inp.roll = this.evadeRoll * 0.9; inp.pitch = 0.75; inp.throttle = 1;
    } else if (this.state === 'return') {
      aim.set(0, 220, 0);
      this.steerTo(aim, 0.8);
      inp.throttle = 0.5;
    } else { // patrol: lazy circle
      aim.set(Math.cos(performance.now() * 0.0003) * 500, 200, Math.sin(performance.now() * 0.0003) * 500);
      this.steerTo(aim, 0.5);
      inp.throttle = 0;
    }
  }

  steerTo(target, gain) {
    const ac = this.ac, inp = ac.input;
    const l = ac.toLocal(target, tv);
    const dist = l.length() || 1;
    const off = Math.atan2(Math.hypot(l.x, l.y), l.z); // 0 ahead .. pi behind
    const around = Math.atan2(l.x, l.y);               // 0 above, +right, ±pi below
    const agility = (0.55 + this.skill * 0.5) * gain;
    if (off < 0.15) {
      inp.roll = clamp(l.x / dist * 7, -1, 1) * agility;
      inp.pitch = clamp(l.y / dist * 7, -1, 1) * agility;
    } else {
      inp.roll = clamp(around * 1.7, -1, 1) * agility;
      const pull = clamp(off * 1.6, 0, 1);
      inp.pitch = pull * Math.max(-0.5, Math.cos(around)) * agility;
      if (Math.abs(around) > 2.6) inp.pitch = 0.2; // target straight below: roll first, then pull
    }
    inp.yaw = clamp(l.x / dist * 2, -1, 1) * agility;
  }
}
