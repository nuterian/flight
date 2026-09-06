import * as THREE from 'three/webgpu';
import { Aircraft, PLAYER_STATS, ENEMY_STATS } from './aircraft.js';
import { Plane, SCHEMES } from './plane.js';
import { EnemyBrain } from './ai.js';
import { BulletPool, BULLET_SPEED } from './bullets.js';
import { Effects } from './effects.js';
import { Trails } from './trails.js';
import { Sound, store } from './audio.js';
import { groundAt, isWaterAt, kindAt, KIND, BOUNDS } from './terrain.js';
import { Portal } from './portal.js';
import { SUN_DIR } from './world.js';

const tv = new THREE.Vector3(), tv2 = new THREE.Vector3(), tq = new THREE.Quaternion(), spreadV = new THREE.Vector3();
const clamp = THREE.MathUtils.clamp;
const WORLD_UP = new THREE.Vector3(0, 1, 0), NEG_Z = new THREE.Vector3(0, 0, -1);
const rnd = (a, b) => a + Math.random() * (b - a);
const MAX_ENEMIES = 9;

export class Game {
  constructor(scene, camera, input, hud, world, batches) {
    const { lit, glow } = batches;
    this.camera = camera; this.input = input; this.hud = hud; this.world = world;
    this.outsideTimer = 0;
    this.state = 'title';
    this.effects = new Effects(lit, glow, batches.soft);
    this.audio = new Sound();
    this.portal = new Portal(lit, glow);
    this.hitStop = 0; this.outside = false;
    this.killCam = 0; this.killPoint = new THREE.Vector3(); this.killAngle = 0; this.snapCam = false;
    this.skimTimer = 0; this.wasFast = false;
    this.playerBullets = new BulletPool(glow, 260, 0xffe08a);
    this.enemyBullets = new BulletPool(glow, 260, 0xff5a3c);
    this.trails = new Trails(scene, (MAX_ENEMIES + 1) * 2);

    this.player = new Aircraft(new Plane(batches, SCHEMES.player), PLAYER_STATS, 0);
    this.player.trails = [this.trails.ribbon(), this.trails.ribbon()];

    this.enemies = [];
    for (let i = 0; i < MAX_ENEMIES; i++) {
      const ac = new Aircraft(new Plane(batches, SCHEMES.enemies[i % SCHEMES.enemies.length]), { ...ENEMY_STATS }, 1);
      ac.alive = false;
      ac.trails = [this.trails.ribbon(), this.trails.ribbon()];
      this.enemies.push({ ac, brain: new EnemyBrain(ac, 0.5) });
    }

    this.camQuat = new THREE.Quaternion();
    this.camPos = new THREE.Vector3();
    this.deathBack = new THREE.Vector3(0, 0, 1);
    this.camKick = 0;
    this.fov = 62;
    this.best = Number(store.get('skyfight.best') || 0);
    this.hud.text('best', String(this.best));
    this.resetRun();
    this.player.hide();
    this.positionCameraIdle();
  }

  resetRun() {
    this.wave = 0; this.score = 0; this.kills = 0; this.time = 0;
    this.waveClearTimer = 0; this.deathTimer = 0; this.regenDelay = 0; this.outsideTimer = 0; this.hitStop = 0;
    this.combo = 0; this.comboTimer = 0;
    this.killCam = 0; this.wasFast = false; this.hitStop = 0;
    if (this.portal) this.portal.hide();
    if (this.hud) this.hud.resetScore();
    if (this.world) this.world.setDanger(0);
    this.playerBullets.clear(); this.enemyBullets.clear(); this.effects.clear();
    for (const e of this.enemies) { e.ac.alive = false; e.ac.hide(); e.pending = 0; }
  }

  start() {
    this.audio.init();   // we're inside the start gesture, so the context may be created here
    this.resetRun();
    this.player.reset(new THREE.Vector3(0, 190, 700), tq.identity(), PLAYER_STATS.minSpeed);   // slow start so the gear tucks up on the way out
    for (const t of this.player.trails) this.trails.reset(t);
    this.camQuat.copy(this.player.quat);
    this.camPos.copy(this.player.pos).add(tv.set(0, 8, 30));
    this.state = 'playing';
    this.hud.showScreen('hud');
    this.nextWave();
  }

  positionCameraIdle() {
    this.camera.position.set(-260, 170, 520);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(0, 60, 0);
  }

  nextWave() {
    this.wave++;
    const count = Math.min(MAX_ENEMIES, 1 + Math.ceil(this.wave * 0.9));
    const skill = Math.min(1, 0.32 + this.wave * 0.085);
    this.waveSize = count;
    this.hud.banner(`WAVE ${this.wave}`);
    // A portal opens ahead-ish of the player and the bandits fly out of it one after another, head-on.
    const baseAngle = Math.atan2(this.player.forward.x, this.player.forward.z);
    const a = baseAngle + rnd(-0.7, 0.7), r = rnd(600, 800);
    tv.set(this.player.pos.x + Math.sin(a) * r, 0, this.player.pos.z + Math.cos(a) * r);
    const lim = BOUNDS.half - 160;
    tv.x = clamp(tv.x, -lim, lim); tv.z = clamp(tv.z, -lim, lim);
    tv.y = clamp(rnd(200, 320), groundAt(tv.x, tv.z) + 130, 420);
    tv2.copy(this.player.pos).sub(tv).setY(0).normalize();
    tq.setFromUnitVectors(NEG_Z, tv2);
    this.portal.open(tv, tq, 1.4 + count * 0.3 + 2.4);
    this.audio.portalOpen();
    for (const e of this.enemies) { e.pending = 0; e.far = 0; }
    for (let i = 0; i < count; i++) {
      const e = this.enemies[i];
      const ac = e.ac;
      ac.maxHealth = 34 + this.wave * 7; ac.health = ac.maxHealth;
      ac.stats.maxSpeed = ENEMY_STATS.maxSpeed + this.wave * 2;
      ac.stats.cruise = ENEMY_STATS.cruise + this.wave;
      e.brain = new EnemyBrain(ac, skill);
      e.pending = 1.2 + i * 0.3;
    }
  }

  /** Bandits still waiting inside the portal. Derived every time so it can never drift out of sync. */
  get pending() { let n = 0; for (const e of this.enemies) if (e.pending > 0) n++; return n; }

  /** Bandits whose time has come step out of the portal. */
  spawnPending(dt) {
    for (const e of this.enemies) {
      if (e.pending <= 0) continue;
      e.pending -= dt;
      if (e.pending > 0) continue;
      e.pending = 0;
      if (!this.portal.active) this.reopenPortal();
      this.portal.emergePoint(tv);
      e.ac.reset(tv, this.portal.quat);
      for (const t of e.ac.trails) this.trails.reset(t);
      this.effects.spawnFlash(tv, 5, 0.25);
      this.audio.portalPop();
    }
  }

  /** A portal near the player for late arrivals and recalled stragglers. */
  reopenPortal() {
    const p = this.player;
    tv.copy(p.pos).addScaledVector(p.forward, 520).add(tv2.set(0, 40, 0));
    const lim = BOUNDS.half - 160;
    tv.x = clamp(tv.x, -lim, lim); tv.z = clamp(tv.z, -lim, lim);
    tv.y = clamp(tv.y, groundAt(tv.x, tv.z) + 130, 420);
    tv2.copy(p.pos).sub(tv).setY(0).normalize();
    tq.setFromUnitVectors(NEG_Z, tv2);
    this.portal.open(tv, tq, 3.2);
    this.audio.portalOpen();
  }

  /** A bandit that has stayed far from the fight for too long is pulled back through a portal near the player,
   *  so a wave can never hang on one plane the player cannot find. */
  recallStraggler(e) {
    e.ac.alive = false; e.ac.hide();
    for (const t of e.ac.trails) this.trails.reset(t);
    e.far = 0; e.pending = 1.0;
    this.reopenPortal();
  }

  /** Escape hatch: abandon the run and return to the title, whatever state things are in. */
  abort() {
    if (this.state === 'title') return;
    this.resetRun();
    this.player.alive = false; this.player.hide();
    for (const t of this.player.trails) this.trails.reset(t);
    this.hud.warn(null);
    this.hud.showScreen('title');
    this.state = 'title';
    this.positionCameraIdle();
  }

  aliveEnemies() { return this.enemies.filter((e) => e.ac.alive).map((e) => e.ac); }

  fire(ac, pool, damage, spread, rate) {
    if (ac.gunTimer > 0) return;
    ac.gunTimer = 1 / rate;
    const muzzle = ac.nextMuzzle(tv);
    tv2.copy(ac.forward).add(spreadV.set(rnd(-spread, spread), rnd(-spread, spread), rnd(-spread, spread))).normalize().multiplyScalar(BULLET_SPEED).add(ac.velocity);
    pool.spawn(muzzle, tv2, ac, damage);
    this.effects.muzzle(muzzle);
    if (ac === this.player) this.camKick = Math.min(1, this.camKick + 0.35);
    this.audio.gun(ac === this.player ? 0 : ac.pos.distanceTo(this.player.pos));
  }

  killAircraft(ac, size = 1) {
    ac.alive = false; ac.hide(); ac.health = 0;
    for (const t of ac.trails) this.trails.reset(t);
    const c = ac.plane.scheme;
    this.effects.explosion(ac.pos, [c.body, c.accent, c.trim, 0x333333], size);
    this.effects.wreck(ac.pos, ac.velocity, [c.body, c.accent, c.trim]);
    this.shakeAt(ac.pos, 0.3 * size);
    this.audio.explosion(ac.pos.distanceTo(this.player.pos), size);
  }

  nearestEnemy(range) {
    let best = null, bestD = range * range;
    for (const e of this.enemies) {
      if (!e.ac.alive) continue;
      const d = e.ac.pos.distanceToSquared(this.player.pos);
      if (d < bestD) { bestD = d; best = e.ac.pos; }
    }
    return best;
  }

  /** A wingtip shot off at half health tumbles away as a big shard. */
  shedTip(ac) {
    if (!ac.shedTip) return;
    ac.shedTip = false;
    tv.copy(ac.pos).addScaledVector(ac.right, ac.plane.lostTip ? 6.9 : -6.9).addScaledVector(ac.forward, 0.9);
    tv2.copy(ac.velocity).multiplyScalar(0.55).add(spreadV.set(rnd(-6, 6), rnd(2, 8), rnd(-6, 6)));
    this.effects.spawnShard(tv, tv2, ac.plane.scheme.accent, 1.7, 2.6);
    this.effects.hitSpark(tv);
  }

  /** Low passes leave a mark: spray over water, dust over sand, torn fronds off palms, a vapour cone past top speed. */
  nearMiss(p, dt) {
    const ground = groundAt(p.pos.x, p.pos.z), alt = p.pos.y - ground, kind = kindAt(p.pos.x, p.pos.z);
    this.skimTimer -= dt;
    if (alt < 6 && (kind === KIND.SEA || kind === KIND.LAKE || kind === KIND.RIVER)) {
      if (this.skimTimer <= 0) {
        this.skimTimer = 0.03;
        tv.copy(p.pos).addScaledVector(p.forward, -4); tv.y = ground + 1;
        this.effects.spray(tv, p.velocity);
        if (kind === KIND.SEA && Math.random() < 0.2) this.effects.spawnRing(tv, 0, 7);
      }
    } else if (alt < 9 && (kind === KIND.SAND || kind === KIND.WETSAND) && this.skimTimer <= 0) {
      this.skimTimer = 0.05;
      tv.copy(p.pos).addScaledVector(p.forward, -4); tv.y = ground + 1;
      this.effects.dust(tv, p.velocity);
    }
    if (p.pos.y < 40 && this.world.brushPalms) this.world.brushPalms(p.pos, dt, (x, y, z) => this.effects.leaves(tv.set(x, y, z), p.velocity));
    const fast = p.speed > p.stats.maxSpeed * 1.03;
    if (fast && !this.wasFast) { this.effects.cone(p.pos, p.forward); this.audio.boom(); this.camKick = 1; }
    this.wasFast = fast || (this.wasFast && p.speed > p.stats.maxSpeed * 0.97);
  }

  /** A shot-down bandit: quick successive kills chain into a combo that multiplies the score. */
  registerKill(label, base) {
    this.kills++;
    this.combo = this.comboTimer > 0 ? this.combo + 1 : 1;
    this.comboTimer = 2.5;
    const pts = base * this.combo;
    this.addScore(pts);
    this.hud.kill(`${label}  +${pts}`);
    if (this.combo > 1) this.hud.combo(this.combo);
    this.hud.bump('score');
    this.audio.kill(this.combo);
  }

  /** Screen shake that falls off with distance from the player: a close explosion rocks the camera, a far one taps it. */
  shakeAt(pos, base) {
    const near = clamp(1 - pos.distanceTo(this.player.pos) / 240, 0, 1);
    this.effects.shake = Math.max(this.effects.shake, base + near * 0.9);
  }

  /** Fixed-step simulation. Runs at 120 Hz; nothing in here touches the camera or the DOM. */
  update(dt) {
    if (this.state === 'title') { this.effects.update(dt); return; }
    if (this.hitStop > 0) { this.hitStop -= dt; return; }   // a few frames of freeze so a kill lands
    if (this.killCam > 0) {                                  // last kill of the wave: a slow orbit of the wreck
      this.killCam -= dt;
      if (this.killCam <= 0) { this.killCam = 0; this.snapCam = true; }
      dt *= 0.25;
    }
    if (this.state === 'dead') {
      this.deathTimer += dt;                                   // real time
      if (this.deathTimer > 2.6) { this.gameOver(); return; }
      dt *= 0.35;                                              // the world slows down around the wreck
    }
    this.time += dt;
    const p = this.player, inp = this.input, hud = this.hud;

    if (this.state === 'playing') {
      // A non-finite pose would silently break everything downstream (no collision, no camera). Treat it as a crash.
      if (!Number.isFinite(p.pos.x + p.pos.y + p.pos.z + p.quat.x + p.quat.y + p.quat.z + p.quat.w + p.speed)) {
        console.error('Skyfight: player state became non-finite, ending the run');
        p.pos.set(0, 190, 700); p.quat.identity(); p.speed = PLAYER_STATS.cruise; p.updateAxes();
        this.playerDied(false);
        return;
      }
      // ---- player control
      p.input.pitch = inp.pitch; p.input.roll = inp.roll; p.input.yaw = inp.yaw; p.input.throttle = inp.throttle;
      // --- combat zone: an invisible box. Outside it a 10 s countdown drains health, then kills.
      const outside = Math.abs(p.pos.x) > BOUNDS.half || Math.abs(p.pos.z) > BOUNDS.half || p.pos.y > BOUNDS.ceiling;
      let warning = null;
      if (outside) {
        this.outsideTimer += dt;
        const left = Math.max(0, BOUNDS.grace - this.outsideTimer);
        warning = `LEAVING COMBAT ZONE  ${Math.ceil(left)}`;
        this.regenDelay = Math.max(this.regenDelay, 1);
        p.health -= (p.maxHealth / BOUNDS.grace) * dt;
        p.hitFlash = 0.1;
        hud.flash = Math.max(hud.flash, 0.55 + Math.sin(this.time * 8) * 0.25);
        if (left <= 0 || p.health <= 0) { p.health = 0; this.playerDied(false); }
      } else {
        this.outsideTimer = Math.max(0, this.outsideTimer - dt * 2.5);   // countdown recovers quickly once back inside
      }
      this.outside = outside;
      if (this.world) this.world.setDanger(outside ? 1 : Math.min(1, this.outsideTimer / 2));
      const groundUnder = groundAt(p.pos.x, p.pos.z);
      if (!outside && p.pos.y - groundUnder < 22 && p.forward.y < 0) warning = 'PULL UP';
      hud.warn(warning);
      p.lookTarget = this.nearestEnemy(400);
      p.update(dt);
      this.shedTip(p);
      this.nearMiss(p, dt);
      if (inp.fire) this.fire(p, this.playerBullets, 11, 0.012, 13);
      if (p.pos.y < groundAt(p.pos.x, p.pos.z) + 2.2) this.playerDied(isWaterAt(p.pos.x, p.pos.z));
      this.regenDelay -= dt;
      if (this.regenDelay <= 0 && p.health < p.maxHealth) p.health = Math.min(p.maxHealth, p.health + 3 * dt);
    }

    // ---- enemies
    if (this.state === 'playing') this.spawnPending(dt);
    this.portal.update(dt);
    let alive = 0;
    for (const e of this.enemies) {
      const ac = e.ac;
      if (!ac.alive) continue;
      alive++;
      e.brain.update(dt, p);
      ac.lookTarget = p.alive ? p.pos : null;
      ac.update(dt);
      this.shedTip(ac);
      if (!Number.isFinite(ac.pos.x + ac.pos.y + ac.pos.z + ac.quat.w)) { this.recallStraggler(e); continue; }
      if (this.state === 'playing') {
        e.far = ac.pos.distanceToSquared(p.pos) > 1100 * 1100 ? (e.far || 0) + dt : 0;
        if (e.far > 35) { this.recallStraggler(e); continue; }
      }
      if (e.brain.wantsFire && p.alive) this.fire(ac, this.enemyBullets, 4.5 + this.wave * 0.5, 0.02 + (1 - e.brain.skill) * 0.03, 8);
      if (ac.pos.y < groundAt(ac.pos.x, ac.pos.z) + 2) {
        this.killAircraft(ac, 0.8); this.registerKill('BANDIT CRASHED', 40); if (isWaterAt(ac.pos.x, ac.pos.z)) this.effects.splash(ac.pos);
        continue;
      }
      if (p.alive && ac.pos.distanceToSquared(p.pos) < 64) {
        this.killAircraft(ac, 1); this.registerKill('RAMMED', 60);
        this.hurtPlayer(35);
      }
      this.smokeTrail(ac, dt);
    }
    if (p.alive) this.smokeTrail(p, dt);

    // ---- bullets
    const enemiesAlive = this.aliveEnemies();
    this.playerBullets.update(dt, enemiesAlive, (t, point, dmg) => {
      this.effects.hitSpark(point);
      this.audio.hit(t.pos.distanceTo(p.pos));
      if (t.damage(dmg)) {
        this.killAircraft(t, 1); this.registerKill('BANDIT DOWN', 100 * this.wave);
        if (this.pending === 0 && this.aliveEnemies().length === 0) {
          // the wave's last bandit: swing the camera round its explosion in slow motion
          this.killCam = 0.7; this.killPoint.copy(t.pos);
          this.killAngle = Math.atan2(this.camera.position.x - t.pos.x, this.camera.position.z - t.pos.z);
        } else this.hitStop = 0.05;
      }
      else this.addScore(2);
    }, (pt, water) => this.effects.groundHit(pt, water));
    this.enemyBullets.update(dt, p.alive ? [p] : [], (t, point, dmg) => { this.effects.hitSpark(point); this.hurtPlayer(dmg); }, (pt, water) => this.effects.groundHit(pt, water));

    // ---- waves
    if (this.state === 'playing') {
      if (alive === 0 && this.pending === 0) {
        this.waveClearTimer += dt;
        if (this.waveClearTimer > 0.2 && this.waveClearTimer - dt <= 0.2) { this.hud.banner('WAVE CLEAR!', 2200); this.player.health = Math.min(this.player.maxHealth, this.player.health + 30); this.addScore(250 * this.wave); this.audio.waveClear(); }
        if (this.waveClearTimer > 3.2) { this.waveClearTimer = 0; this.nextWave(); }
      }
    }

    if (this.comboTimer > 0) { this.comboTimer -= dt; if (this.comboTimer <= 0) { this.combo = 0; this.hud.comboOff(); } }
    this.trails.update(dt);
    this.effects.update(dt);
    this.aliveCount = alive;
  }

  /** Per displayed frame: camera and HUD. Called once per render, however many sim steps ran. */
  render(dt) {
    if (this.state === 'title') { this.idle(); this.audio.setFlight(0, 0, false, dt); this.audio.setAmbience(0); return; }
    this.updateCamera(dt);
    const alive = this.player.alive && this.state === 'playing';
    this.audio.setFlight(alive ? this.player.speed : 0, alive ? this.player.input.throttle : 0, alive && this.outside, dt);
    if (this.world.nearestFall) this.audio.setAmbience(clamp(1 - this.world.nearestFall(this.camera.position) / 380, 0, 1));
    if (this.state === 'playing') {
      const p = this.player;
      const enemiesAlive = this.aliveEnemies();
      this.hud.updateStats({ score: this.score, wave: this.wave, enemies: (this.aliveCount || 0) + this.pending, total: this.waveSize || 0, health: p.health, maxHealth: p.maxHealth, speed: p.speed, maxSpeed: PLAYER_STATS.maxSpeed * 1.2, boost: p.input.throttle > 0, firing: this.input.fire }, dt);
      const lead = this.computeLead(enemiesAlive);
      this.hud.updateOverlay(this.camera, p, enemiesAlive, lead.point, lead.locked);
    }
  }

  smokeTrail(ac, dt) {
    // Wingtip vapor: strongest while pulling hard, a faint thread while boosting.
    const g = Math.abs(ac.pitchVel) / ac.stats.pitchRate + Math.abs(ac.rollVel) / ac.stats.rollRate * 0.5;
    const intensity = Math.max(clamp((g - 0.45) / 0.45, 0, 1), ac.input.throttle > 0 ? 0.3 : 0);
    tv.copy(ac.pos).addScaledVector(ac.right, 7.9).addScaledVector(ac.forward, -0.9);
    this.trails.push(ac.trails[0], dt, tv, ac.up, intensity);
    tv.copy(ac.pos).addScaledVector(ac.right, -7.9).addScaledVector(ac.forward, -0.9);
    this.trails.push(ac.trails[1], dt, tv, ac.up, intensity);
    const frac = ac.health / ac.maxHealth;
    if (frac > 0.5) return;
    ac.smokeTimer -= dt;
    if (ac.smokeTimer <= 0) {
      ac.smokeTimer = frac < 0.25 ? 0.05 : 0.11;
      tv.copy(ac.pos).addScaledVector(ac.forward, -4.5);
      this.effects.trailSmoke(tv, ac.velocity, frac < 0.25);
    }
  }

  hurtPlayer(dmg) {
    const p = this.player;
    if (!p.alive) return;
    this.regenDelay = 4;
    this.hud.damage(dmg / 25);
    this.hud.hit();
    this.audio.hit(0);
    this.effects.shake = Math.max(this.effects.shake, 0.5);
    if (p.damage(dmg)) this.playerDied(false);
  }

  playerDied(water) {
    const p = this.player;
    if (this.state !== 'playing') return;
    p.alive = false; p.hide(); p.health = 0;
    for (const t of p.trails) this.trails.reset(t);
    this.effects.explosion(p.pos, [p.plane.scheme.body, p.plane.scheme.accent, 0x333333], 1.4);
    this.effects.wreck(p.pos, p.velocity, [p.plane.scheme.body, p.plane.scheme.accent, p.plane.scheme.trim]);
    if (water) this.effects.splash(p.pos);
    this.effects.shake = 1.2;
    this.audio.explosion(0, 1.6);
    this.hud.damage(1);
    this.hud.warn(null);
    this.state = 'dead';
    this.deathTimer = 0;
    this.deathPoint = p.pos.clone();
    this.deathBack.copy(this.camera.position).sub(p.pos).setY(0).normalize();
    this.camera.position.addScaledVector(p.forward, -30).add(tv.set(0, 12, 0));
  }

  gameOver() {
    this.state = 'gameover';
    const isBest = this.score > this.best;
    if (isBest) { this.best = this.score; store.set('skyfight.best', String(this.best)); this.hud.text('best', String(this.best)); }
    this.hud.showGameOver(this.score, this.wave, this.kills, isBest);
  }

  addScore(n) { this.score += n; }

  computeLead(enemies) {
    const p = this.player;
    let best = null, bestD = 620;
    for (const e of enemies) {
      const d = e.pos.distanceTo(p.pos);
      if (d < bestD && p.forward.dot(tv.copy(e.pos).sub(p.pos).normalize()) > 0.6) { best = e; bestD = d; }
    }
    if (!best) return { point: null, locked: false };
    // Solve the intercept: aim = E + (Ve - Vp) * t, t = |aim - P| / bulletSpeed, two fixed-point iterations.
    const rel = tv2.copy(best.velocity).sub(p.velocity);
    let t = bestD / BULLET_SPEED;
    for (let i = 0; i < 3; i++) { tv.copy(best.pos).addScaledVector(rel, t); t = tv.distanceTo(p.pos) / BULLET_SPEED; }
    const point = tv.copy(best.pos).addScaledVector(rel, t).clone();
    const locked = p.forward.angleTo(tv2.copy(point).sub(p.pos)) < 0.035;
    return { point, locked };
  }

  updateCamera(dt) {
    const cam = this.camera, p = this.player, fx = this.effects;
    if (this.state === 'dead' || this.state === 'gameover') {
      // Dramatic pull-out: the camera dollies back and up from the wreck while the lens tightens (a dolly zoom),
      // drifting slowly around it.
      const t = this.deathTimer, u = clamp(t / 2.6, 0, 1), ease = 1 - Math.pow(1 - u, 3);
      tv2.copy(this.deathBack).applyAxisAngle(WORLD_UP, t * 0.12);
      tv.copy(this.deathPoint).addScaledVector(tv2, 18 + 110 * ease);
      tv.y += 10 + 22 * ease;
      tv.y = Math.max(tv.y, groundAt(tv.x, tv.z) + 6);
      cam.position.lerp(tv, 1 - Math.exp(-dt * 3));
      cam.up.lerp(tv2.set(0, 1, 0), 1 - Math.exp(-dt * 2)).normalize();
      cam.lookAt(this.deathPoint);
      this.fov += (38 - this.fov) * Math.min(1, dt * 1.1);
      cam.fov = this.fov; cam.updateProjectionMatrix();
      return;
    }
    if (this.killCam > 0) {
      const u = 1 - this.killCam / 0.7, ang = this.killAngle + u * 1.7;
      tv.set(Math.sin(ang) * 34, 12 + u * 12, Math.cos(ang) * 34).add(this.killPoint);
      tv.y = Math.max(tv.y, groundAt(tv.x, tv.z) + 4);
      cam.position.lerp(tv, 1 - Math.exp(-dt * 7));
      cam.up.copy(WORLD_UP);
      cam.lookAt(this.killPoint);
      this.fov += (48 - this.fov) * Math.min(1, dt * 4);
      cam.fov = this.fov; cam.updateProjectionMatrix();
      return;
    }
    if (this.snapCam) {   // back from the kill cam: no long lerp, just cut to the chase view
      this.snapCam = false;
      this.camQuat.copy(p.quat);
      this.camPos.set(0, 6.5, 25).applyQuaternion(this.camQuat).add(p.pos);
      this.fov = 62;
    }
    // The camera follows the nose more slowly through a hard roll and slides to the outside of the turn.
    const turn = clamp(Math.abs(p.rollVel) / p.stats.rollRate, 0, 1);
    this.camQuat.slerp(p.quat, 1 - Math.exp(-dt * (5 - 2.2 * turn)));
    const boost = p.input.throttle > 0 ? 1 : 0;
    this.camKick *= Math.exp(-dt * 14);
    tv.set(-p.rollVel * 0.9, 6.5, 25 + boost * 3 + this.camKick * 0.6).applyQuaternion(this.camQuat).add(p.pos);
    this.camPos.lerp(tv, 1 - Math.exp(-dt * 18));
    cam.position.copy(this.camPos);
    if (fx.shake > 0) cam.position.add(tv2.set(rnd(-1, 1), rnd(-1, 1), rnd(-1, 1)).multiplyScalar(fx.shake * 1.4));
    const minY = groundAt(cam.position.x, cam.position.z) + 3;
    if (cam.position.y < minY) cam.position.y = minY;
    cam.up.copy(tv2.set(0, 1, 0).applyQuaternion(this.camQuat)).lerp(WORLD_UP, 0.45).normalize();
    tv.copy(p.pos).addScaledVector(p.forward, 38).addScaledVector(p.up, 2);
    cam.lookAt(tv);
    if (fx.shake > 0) cam.rotateZ(rnd(-1, 1) * fx.shake * 0.02);
    const targetFov = 62 + boost * 9 + Math.max(0, p.speed - PLAYER_STATS.cruise) * 0.08 + this.camKick * 1.5;
    this.fov += (targetFov - this.fov) * Math.min(1, dt * 3);
    cam.fov = this.fov; cam.updateProjectionMatrix();
  }

  idle() {
    // Title screen: the camera stays on the sun's side of the word, swinging gently about the sun's azimuth so the
    // faces it sees are the lit ones, and looks up at the letters against the sky.
    const t = performance.now() * 0.00005;
    const a = Math.atan2(SUN_DIR.x, SUN_DIR.z) + Math.sin(t * 1.7) * 0.42;
    this.camera.position.set(Math.sin(a) * 400, 120 + Math.sin(t * 2.3) * 14, Math.cos(a) * 400);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(Math.sin(t * 0.7) * 20, 236 + Math.sin(t * 1.3) * 6, Math.cos(t * 0.9) * 20);
    this.fov = 62; this.camera.fov = 62; this.camera.updateProjectionMatrix();
  }
}
