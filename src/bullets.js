import * as THREE from 'three/webgpu';
import { groundAt, isWaterAt } from './terrain.js';

export const BULLET_SPEED = 340;
const tmpM = new THREE.Matrix4(), tmpP = new THREE.Vector3(), tmpT = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0);
const seg = new THREE.Vector3(), toC = new THREE.Vector3(), closest = new THREE.Vector3();
const TRACER = new THREE.Vector3(0.55, 0.55, 7);
// Each tracer drags a dimmer, longer afterimage just above the bloom threshold: a brief glowing wake.
const WAKE = new THREE.Vector3(0.3, 0.3, 16);
const wakeDir = new THREE.Vector3(), wakePos = new THREE.Vector3(), aimDir = new THREE.Vector3(), bestDir = new THREE.Vector3(), velDir = new THREE.Vector3();

export class BulletPool {
  constructor(glow, max, hex) {
    this.glow = glow;
    this.max = max;
    this.base = glow.alloc(max * 2);          // tracer slots, then one wake slot per tracer
    for (let i = 0; i < max; i++) { glow.color(this.base + i, hex); glow.scalar(this.base + i, 2.6); }
    for (let i = 0; i < max; i++) { glow.color(this.base + max + i, hex); glow.scalar(this.base + max + i, 1.35); }
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.ttl = new Float32Array(max);
    this.owner = new Array(max).fill(null);
    this.damage = new Float32Array(max);
    this.active = new Set();
    this.free = [];
    for (let i = max - 1; i >= 0; i--) this.free.push(i);
  }

  spawn(pos, vel, owner, damage, ttl = 1.5) {
    if (!this.free.length) return;
    const i = this.free.pop();
    this.pos.set([pos.x, pos.y, pos.z], i * 3);
    this.vel.set([vel.x, vel.y, vel.z], i * 3);
    this.ttl[i] = ttl; this.owner[i] = owner; this.damage[i] = damage;
    this.active.add(i);
  }

  kill(i) {
    this.active.delete(i);
    this.free.push(i);
    this.glow.hide(this.base + i);
    this.glow.hide(this.base + this.max + i);
  }

  clear() { for (const i of [...this.active]) this.kill(i); }

  /**
   * @param targets array of Aircraft that bullets from other teams can hit
   * @param onHit (aircraft, point, damage, owner)
   * @param onGround (point, underwater)
   * @param assist optional aim help: { radius, turn, cone, range }. Targets grow by `radius`, and a bullet flying
   *   within `cone` radians of a target's lead point inside `range` bends toward it at `turn` radians per second.
   */
  update(dt, targets, onHit, onGround, assist = null) {
    const P = this.pos, V = this.vel;
    for (const i of this.active) {
      const i3 = i * 3;
      const ox = P[i3], oy = P[i3 + 1], oz = P[i3 + 2];
      let vx = V[i3], vy = V[i3 + 1] - 9 * dt, vz = V[i3 + 2];
      if (assist && assist.turn > 0 && targets.length) {
        // magnetism: pick the target nearest the bullet's line of flight and bend a little toward where it will be
        const owner = this.owner[i];
        const speed = Math.hypot(vx, vy, vz) || 1, range2 = assist.range * assist.range;
        velDir.set(vx / speed, vy / speed, vz / speed);
        tmpT.set(ox, oy, oz);
        let bestCos = Math.cos(assist.cone), found = false;
        for (const t of targets) {
          if (!t.alive || t.team === owner.team) continue;
          const d2 = t.pos.distanceToSquared(tmpT);
          if (d2 > range2) continue;
          aimDir.copy(t.pos).addScaledVector(t.velocity, Math.sqrt(d2) / speed).sub(tmpT).normalize();
          const c = aimDir.dot(velDir);
          if (c > bestCos) { bestCos = c; bestDir.copy(aimDir); found = true; }
        }
        if (found) {
          const ang = Math.acos(Math.min(1, bestCos));
          velDir.lerp(bestDir, Math.min(1, assist.turn * dt / Math.max(ang, 1e-4))).normalize().multiplyScalar(speed);
          vx = velDir.x; vy = velDir.y; vz = velDir.z;
          V[i3] = vx; V[i3 + 2] = vz;
        }
      }
      V[i3 + 1] = vy;
      const nx = ox + vx * dt, ny = oy + vy * dt, nz = oz + vz * dt;
      this.ttl[i] -= dt;
      let dead = this.ttl[i] <= 0;
      if (!dead) {
        const ground = groundAt(nx, nz);
        if (ny < ground + 0.5) { dead = true; onGround(tmpP.set(nx, ground + 0.5, nz), isWaterAt(nx, nz)); }
      }
      if (!dead) {
        const owner = this.owner[i];
        seg.set(nx - ox, ny - oy, nz - oz);
        const segLen2 = seg.lengthSq() || 1e-6;
        for (const t of targets) {
          if (!t.alive || t.team === owner.team) continue;
          toC.copy(t.pos).sub(tmpT.set(ox, oy, oz));
          const u = THREE.MathUtils.clamp(toC.dot(seg) / segLen2, 0, 1);
          closest.set(ox, oy, oz).addScaledVector(seg, u);
          const r = t.stats.radius + (assist ? assist.radius : 0);
          if (closest.distanceToSquared(t.pos) < r * r) {
            onHit(t, closest, this.damage[i], owner);
            dead = true;
            break;
          }
        }
      }
      if (dead) { this.kill(i); continue; }
      P[i3] = nx; P[i3 + 1] = ny; P[i3 + 2] = nz;
      tmpP.set(nx, ny, nz);
      tmpT.set(nx + vx, ny + vy, nz + vz);
      tmpM.lookAt(tmpP, tmpT, UP);
      tmpM.scale(TRACER);
      tmpM.setPosition(tmpP);
      this.glow.matrix(this.base + i, tmpM);
      wakeDir.copy(seg).normalize();
      tmpM.lookAt(tmpP, tmpT, UP);
      tmpM.scale(WAKE);
      tmpM.setPosition(wakePos.copy(tmpP).addScaledVector(wakeDir, -13));
      this.glow.matrix(this.base + this.max + i, tmpM);
    }
  }
}
