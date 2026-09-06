import * as THREE from 'three/webgpu';
import { Aircraft, PLAYER_STATS, ENEMY_STATS } from './aircraft.js';
import { Plane, SCHEMES } from './plane.js';
import { Airship } from './airship.js';
import { EnemyBrain } from './ai.js';
import { BulletPool, BULLET_SPEED } from './bullets.js';
import { Effects } from './effects.js';
import { Trails } from './trails.js';
import { Sound, store } from './audio.js';
import { groundAt, isWaterAt, kindAt, KIND, BOUNDS } from './terrain.js';
import { Portal } from './portal.js';
import { SUN_DIR } from './world.js';
import { Medals, MEDALS, byId } from './medals.js';
import { todayKey, todayLabel, dailySeed, mulberry32, loadDailyBest, saveDailyBest, shareLine, dayNumber } from './daily.js';

const tv = new THREE.Vector3(), tv2 = new THREE.Vector3(), tq = new THREE.Quaternion(), spreadV = new THREE.Vector3();
const fbPos = new THREE.Vector3(), fbRel = new THREE.Vector3(), fbLocal = new THREE.Vector3();   // the fly-by pass's own temporaries
const clamp = THREE.MathUtils.clamp;
const WORLD_UP = new THREE.Vector3(0, 1, 0), NEG_Z = new THREE.Vector3(0, 0, -1), STILL = new THREE.Vector3();
const SOUND_OF_SPEED = 340;   // what the Doppler shift of a passing engine is measured against, in units per second
// where the ground is felt from: under the plane, off each wingtip, and ahead where a cliff would be
const RUSH_TAPS = [[0, 0], [0, 12], [0, -12], [26, 0], [30, 14], [30, -14]];
const rnd = (a, b) => a + Math.random() * (b - a);
const MAX_ENEMIES = 9;
const TWO_PI = Math.PI * 2;
const TYPE_LABEL = { hound: 'BANDIT DOWN', interceptor: 'INTERCEPTOR DOWN', ace: 'ACE DOWN' };
const TYPE_SCORE = { hound: 100, interceptor: 140, ace: 300 };
const BOSS_EVERY = 5;

export class Game {
  constructor(scene, camera, input, hud, world, batches) {
    const { lit, glow } = batches;
    this.camera = camera; this.input = input; this.hud = hud; this.world = world;
    this.outsideTimer = 0;
    this.state = 'title';
    this.effects = new Effects(lit, glow, batches.soft);
    this.audio = new Sound();
    this.portal = new Portal(lit, glow);
    this.targetList = [];   // everything the player's guns and HUD can see this step: bandits and the airship's hulls
    this.hitStop = 0; this.outside = false;
    this.killCam = 0; this.killPoint = new THREE.Vector3(); this.killAngle = 0; this.snapCam = false;
    this.skimTimer = 0; this.wasFast = false;
    this.playerBullets = new BulletPool(glow, 260, 0xffe08a);
    this.enemyBullets = new BulletPool(glow, 260, 0xff5a3c);
    this.trails = new Trails(scene, (MAX_ENEMIES + 1) * 2);
    // contrails: up in the cold air above 360 the player's wingtips draw long white lines that hang for a while
    this.contrails = new Trails(scene, 2, 140, 0.45, { fade: 0.05, opacity: 0.42, sample: 0.09, widen: true, renderOrder: 5 });

    this.flybys = Array.from({ length: MAX_ENEMIES }, () => ({ id: null, dist: 0, side: 0, doppler: 1, speed: 0 }));   // reused per frame
    this.pack = { hunting: 0, max: 1 };   // how many bandits are hunting the player right now, and how many may
    this.assist = { radius: 0, turn: 0, cone: 0.08, range: 380 };   // aim help for the player's guns, generous early
    this.arenaOrder = []; this.arena = null;                          // where this wave's portal opened
    this.found = new Set();                                           // landmarks found this run
    this.medals = new Medals();
    this.daily = false; this.rng = Math.random;   // the daily flight swaps in a seeded generator for the run's layout
    this.player = new Aircraft(new Plane(batches, SCHEMES.player), PLAYER_STATS, 0);
    this.player.trails = [this.trails.ribbon(), this.trails.ribbon()];

    this.airship = new Airship(lit, glow, this.effects);
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
    this.alpha = 1;   // how far the frame sits between the last two sim steps (set by the loop)
    this.best = Number(store.get('skyfight.best') || 0);
    this.bestWave = Number(store.get('skyfight.bestwave') || 0);
    this.hud.text('best', String(this.best));
    this.hud.text('bestwave', this.bestWave ? ` · wave ${this.bestWave}` : '');
    this.hud.medals(this.medals);
    this.hud.daily(todayLabel(), loadDailyBest());
    this.resetRun();
    this.player.hide();
    this.positionCameraIdle();
  }

  resetRun() {
    this.wave = 0; this.score = 0; this.kills = 0; this.time = 0;
    this.waveClearTimer = 0; this.deathTimer = 0; this.regenDelay = 0; this.outsideTimer = 0; this.hitStop = 0;
    this.combo = 0; this.comboTimer = 0;
    this.killCam = 0; this.wasFast = false; this.hitStop = 0;
    // the debrief's numbers and the medal checks
    this.shots = 0; this.hits = 0; this.bestCombo = 0; this.streak = 0; this.bestStreak = 0; this.aloft = 0;
    this.waveShots = 0; this.waveHits = 0; this.loopAcc = 0; this.loopT = 0; this.loopUp = false; this.loopDown = false;
    this.runMedals = []; this.newMedals = []; this.log = []; this.cushioned = 0; this.turretDamage = 0;
    this.found = new Set(); this.arenaOrder = []; this.arena = null;
    if (this.portal) this.portal.hide();
    if (this.airship) this.airship.hide();
    if (this.hud) this.hud.resetScore();
    this.world.setDanger(0);
    this.playerBullets.clear(); this.enemyBullets.clear(); this.effects.clear();
    for (const e of this.enemies) { e.ac.alive = false; e.ac.hide(); e.pending = 0; }
  }

  /** `mode` is 'free' (as it always was) or 'daily': today's seeded run. */
  start(mode = 'free') {
    this.audio.init();   // we're inside the start gesture, so the context may be created here
    this.resetRun();
    this.daily = mode === 'daily';
    this.rng = this.daily ? mulberry32(dailySeed(todayKey())) : Math.random;
    // the light for this run: the day picks its own, free play draws one
    this.world.setTimeOfDay(['morning', 'noon', 'golden'][Math.floor(this.rng() * 3)]);
    if (this.daily) {
      // the day decides where you begin: somewhere on a ring around the isles, pointed roughly at them
      const a = this.rng() * TWO_PI, r = 650 + this.rng() * 250;
      tv.set(Math.sin(a) * r, 190 + this.rng() * 70, Math.cos(a) * r);
      tq.setFromAxisAngle(WORLD_UP, Math.atan2(tv.x, tv.z) + (this.rng() - 0.5) * 0.8);
      this.player.reset(tv, tq, PLAYER_STATS.minSpeed);
    } else this.player.reset(new THREE.Vector3(0, 190, 700), tq.identity(), PLAYER_STATS.minSpeed);   // slow start so the gear tucks up on the way out
    for (const t of this.player.trails) this.trails.reset(t);
    this.contrails.reset(0); this.contrails.reset(1);
    this.camQuat.copy(this.player.quat);
    this.camPos.copy(this.player.pos).add(tv.set(0, 8, 30));
    this.state = 'playing';
    this.hud.showScreen('hud');
    this.nextWave();
    if (this.daily) this.hud.kill(`TODAY'S FLIGHT · ${todayLabel()}`);
  }

  /** The run's random number in [a, b): seeded on the daily flight, Math.random otherwise. */
  r(a, b) { return a + this.rng() * (b - a); }

  positionCameraIdle() {
    this.camera.position.set(-260, 170, 520);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(0, 60, 0);
  }

  nextWave() {
    this.wave++;
    let count = Math.min(MAX_ENEMIES, 1 + Math.ceil(this.wave * 0.9));
    let skill = Math.min(1, 0.32 + this.wave * 0.085);
    if (this.daily) {   // the day's composition: an extra bandit on some waves, a touch more or less skill
      if (this.wave > 1 && this.rng() < 0.35) count = Math.min(MAX_ENEMIES, count + 1);
      skill = Math.min(1, skill + (this.rng() - 0.5) * 0.08);
    }
    const boss = this.wave % BOSS_EVERY === 0;
    if (boss) count = 2;   // the airship and a pair of escorts
    // Who comes: hounds on the first waves, interceptors join at wave 3 (about half the pack), and from wave 6 an
    // ace turns up on some waves, never more than one.
    const types = [];
    for (let i = 0; i < count; i++) {
      if (!boss && this.wave >= 6 && i === count - 1 && (this.wave % 2 === 0 || this.rng() < 0.5)) types.push('ace');
      else if (!boss && this.wave >= 3 && i % 2 === 1) types.push('interceptor');
      else types.push('hound');
    }
    this.waveSize = count + (boss ? 1 : 0);
    this.waveShots = 0; this.waveHits = 0; this.waveDamage = 0; this.waveKills = 0;
    this.note('wave', this.wave);
    // The learning curve: the first waves are target practice. Bandits are light and slow, do not shoot back on
    // wave 1, and the guns help: targets are fatter and bullets bend toward a bandit near their line of flight.
    // All of it fades out by wave 7, after which it is your aim alone.
    const learn = this.learn = clamp(1 - (this.wave - 1) / 6, 0, 1);
    this.assist.radius = 1 + 3 * learn; this.assist.turn = 0.25 + 0.75 * learn;
    for (const m of MEDALS) if (m.wave && this.wave >= m.wave) this.earn(m.id);
    // Only part of the pack hunts you at once (1 on the first waves, one more every three); the rest cruise about
    // until a slot frees, so there is always a bandit showing you its tail and never a whole wave on yours.
    this.pack.max = Math.min(count, 1 + Math.floor(this.wave / 3));
    this.hud.banner(`WAVE ${this.wave}`);
    // The portal opens over this wave's arena: a different part of the map each wave, drawn from a shuffled
    // order so no two waves in a row share one. If the arena is far, the portal opens on the way there and the
    // bandits' cruising drifts the fight over to it. The bandits fly out of it one after another, head-on.
    const arena = this.arena = this.nextArena();
    const p = this.player;
    if (arena) {
      tv.set(arena.x - p.pos.x, 0, arena.z - p.pos.z);
      const far = tv.length();
      if (far > 900) tv.multiplyScalar(900 / far);
      tv.x += p.pos.x + this.r(-60, 60); tv.z += p.pos.z + this.r(-60, 60);
      if (far < 250) { const a = Math.atan2(p.forward.x, p.forward.z) + this.r(-0.7, 0.7); tv.set(p.pos.x + Math.sin(a) * 600, 0, p.pos.z + Math.cos(a) * 600); }
      this.hud.kill(`PORTAL OVER ${arena.name}`);
    } else {
      const baseAngle = Math.atan2(p.forward.x, p.forward.z);
      const a = baseAngle + this.r(-0.7, 0.7), r = this.r(600, 800);
      tv.set(p.pos.x + Math.sin(a) * r, 0, p.pos.z + Math.cos(a) * r);
    }
    const lim = BOUNDS.half - 160;
    tv.x = clamp(tv.x, -lim, lim); tv.z = clamp(tv.z, -lim, lim);
    tv.y = clamp(this.r(200, 320), groundAt(tv.x, tv.z) + 130, 420);
    tv2.copy(this.player.pos).sub(tv).setY(0).normalize();
    tq.setFromUnitVectors(NEG_Z, tv2);
    this.portal.open(tv, tq, 1.4 + count * 0.3 + 2.4);
    this.audio.portalOpen();
    for (const e of this.enemies) { e.pending = 0; e.far = 0; }
    for (let i = 0; i < count; i++) {
      const e = this.enemies[i];
      const ac = e.ac, type = types[i];
      e.type = type;
      const hp = 24 + this.wave * 6;   // 3 hits on wave 1, 6 by wave 6, 8 by wave 10
      ac.maxHealth = Math.round(type === 'ace' ? hp * 1.6 : type === 'interceptor' ? hp * 0.85 : hp); ac.health = ac.maxHealth;
      ac.stats.maxSpeed = ENEMY_STATS.maxSpeed - 12 + this.wave * 3;
      ac.stats.cruise = ENEMY_STATS.cruise - 8 + this.wave * 2;
      ac.stats.pitchRate = ENEMY_STATS.pitchRate; ac.stats.rollRate = ENEMY_STATS.rollRate; ac.stats.bankTurn = ENEMY_STATS.bankTurn;
      let scheme = SCHEMES.enemies[i % SCHEMES.enemies.length], sk = skill;
      if (type === 'interceptor') {   // fast and straight: more speed, much less turn
        ac.stats.maxSpeed += 22; ac.stats.cruise += 10; ac.stats.pitchRate *= 0.72; ac.stats.rollRate *= 0.8; ac.stats.bankTurn *= 0.85;
        scheme = SCHEMES.interceptors[i % SCHEMES.interceptors.length];
      } else if (type === 'ace') {    // the best pilot in the sky, in black
        ac.stats.maxSpeed += 10; ac.stats.pitchRate *= 1.15; ac.stats.rollRate *= 1.2; sk = Math.min(1, skill + 0.25);
        scheme = SCHEMES.ace;
      }
      ac.plane.setVariant(type, scheme);
      e.brain = new EnemyBrain(ac, sk, type);
      e.brain.arena = arena;
      e.pending = 1.2 + i * 0.3;
    }
    if (boss) {
      // the airship drifts in from far out on the portal's side, straight at you, slow enough to catch
      const from = tv2.set(tv.x, 0, tv.z).sub(this.player.pos).setY(0).normalize().multiplyScalar(1000).add(this.player.pos);
      const lim = BOUNDS.half - 400;
      from.x = clamp(from.x, -lim, lim); from.z = clamp(from.z, -lim, lim);
      this.airship.spawn(from, this.player.pos, clamp(this.player.pos.y + 60, 260, 440), 140 + this.wave * 12);   // 18 gondola hits on wave 5, 24 on wave 10
      this.hud.kill('AIRSHIP · HIT THE GONDOLA');
    }
  }

  /** The next arena in this run's shuffled order (reshuffled when it runs out, never repeating the last one). */
  nextArena() {
    const arenas = this.world.arenas || [];
    if (!arenas.length) return null;
    if (!this.arenaOrder.length) {
      const order = arenas.map((_, i) => i);
      for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(this.rng() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
      if (this.arena && arenas[order[0]] === this.arena && order.length > 1) order.push(order.shift());
      this.arenaOrder = order;
    }
    return arenas[this.arenaOrder.shift()];
  }

  /** A landmark found: a bonus once a run, a medal the first time, and a line in the feed every time. */
  foundLandmark(l) {
    this.found.add(l.id);
    this.addScore(500);
    this.hud.kill(`${l.name} FOUND  +500`);
    this.hud.popup(l.pos, '+500', true);
    this.hud.bump('score');
    this.audio.kill(2);
    this.earn(l.id);
  }

  /** The airship's turrets shoot through the bandits' pool. */
  turretFire(muzzle, dir, k) {
    tv2.copy(dir).add(spreadV.set(rnd(-0.06, 0.06), rnd(-0.06, 0.06), rnd(-0.06, 0.06))).normalize().multiplyScalar(BULLET_SPEED * 0.85);
    this.enemyBullets.spawn(muzzle, tv2, this.airship, 2 + this.wave * 0.3);
    this.effects.muzzle(muzzle);
    this.audio.gun(muzzle.distanceTo(this.player.pos));
  }

  /** The airship is down: the escorts break off through the portal and the wave is over. */
  airshipDown() {
    this.registerKill('AIRSHIP DOWN', 300 * this.wave, this.airship.pos);
    this.world.scare(this.airship.pos, 400);
    this.shakeAt(this.airship.pos, 1.2);
    this.audio.explosion(this.airship.pos.distanceTo(this.player.pos), 2.4);
    this.killCam = 1.4; this.killPoint.copy(this.airship.pos);
    this.killAngle = Math.atan2(this.camera.position.x - this.airship.pos.x, this.camera.position.z - this.airship.pos.z);
    let fled = 0;
    for (const e of this.enemies) { if (!e.ac.alive) continue; this.effects.spawnFlash(e.ac.pos, 5, 0.25); e.ac.alive = false; e.ac.hide(); for (const t of e.ac.trails) this.trails.reset(t); e.pending = 0; fled++; }
    if (fled) this.hud.kill('ESCORTS FLEE');
  }

  /** A bandit's bullet just whistled past you: a crack, a nudge of the camera, a flick of the crosshair. */
  whiz() {
    this.audio.whiz();
    this.camKick = Math.min(1, this.camKick + 0.3);
    this.hud.whiz();
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

  fire(ac, pool, damage, spread, rate) {
    if (ac.gunTimer > 0) return;
    ac.gunTimer = 1 / rate;
    const muzzle = ac.nextMuzzle(tv);
    tv2.copy(ac.forward).add(spreadV.set(rnd(-spread, spread), rnd(-spread, spread), rnd(-spread, spread))).normalize().multiplyScalar(BULLET_SPEED).add(ac.velocity);
    pool.spawn(muzzle, tv2, ac, damage);
    this.effects.muzzle(muzzle);
    if (ac === this.player) { this.camKick = Math.min(1, this.camKick + 0.35); this.shots++; this.waveShots++; }
    this.audio.gun(ac === this.player ? 0 : ac.pos.distanceTo(this.player.pos));
  }

  killAircraft(ac, size = 1) {
    ac.alive = false; ac.hide(); ac.health = 0;
    for (const t of ac.trails) this.trails.reset(t);
    const c = ac.plane.scheme;
    this.effects.explosion(ac.pos, [c.body, c.accent, c.trim, 0x333333], size);
    this.effects.wreck(ac.pos, ac.velocity, [c.body, c.accent, c.trim]);
    this.world.scare(ac.pos, 180);
    this.shakeAt(ac.pos, 0.3 * size);
    this.audio.explosion(ac.pos.distanceTo(this.player.pos), size);
  }

  nearestEnemy(range) {
    let best = null, bestD = range * range;
    for (const t of this.targetList) {
      if (!t.alive || t.absorb) continue;
      const d = t.pos.distanceToSquared(this.player.pos);
      if (d < bestD) { bestD = d; best = t.pos; }
    }
    return best;
  }

  /** Rebuilds the shared target list without allocating: live bandits, then the airship's hulls when it is up. */
  collectTargets() {
    const list = this.targetList;
    list.length = 0;
    for (const e of this.enemies) if (e.ac.alive) list.push(e.ac);
    if (this.airship.alive && this.airship.falling === 0) for (const h of this.airship.targets) list.push(h);
    return list;
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
    if (p.pos.y < 40) this.world.brushPalms(p.pos, dt, (x, y, z) => { this.effects.leaves(tv.set(x, y, z), p.velocity); this.audio.whoosh(0.35, p.toLocal(tv, tv2).x / 8, 0.5); });
    const fast = p.speed > p.stats.maxSpeed * 1.03;
    if (fast && !this.wasFast) { this.effects.cone(p.pos, p.forward); this.audio.boom(); this.camKick = 1; }
    this.wasFast = fast || (this.wasFast && p.speed > p.stats.maxSpeed * 0.97);
  }

  /** A shot-down bandit: quick successive kills chain into a combo that multiplies the score. `at` is where the
   *  points pop up in the world. */
  registerKill(label, base, at = null) {
    this.kills++; this.waveKills = (this.waveKills || 0) + 1; this.note('kill');
    this.combo = this.comboTimer > 0 ? this.combo + 1 : 1;
    this.bestCombo = Math.max(this.bestCombo, this.combo);
    this.comboTimer = 2.5;
    const pts = base * this.combo;
    this.addScore(pts);
    this.hud.kill(`${label}  +${pts}`);
    if (at) this.hud.popup(at, `+${pts}`, this.combo > 1);
    if (this.combo > 1) { this.hud.combo(this.combo); this.effects.shake = Math.max(this.effects.shake, 0.25 + this.combo * 0.08); }
    this.hud.bump('score');
    this.audio.kill(this.combo);
  }

  /** Screen shake that falls off with distance from the player: a close explosion rocks the camera, a far one taps it. */
  shakeAt(pos, base) {
    const near = clamp(1 - pos.distanceTo(this.player.pos) / 240, 0, 1);
    this.effects.shake = Math.max(this.effects.shake, base + near * 0.9);
  }

  /** One entry in the run's flight log (drawn on the debrief): a wave start, a kill, or a hit taken. */
  note(k, n) { if (this.log.length < 600) this.log.push({ t: this.aloft, k, n }); }

  /** A medal's condition was met. The first time ever it is kept, named in the feed and chimed; every time it counts
   *  for this run's debrief line. */
  earn(id) {
    if (!this.runMedals.includes(id)) this.runMedals.push(id);
    if (!this.medals.earn(id)) return;
    this.newMedals.push(id);
    this.hud.kill(`MEDAL · ${byId(id).name}`);
    this.audio.medal();
  }

  /** Fixed-step simulation. Runs at 120 Hz; nothing in here touches the camera or the DOM. */
  update(dt) {
    if (this.state === 'title') { this.effects.update(dt); return; }
    if (this.hitStop > 0) { this.hitStop -= dt; return; }   // a few frames of freeze so a kill lands
    if (this.state === 'playing') { this.aloft += dt; this.streak += dt; }   // real seconds, before any slow motion
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
        if (left <= 0 || p.health <= 0) { p.health = 0; this.playerDied(false, 'zone'); }
      } else {
        this.outsideTimer = Math.max(0, this.outsideTimer - dt * 2.5);   // countdown recovers quickly once back inside
      }
      this.outside = outside;
      this.world.setDanger(outside ? 1 : Math.min(1, this.outsideTimer / 2));
      const groundUnder = groundAt(p.pos.x, p.pos.z), alt = p.pos.y - groundUnder;
      if (!outside && alt < 22 && p.forward.y < 0) warning = 'PULL UP';
      hud.warn(warning);
      // the ground cushion of the first waves: if the flight path over the next 160 units meets the ground (a dive,
      // or a cliff face ahead), the nose is eased up for you, harder the deeper it would go, and when it is bad the
      // wings are levelled and the brake comes on so the plane can actually turn. Level skimming over flat ground is
      // untouched; it fades out by wave 7.
      if (this.learn > 0 && p.speed > 1) {
        let pred = alt;
        for (const d of [40, 80, 120, 160]) { const s = d / p.speed; pred = Math.min(pred, p.pos.y + p.velocity.y * s - groundAt(p.pos.x + p.velocity.x * s, p.pos.z + p.velocity.z * s)); }
        if (pred < 12) {
          const k = this.learn * clamp((12 - pred) / 20, 0, 1);
          p.input.pitch = Math.max(p.input.pitch, k);
          if (k > 0.5) { p.input.throttle = Math.min(p.input.throttle, -k); p.input.roll += (clamp(p.right.y * 3, -1, 1) - p.input.roll) * k; }
          this.cushioned += dt;
        }
      }
      this.collectTargets();
      const found = this.world.landmarks.check(p.pos, this.found); if (found) this.foundLandmark(found);
      p.lookTarget = this.nearestEnemy(400);
      p.update(dt);
      this.shedTip(p);
      this.nearMiss(p, dt);
      if (inp.fire) this.fire(p, this.playerBullets, 11, 0.012, 13);
      // the loop medal: a full turn of pitch inside eight seconds that really goes over the top (nose near vertical
      // both ways, so a string of banked turns does not count), without a shot fired
      if (inp.fire || this.loopT > 8) { this.loopAcc = 0; this.loopT = 0; this.loopUp = this.loopDown = false; }
      else {
        this.loopAcc += p.pitchVel * dt; this.loopT += dt;
        if (p.forward.y > 0.88) this.loopUp = true;
        if (p.forward.y < -0.88) this.loopDown = true;
        if (Math.abs(this.loopAcc) > TWO_PI * 0.92 && this.loopUp && this.loopDown) { this.earn('loop'); this.loopAcc = 0; this.loopT = 0; this.loopUp = this.loopDown = false; }
      }
      if (p.pos.y < groundAt(p.pos.x, p.pos.z) + 2.2) this.playerDied(isWaterAt(p.pos.x, p.pos.z), 'terrain');
      this.regenDelay -= dt;
      if (this.regenDelay <= 0 && p.health < p.maxHealth) p.health = Math.min(p.maxHealth, p.health + 3 * dt);
    }

    // ---- enemies
    if (this.state === 'playing') this.spawnPending(dt);
    this.portal.update(dt);
    let alive = 0;
    const pack = this.pack;
    pack.hunting = 0;
    for (const e of this.enemies) if (e.ac.alive && e.brain.state === 'pursue') pack.hunting++;
    for (const e of this.enemies) {
      const ac = e.ac;
      if (!ac.alive) continue;
      alive++;
      e.brain.update(dt, p, pack);
      ac.barrel = e.brain.state === 'barrel';
      ac.lookTarget = p.alive ? p.pos : null;
      ac.update(dt);
      this.shedTip(ac);
      if (!Number.isFinite(ac.pos.x + ac.pos.y + ac.pos.z + ac.quat.w)) { this.recallStraggler(e); continue; }
      if (this.state === 'playing') {
        e.far = ac.pos.distanceToSquared(p.pos) > 1100 * 1100 ? (e.far || 0) + dt : 0;
        if (e.far > 35) { this.recallStraggler(e); continue; }
      }
      if (e.brain.wantsFire && p.alive && this.wave > 1) this.fire(ac, this.enemyBullets, 4 + this.wave * 0.5, 0.02 + (1 - e.brain.skill) * 0.03, 8);
      // the interceptor's dive: a siren as it comes down on you, once per dive
      if (e.type === 'interceptor' && e.brain.state === 'pursue') {
        const diving = ac.forward.y < -0.35 && ac.pos.y > p.pos.y + 40 && ac.pos.distanceToSquared(p.pos) < 420 * 420;
        if (diving && !e.sirened) { e.sirened = true; this.audio.dive(ac.pos.distanceTo(p.pos)); }
        else if (!diving && ac.pos.y > p.pos.y + 120) e.sirened = false;
      }
      if (ac.pos.y < groundAt(ac.pos.x, ac.pos.z) + 2) {
        this.killAircraft(ac, 0.8); this.registerKill('BANDIT CRASHED', 40, ac.pos); if (isWaterAt(ac.pos.x, ac.pos.z)) this.effects.splash(ac.pos);
        continue;
      }
      if (p.alive && ac.pos.distanceToSquared(p.pos) < 64) {
        this.killAircraft(ac, 1); this.registerKill('RAMMED', 60, ac.pos);
        this.hurtPlayer(20, ac.pos);
      }
      this.smokeTrail(ac, dt);
    }
    if (p.alive) { this.smokeTrail(p, dt); this.contrail(p, dt); }
    this.contrails.update(dt);
    // ---- the airship
    if (this.airship.alive) {
      if (this.airship.update(dt, p, (muzzle, dir, k) => this.turretFire(muzzle, dir, k))) this.airshipDown();
      else alive++;   // still up, or still falling: the wave is not over until it hits
    }

    // ---- bullets
    const targets = this.targetList;
    this.playerBullets.update(dt, targets, (t, point, dmg) => {
      this.effects.hitSpark(point);
      this.audio.hit(t.pos.distanceTo(p.pos));
      this.hits++; this.waveHits++;
      if (t.absorb) { this.addScore(1); return; }   // the envelope: a spark and nothing else
      if (t.damage(dmg)) {
        if (t.ship && t.turret >= 0) { this.addScore(150); this.hud.kill('TURRET DOWN  +150'); this.hud.popup(t.pos, '+150'); this.audio.explosion(t.pos.distanceTo(p.pos), 0.7); this.world.scare(t.pos, 140); return; }
        if (t.ship) { this.addScore(10); return; }   // the gondola is done: the airship handles its own fall
        const type = this.enemies.find((e) => e.ac === t)?.type || 'hound';
        this.killAircraft(t, 1); this.registerKill(TYPE_LABEL[type], TYPE_SCORE[type] * this.wave, t.pos);
        if (p.pos.y - groundAt(p.pos.x, p.pos.z) < 8) this.earn('wavetop');
        const last = this.pending === 0 && !this.enemies.some((e) => e.ac.alive) && !this.airship.alive;
        if (!last && type === 'ace') {   // an ace down earns a banner and a short turn of the camera round its wreck
          this.hud.banner('ACE DOWN', 1300);
          this.killCam = 0.4; this.killPoint.copy(t.pos);
          this.killAngle = Math.atan2(this.camera.position.x - t.pos.x, this.camera.position.z - t.pos.z);
        } else if (last) {
          // the wave's last bandit: swing the camera round its explosion in slow motion
          this.killCam = 0.7; this.killPoint.copy(t.pos);
          this.killAngle = Math.atan2(this.camera.position.x - t.pos.x, this.camera.position.z - t.pos.z);
        } else this.hitStop = Math.min(0.11, 0.05 + 0.02 * (this.combo - 1));   // a chain freezes a touch longer
      }
      else this.addScore(2);
    }, (pt, water) => this.effects.groundHit(pt, water), this.assist);
    this.enemyBullets.update(dt, p.alive ? [p] : [], (t, point, dmg, owner) => { this.effects.hitSpark(point); if (owner === this.airship) this.turretDamage += dmg; this.hurtPlayer(dmg, owner.pos); }, (pt, water) => this.effects.groundHit(pt, water));
    if (p.alive) {   // near misses: a bandit's bullet inside ten units of you that did not hit
      const eb = this.enemyBullets, P = eb.pos;
      for (const i of eb.active) {
        if (eb.passed[i]) continue;
        const i3 = i * 3, dx = P[i3] - p.pos.x, dy = P[i3 + 1] - p.pos.y, dz = P[i3 + 2] - p.pos.z;
        if (dx * dx + dy * dy + dz * dz < 100) { eb.passed[i] = 1; this.whiz(); }
      }
    }

    // ---- waves
    if (this.state === 'playing') {
      if (alive === 0 && this.pending === 0) {
        this.waveClearTimer += dt;
        if (this.waveClearTimer > 0.2 && this.waveClearTimer - dt <= 0.2) {
          this.hud.banner('WAVE CLEAR!', 2200); this.player.health = Math.min(this.player.maxHealth, this.player.health + 30); this.addScore(250 * this.wave); this.audio.waveClear();
          if (this.waveShots >= 8 && this.waveHits >= this.waveShots) this.earn('marksman');
          if (this.waveDamage === 0 && this.waveKills > 0) { const b = 250 * this.wave; this.addScore(b); this.hud.kill(`UNTOUCHED  +${b}`); this.hud.popup(p.pos, `+${b}`, true); }
        }
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
    if (this.state === 'gameover') this.hud.tickDebrief(dt);
    // draw every plane between its last two sim states, then place the camera on the drawn pose
    if (this.player.alive) this.present(this.player);
    for (const e of this.enemies) if (e.ac.alive) this.present(e.ac);
    this.updateCamera(dt);
    const alive = this.player.alive && this.state === 'playing', pl = this.player;
    this.audio.setFlight(alive ? pl.speed : 0, alive ? pl.input.throttle : 0, alive && this.outside, dt, alive ? pl.health / pl.maxHealth : 1,
      alive ? this.groundRush() : 0, alive ? clamp(Math.abs(pl.pitchVel) / pl.stats.pitchRate, 0, 1) : 0);
    this.audio.setAmbience(this.airship.alive ? clamp(1 - this.airship.pos.distanceTo(this.camera.position) / 420, 0, 1) : 0);
    this.passes(alive);
    if (this.state === 'playing') {
      const p = this.player;
      this.hud.updateStats({ score: this.score, wave: this.wave, enemies: (this.aliveCount || 0) + this.pending, total: this.waveSize || 0, health: p.health, maxHealth: p.maxHealth, speed: p.speed, maxSpeed: PLAYER_STATS.maxSpeed * 1.2, boost: p.input.throttle > 0, firing: this.input.fire, combo: this.combo > 0 ? this.comboTimer / 2.5 : 0 }, dt);
      const lead = this.computeLead(this.targetList);
      for (const l of this.world.landmarks.list) l.found = this.found.has(l.id);
      this.hud.updateOverlay(this.camera, { pos: p.renderPos, forward: p.renderForward }, this.targetList, lead.point, lead.locked, this.portal.active ? this.portal.pos : null, this.world.landmarks.list, dt);
    }
  }

  /** How close the ground and its walls are, 0 in open air to 1 skimming, weighted by speed: the wingtips and the
   *  air ahead are sampled as well as the ground below, so a cliff beside or in front of you counts too. */
  groundRush() {
    const p = this.player;
    let near = 0;
    for (const [f, r] of RUSH_TAPS) {
      tv.copy(p.pos).addScaledVector(p.forward, f).addScaledVector(p.right, r);
      near = Math.max(near, clamp(1 - (p.pos.y - groundAt(tv.x, tv.z)) / 34, 0, 1));
    }
    return near * near * clamp((p.speed - 45) / 70, 0, 1);
  }

  /** Fly-by sound, per displayed frame: the nearest bandits' engines follow them round you, Doppler-shifted by how
   *  fast the gap is closing, and anything big that goes past inside its radius, bandit, airship, portal, balloon or
   *  landmark, lands a rush of air on the side it passed. The pass is the frame the gap stops shrinking; how loud
   *  it is comes from the fastest closing speed of the approach and how close it came. */
  passes(alive) {
    const p = this.player, list = this.flybys;
    let n = 0;
    const consider = (o, pos, vel, r, size, voice) => {
      fbRel.copy(pos).sub(p.pos);
      const d = fbRel.length() || 1;
      const closing = -fbRel.dot(tv2.copy(vel).sub(p.velocity)) / d;   // how fast the gap shrinks, in units per second
      const side = clamp(p.toLocal(pos, fbLocal).x / 24, -1, 1);
      if (closing > 0) o.peak = Math.max(o.peak || 0, closing);
      else if (o.peak > 30) { if (d < r) this.audio.whoosh(clamp(o.peak / 180, 0, 1) * (1 - d / r), side, size); o.peak = 0; }
      if (voice && d < 170) { const l = list[n++]; l.id = o; l.dist = d; l.side = side; l.speed = voice.speed; l.doppler = SOUND_OF_SPEED / (SOUND_OF_SPEED - clamp(closing, -120, 120)); }
    };
    if (alive) {
      for (const e of this.enemies) if (e.ac.alive) consider(e, e.ac.pos, e.ac.velocity, 42, 1, e.ac);
      if (this.airship.alive) consider(this.airship, this.airship.pos, this.airship.velocity, 60, 2.2, null);
      if (this.portal.active) consider(this.portal, fbPos.copy(this.portal.pos).setY(this.portal.pos.y + 20), STILL, 36, 1.4, null);
      for (const o of this.world.obstacles) consider(o, fbPos.set(o.x, o.y, o.z), STILL, o.r, 1, null);
      // the three nearest to the front of the list, in place
      for (let i = 0; i < Math.min(n, 3); i++) { let m = i; for (let j = i + 1; j < n; j++) if (list[j].dist < list[m].dist) m = j; const l = list[i]; list[i] = list[m]; list[m] = l; }
    }
    this.audio.setFlybys(list, Math.min(n, 3));
  }

  smokeTrail(ac, dt) {
    // Wingtip vapor: strongest while pulling hard, a faint thread while boosting.
    const g = Math.abs(ac.pitchVel) / ac.stats.pitchRate + Math.abs(ac.rollVel) / ac.stats.rollRate * 0.5;
    let intensity = Math.max(clamp((g - 0.45) / 0.45, 0, 1), ac.input.throttle > 0 ? 0.3 : 0);
    if (ac.barrel) intensity = 1;   // the ace's corkscrew draws itself in vapour
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

  /** A plane drawn between its last two sim states, with its vapour ribbons glued to the drawn wingtips. */
  present(ac) {
    ac.present(this.alpha);
    const right = tv2.set(1, 0, 0).applyQuaternion(ac.renderQuat);
    tv.copy(ac.renderPos).addScaledVector(right, 7.9).addScaledVector(ac.renderForward, -0.9);
    this.trails.glue(ac.trails[0], tv, ac.renderUp);
    tv.copy(ac.renderPos).addScaledVector(right, -7.9).addScaledVector(ac.renderForward, -0.9);
    this.trails.glue(ac.trails[1], tv, ac.renderUp);
  }

  /** Contrails: the wingtips draw in the cold air high up, fading in over the last sixty units of the climb. */
  contrail(ac, dt) {
    const hi = clamp((ac.pos.y - 360) / 60, 0, 1);
    tv.copy(ac.pos).addScaledVector(ac.right, 7.9).addScaledVector(ac.forward, -1.5);
    this.contrails.push(0, dt, tv, ac.up, hi);
    tv.copy(ac.pos).addScaledVector(ac.right, -7.9).addScaledVector(ac.forward, -1.5);
    this.contrails.push(1, dt, tv, ac.up, hi);
  }

  /** `from` is where the hit came from, for the arc on the screen edge. */
  hurtPlayer(dmg, from = null) {
    const p = this.player;
    if (!p.alive) return;
    if (from) { const l = p.toLocal(from, tv); this.hud.hitFrom(Math.atan2(l.x, l.z)); }
    this.waveDamage = (this.waveDamage || 0) + dmg;
    this.bestStreak = Math.max(this.bestStreak, this.streak); this.streak = 0; this.note('hit');
    this.regenDelay = 4;
    this.hud.damage(dmg / 25);
    this.hud.hit();
    this.audio.hit(0);
    this.effects.shake = Math.max(this.effects.shake, 0.5);
    if (p.damage(dmg)) this.playerDied(false, 'shot');
  }

  playerDied(water, cause = 'shot') {
    const p = this.player;
    if (this.state !== 'playing') return;
    this.deathCause = water ? 'sea' : cause;
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
    this.hud.showTouch(false);   // the thumbs' buttons would sit over the debrief
    this.bestStreak = Math.max(this.bestStreak, this.streak);
    let isBest = this.score > this.best;
    if (isBest) { this.best = this.score; store.set('skyfight.best', String(this.best)); this.hud.text('best', String(this.best)); }
    if (this.wave > this.bestWave) { this.bestWave = this.wave; store.set('skyfight.bestwave', String(this.wave)); this.hud.text('bestwave', ` · wave ${this.wave}`); }
    let share = null;
    if (this.daily) {
      const key = todayKey(), prev = loadDailyBest(key);
      isBest = !prev || this.score > prev.best;
      if (isBest) saveDailyBest({ date: key, best: this.score, waves: this.wave, kills: this.kills });
      this.hud.daily(todayLabel(), loadDailyBest(key));
      const wings = MEDALS.filter((m) => m.wave && this.wave >= m.wave).length, secretCount = MEDALS.filter((m) => !m.wave).length;
      const secrets = this.runMedals.filter((id) => !byId(id).wave).length;
      share = shareLine({ date: key, wave: this.wave, kills: this.kills, score: this.score, wings, secrets, secretCount });
    }
    // the medal line: the newest medal if one was earned, else the run's highest, else the next one to aim for
    let medal = null, next = null;
    if (this.newMedals.length) medal = { ...byId(this.newMedals[this.newMedals.length - 1]), isNew: true };
    else if (this.runMedals.length) medal = byId(this.runMedals.reduce((a, b) => (MEDALS.indexOf(byId(b)) > MEDALS.indexOf(byId(a)) ? b : a)));
    else next = MEDALS.find((m) => m.wave && !this.medals.has(m.id)) || null;
    this.hud.medals(this.medals);
    this.hud.showDebrief({
      mode: this.daily ? `Flight #${dayNumber()} · ${todayLabel()}` : 'Free flight', cause: this.deathCause,
      score: this.score, waves: this.wave, kills: this.kills, accuracy: this.shots ? this.hits / this.shots * 100 : 0,
      bestCombo: this.bestCombo, streak: this.bestStreak, aloft: this.aloft, medal, next, isBest, share, log: this.log,
    });
  }

  addScore(n) { this.score += n; }

  computeLead(enemies) {
    const p = this.player;
    let best = null, bestD = 620;
    for (const e of enemies) {
      if (e.absorb || !e.alive) continue;
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
      this.camQuat.copy(p.renderQuat);
      this.camPos.set(0, 6.5, 25).applyQuaternion(this.camQuat).add(p.renderPos);
      this.fov = 62;
    }
    // The camera follows the nose more slowly through a hard roll and slides to the outside of the turn.
    const turn = clamp(Math.abs(p.rollVel) / p.stats.rollRate, 0, 1);
    this.camQuat.slerp(p.renderQuat, 1 - Math.exp(-dt * (5 - 2.2 * turn)));
    const boost = p.input.throttle > 0 ? 1 : 0;
    this.camKick *= Math.exp(-dt * 14);
    tv.set(-p.rollVel * 0.9, 6.5, 25 + boost * 3 + this.camKick * 0.6).applyQuaternion(this.camQuat).add(p.renderPos);
    this.camPos.lerp(tv, 1 - Math.exp(-dt * 18));
    cam.position.copy(this.camPos);
    if (fx.shake > 0) cam.position.add(tv2.set(rnd(-1, 1), rnd(-1, 1), rnd(-1, 1)).multiplyScalar(fx.shake * 1.4));
    const minY = groundAt(cam.position.x, cam.position.z) + 3;
    if (cam.position.y < minY) cam.position.y = minY;
    cam.up.copy(tv2.set(0, 1, 0).applyQuaternion(this.camQuat)).lerp(WORLD_UP, 0.45).normalize();
    tv.copy(p.renderPos).addScaledVector(p.renderForward, 38).addScaledVector(p.renderUp, 2);
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
