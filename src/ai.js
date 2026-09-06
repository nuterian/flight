import * as THREE from 'three/webgpu';
import { groundAt, BOUNDS } from './terrain.js';

const tv = new THREE.Vector3(), aim = new THREE.Vector3(), ahead = new THREE.Vector3(), perch = new THREE.Vector3();
const clamp = THREE.MathUtils.clamp;
const rnd = (a, b) => a + Math.random() * (b - a);

/**
 * A bandit's brain. Bandits hunt in passes rather than sitting on your tail: a pursuit with a patience limit, a
 * close pass, a break-away, then a spell of wandering in which the bandit cruises about the arena without looking
 * for you, before it comes back for another pass. A bandit that has lost you behind it beyond its leash gives up
 * and wanders too. The pack shares a hunting cap (`pack.max`): the rest of a big wave loiters until a slot frees.
 * Skill (0.35..1) lengthens the patience, shortens the wandering and sharpens the reactions, so wave 1 is loose and
 * wave 10 is tight. Measured with `__aiProfile` in dev.js.
 *
 * Three personalities share the machine. The hound is the plain chaser above. The interceptor is fast and turns
 * badly: it climbs to a perch above you and dives through in a slashing pass, then climbs again. The ace is rare:
 * it barrel-rolls when you get on its tail instead of jinking, and after a pass it turns straight back for a
 * second one before it goes off to cruise.
 */
export class EnemyBrain {
  constructor(aircraft, skill, type = 'hound') {
    this.ac = aircraft;
    this.skill = skill;                // 0.35 .. 1
    this.type = type;
    this.passes = 0;                   // the ace's two-pass attack
    this.state = 'pursue';
    this.next = 'pursue';              // where a breakaway, an evade or a return leads afterwards
    this.timer = 0;
    this.engaged = 0;                  // seconds into the current pursuit
    this.tailing = 0;                  // seconds spent sitting close behind you
    this.patience = this.rollPatience();
    this.tailPatience = this.rollTailPatience();
    this.leash = 300 + skill * 220;    // beyond this, a bandit that has lost you behind it gives up for a while
    this.floor = 40 + (1 - skill) * 40; // rookies keep well clear of the ground, so chasing them does not lead you into it
    this.evadeRoll = 1; this.evadePitch = 0.8;
    this.wander = new THREE.Vector3();
    this.wanderTimer = 0;
    this.goal = new THREE.Vector3();   // where a wandering bandit is heading
    this.goalTimer = 0;
    this.checkTimer = rnd(0, 0.5);
    this.fireBurst = 0; this.fireGap = 0;
    this.wantsFire = false;
  }

  rollPatience() { return rnd(4, 7) * (0.7 + this.skill * 0.6) * (this.type === 'interceptor' ? 1.5 : 1); }
  rollTailPatience() { return rnd(2, 3.5) + this.skill * 2; }

  /** Off for a cruise: a few seconds of not hunting, shorter the better the pilot. */
  startWander(player) {
    this.state = 'wander';
    this.timer = rnd(3.5, 6.5) * (1.35 - this.skill * 0.7);
    this.patience = this.rollPatience(); this.tailPatience = this.rollTailPatience();
    this.pickGoal(player);
  }

  /** A loose waypoint on this bandit's side of you, a few hundred units out, at a safe height inside the walls. */
  pickGoal(player) {
    const ac = this.ac, g = this.goal;
    const bearing = Math.atan2(ac.pos.x - player.pos.x, ac.pos.z - player.pos.z) + rnd(-1.2, 1.2), r = rnd(240, 460);
    g.set(player.pos.x + Math.sin(bearing) * r, 0, player.pos.z + Math.cos(bearing) * r);
    const lim = BOUNDS.half - 220;
    g.x = clamp(g.x, -lim, lim); g.z = clamp(g.z, -lim, lim);
    g.y = clamp(player.pos.y + rnd(-50, 70), groundAt(g.x, g.z) + this.floor * 2, BOUNDS.ceiling - 150);
    this.goalTimer = rnd(2.2, 3.6);
  }

  /** Breaks off with a hard rolling pull, then goes on to `next`. */
  breakaway(next) {
    this.state = 'breakaway'; this.next = next; this.timer = rnd(1.4, 2.2);
    this.evadeRoll = Math.random() < 0.5 ? -1 : 1;
  }

  evade(next) {
    if (this.type === 'ace') { this.state = 'barrel'; this.next = next; this.timer = rnd(1.3, 1.8); this.evadeRoll = Math.random() < 0.5 ? -1 : 1; return; }
    this.state = 'evade'; this.next = next; this.timer = rnd(1.2, 2.4);
    this.evadeRoll = Math.random() < 0.5 ? -1 : 1; this.evadePitch = rnd(0.5, 1);
  }

  /** After a close pass: the ace comes straight back once, everyone else goes off to cruise. */
  afterPass() {
    if (this.type === 'ace' && this.passes === 0) { this.passes = 1; return 'pursue'; }
    this.passes = 0;
    return 'wander';
  }

  /** `pack` is shared by the wave: how many bandits are pursuing right now and how many may. */
  update(dt, player, pack) {
    const ac = this.ac, inp = ac.input;
    this.timer -= dt; this.wanderTimer -= dt; this.checkTimer -= dt;
    if (this.wanderTimer <= 0) {
      this.wanderTimer = rnd(0.6, 1.4);
      const w = (1 - this.skill) * 10;   // sloppy flying, but not a target that jinks at random
      this.wander.set(rnd(-w, w), rnd(-w, w), rnd(-w, w));
    }

    // --- emergency overrides: terrain, arena, ceiling
    ahead.copy(ac.pos).addScaledVector(ac.forward, 90);
    const groundHere = groundAt(ac.pos.x, ac.pos.z);
    const groundAhead = Math.max(groundAt(ahead.x, ahead.z), groundAt(ac.pos.x + ac.forward.x * 45, ac.pos.z + ac.forward.z * 45));
    if (ac.pos.y - groundHere < this.floor || ahead.y - groundAhead < this.floor * 0.75) {
      inp.pitch = 1; inp.roll = clamp(ac.right.y * 3, -1, 1); inp.yaw = 0; inp.throttle = 1; this.wantsFire = false;
      return;
    }
    if (ac.pos.y > BOUNDS.ceiling - 80) { inp.pitch = -0.6; inp.roll = clamp(ac.right.y * 2, -1, 1); inp.throttle = 0; this.wantsFire = false; return; }
    const edge = Math.max(Math.abs(ac.pos.x), Math.abs(ac.pos.z));
    if (edge > BOUNDS.half - 120 && this.state !== 'return') { this.state = 'return'; this.timer = 3; }

    let dist = ac.pos.distanceTo(player.pos);
    const toPlayer = ac.toLocal(player.pos, tv);
    const playerBehind = toPlayer.z < 0;
    const threatened = () => playerBehind && dist < 230 && player.forward.dot(tv.copy(ac.pos).sub(player.pos).normalize()) > 0.92;

    // --- state transitions
    if (this.state === 'pursue') {
      this.engaged += dt;
      this.tailing = dist < 130 && toPlayer.z > 0 ? this.tailing + dt : 0;
      if (!player.alive) { this.state = 'patrol'; this.timer = 2; }
      else if (dist < 60 && toPlayer.z > 0) this.breakaway(this.afterPass());                         // the pass: break before a collision
      else if (this.tailing > this.tailPatience) this.breakaway('wander');                            // sat on you long enough
      else if (this.engaged > this.patience) { if (dist < 160) this.breakaway('wander'); else this.startWander(player); }
      else if (dist > this.leash && playerBehind && this.engaged > 1) this.startWander(player);      // lost you: give up for now
      else if (this.checkTimer <= 0) {
        this.checkTimer = 0.45;
        if (pack.hunting > pack.max && this.engaged > 1.5 && dist > 200) { pack.hunting--; this.startWander(player); }   // too many on you: hand over
        else if ((ac.hitFlash > 0 && Math.random() < 0.35 + this.skill * 0.4) || (threatened() && Math.random() < this.skill * this.skill * 0.6)) this.evade('pursue');
      }
    } else if (this.state === 'wander') {
      if (!player.alive) { this.state = 'patrol'; this.timer = 2; }
      else if (this.timer <= 0) {
        if (pack.hunting < pack.max) { this.state = 'pursue'; this.engaged = 0; this.tailing = 0; pack.hunting++; }
        else this.timer = rnd(0.4, 1.0);   // the pack is busy: keep cruising and ask again shortly
      } else if (this.checkTimer <= 0) {
        this.checkTimer = 0.45;
        // a cruising bandit is slow to notice you on its tail, but a bullet wakes it up and it fights back
        if ((ac.hitFlash > 0 && Math.random() < 0.5 + this.skill * 0.4) || (threatened() && Math.random() < this.skill * 0.25)) { this.evade('pursue'); this.engaged = 0; }
      }
    } else if (this.timer <= 0) {
      if (!player.alive) { this.state = 'patrol'; this.timer = 2; }
      else if (this.next === 'wander') this.startWander(player);
      else { this.state = 'pursue'; this.tailing = 0; pack.hunting++; }
    }

    // --- behaviours
    inp.yaw = 0; this.wantsFire = false;
    if (this.state === 'pursue') {
      const above = ac.pos.y - player.pos.y;
      if (this.type === 'interceptor' && above < 70 && dist > 140) {
        // the interceptor climbs to a perch above and beside you, then comes down through you in a slash
        perch.copy(ac.pos).sub(player.pos).setY(0).normalize().multiplyScalar(150).add(player.pos);
        perch.y = Math.min(player.pos.y + 170, BOUNDS.ceiling - 120);
        this.steerTo(perch, 1);
        inp.throttle = 1;
        return;
      }
      // steer toward a lead point so the enemy actually ends up behind you
      aim.copy(player.pos).addScaledVector(player.velocity, dist > 150 ? 0.9 : 0.35).add(this.wander);
      this.steerTo(aim, 1);
      inp.throttle = this.type === 'interceptor' ? 1 : (dist > 260 ? 1 : (dist < 70 ? -0.6 : (player.speed > ac.speed ? 0.5 : 0)));
      // firing: only when the gun solution is good
      const gunAim = aim.copy(player.pos).addScaledVector(player.velocity, dist / 340);
      const l = ac.toLocal(gunAim, tv);
      const off = Math.atan2(Math.hypot(l.x, l.y), l.z);
      if (dist < 420 && off < 0.11 + (1 - this.skill) * 0.05) {
        this.fireGap -= dt;
        if (this.fireBurst > 0) { this.fireBurst -= dt; this.wantsFire = true; }
        else if (this.fireGap <= 0) { this.fireBurst = rnd(0.35, 0.8) * (0.6 + this.skill); this.fireGap = rnd(0.8, 1.8) * (1.6 - this.skill) * (this.skill < 0.5 ? 1.6 : 1); }
      } else { this.fireBurst = 0; }
    } else if (this.state === 'wander') {
      // an easy cruise between loose waypoints: predictable, catchable, and not looking for you
      this.goalTimer -= dt;
      if (this.goalTimer <= 0) this.pickGoal(player);
      aim.copy(this.goal).add(this.wander);
      this.steerTo(aim, 0.45);
      inp.throttle = -0.15;
    } else if (this.state === 'evade') {
      inp.roll = this.evadeRoll; inp.pitch = this.evadePitch; inp.throttle = 1;
    } else if (this.state === 'barrel') {   // the ace's corkscrew: full roll with a little pull, straight through
      inp.roll = this.evadeRoll; inp.pitch = 0.45; inp.throttle = 1;
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
