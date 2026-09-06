import * as THREE from 'three/webgpu';
import { groundAt, isWaterAt } from './terrain.js';

export const BULLET_SPEED = 340;
const tmpM = new THREE.Matrix4(), tmpP = new THREE.Vector3(), tmpT = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0);
const seg = new THREE.Vector3(), toC = new THREE.Vector3(), closest = new THREE.Vector3();
const TRACER = new THREE.Vector3(0.55, 0.55, 7);
// Each tracer drags a dimmer, longer afterimage just above the bloom threshold: a brief glowing wake.
const WAKE = new THREE.Vector3(0.3, 0.3, 16);
const wakeDir = new THREE.Vector3(), wakePos = new THREE.Vector3();

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
   */
  update(dt, targets, onHit, onGround) {
    const P = this.pos, V = this.vel;
    for (const i of this.active) {
      const i3 = i * 3;
      const ox = P[i3], oy = P[i3 + 1], oz = P[i3 + 2];
      const vx = V[i3], vy = V[i3 + 1] - 9 * dt, vz = V[i3 + 2];
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
          if (closest.distanceToSquared(t.pos) < t.stats.radius * t.stats.radius) {
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
