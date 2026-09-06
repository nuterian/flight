// Headless test hooks: step the simulation deterministically, render a frame even when the tab is hidden, and
// measure the bandits against a scripted pilot (__aiProfile) so AI changes are tuned by numbers, not by feel.
import * as THREE from 'three/webgpu';
import { Music } from './music.js';
import { EnemyBrain } from './ai.js';
import { Aircraft } from './aircraft.js';
import { BULLET_SPEED } from './bullets.js';
import { groundAt, BOUNDS } from './terrain.js';
import { Medals } from './medals.js';

export function attachDevHooks({ game, input, world, camera, pipeline, renderer, boxes, useTitleLens, title, music, menuMusic }) {
  const frame = (seconds) => {
    if (useTitleLens) useTitleLens(game.state === 'title');
    if (menuMusic) menuMusic();
    game.render(seconds);
    world.update(seconds, performance.now() / 1000, game.player.pos, camera, game.player.alive ? game.player.speed : 0);
    if (title) title.update(seconds, performance.now() / 1000, camera, game.state === 'title');
    for (const b of boxes) b.flush();
    // Per-frame passes (scene, bloom, dof) only re-render when the node frame advances, which the renderer's own
    // animation loop normally does. Headless frames have to advance it themselves or only the final quad draws.
    renderer._nodes.nodeFrame.update();
    pipeline.render();
  };
  window.__game = game;
  window.__dev = { renderer, pipeline, camera, world, boxes, input, useTitleLens, title, music };
  /** Renders bars [from, to) of the theme offline and measures it: peak, RMS, spectral flatness (1 = noise), centroid. */
  window.__analyzeMusic = async (from = 8, to = 12) => {
  const sr = 44100, STEP = 60 / music.score.bpm / 4, secs = (to - from) * 16 * STEP + 2;
    const off = new OfflineAudioContext(1, Math.ceil(secs * sr), sr);
    const master = off.createGain(); master.connect(off.destination);
    const m = new Music({ ctx: off, master }, music.score);
    m.setup();
    for (let i = 0; i < 40 && !m.ks; i++) await new Promise(r => setTimeout(r, 100));
    m.out.gain.value = 0.5;
    for (let s = from * 16; s < to * 16; s++) m.score.at(m, Math.floor(s / 16), s % 16, 0.2 + (s - from * 16) * STEP);
    const buf = await off.startRendering();
    const x = buf.getChannelData(0);
    let peak = 0, sq = 0; for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > peak) peak = a; sq += x[i] * x[i]; }
    const rms = Math.sqrt(sq / x.length);
    // spectral flatness over 4096-sample frames (1 = white noise, ~0 = pure tones)
    const N = 4096; const re = new Float32Array(N), im = new Float32Array(N);
    const fft = (re, im) => { const n = re.length; for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } } for (let len = 2; len <= n; len <<= 1) { const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang); for (let i = 0; i < n; i += len) { let cr = 1, ci = 0; for (let k = 0; k < len / 2; k++) { const a = i + k, b = a + len / 2; const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr; re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti; const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr; } } } };
    let flatSum = 0, frames = 0, centroidSum = 0;
    for (let o = sr; o + N < x.length - sr; o += N) {
      for (let i = 0; i < N; i++) { re[i] = x[o + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / N)); im[i] = 0; }
      fft(re, im);
      let logSum = 0, linSum = 0, cs = 0, bins = 0;
      for (let k = 20; k < N / 2; k++) { const p = re[k] * re[k] + im[k] * im[k] + 1e-12; logSum += Math.log(p); linSum += p; cs += p * k; bins++; }
      flatSum += Math.exp(logSum / bins) / (linSum / bins); centroidSum += cs / linSum * sr / N; frames++;
    }
    return { seconds: +secs.toFixed(1), peak: +peak.toFixed(3), rms: +rms.toFixed(3), flatness: +(flatSum / frames).toFixed(4), centroidHz: Math.round(centroidSum / frames), worklet: m.ks };
  };
  window.__step = (seconds, fixedInput) => {
    const n = Math.round(seconds * 120);
    for (let i = 0; i < n; i++) {
      if (fixedInput) Object.assign(input, fixedInput); else input.update();
      game.update(1 / 120);
    }
    frame(seconds);
  };
  let seed = 1234567;
  const seeded = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const realRandom = Math.random;
  /** A repeatable wave-6 fight from a fixed pose, with seeded randomness, for before/after benchmarks. */
  /** Headless runs must not hand out real medals: swap in a scratch set for the duration. */
  const realMedals = game.medals;
  window.__scenario = () => {
    seed = 1234567;
    Math.random = seeded;
    game.medals = new Medals(false);
    game.start();
    for (let i = 0; i < 5; i++) game.nextWave();
    for (const e of game.enemies) if (e.pending > 0) e.pending = 1e-4;
    game.update(1 / 120);
    const p = game.player;
    p.pos.set(-140, 150, 520); p.quat.set(-0.06, 0.12, 0, 1).normalize(); p.updateAxes();
    game.enemies.forEach((e, i) => { if (!e.ac.alive) return; e.ac.pos.copy(p.pos).addScaledVector(p.forward, 120 + i * 40).add({ x: (i - 3) * 30, y: (i % 2) * 20 - 10, z: 0 }); e.ac.quat.copy(p.quat); e.ac.updateAxes(); });
    window.__step(1.5, { pitch: 0.15, roll: 0.35, yaw: 0, throttle: 1, fire: true });
    Math.random = realRandom;
    game.medals = realMedals;
  };
  // ---- AI profile: a scripted "average" pilot flies a wave so the bandits' behaviour can be measured, not felt -------
  const clampN = THREE.MathUtils.clamp;
  const ptv = new THREE.Vector3(), paim = new THREE.Vector3(), pdir = new THREE.Vector3();
  const pilotBrain = new EnemyBrain(game.player, 0.55);   // borrows the bandits' steering maths; the skill sets its agility
  /** Two scripted pilots. `average` reacts every 0.3 s, fires inside a 4 degree cone. `rookie` is a first-timer: slow to
   *  react, half the agility, fires at anything inside 7 degrees and aims with a wobble of up to 20 units. */
  const PILOTS = {
    average: { react: 0.3, agility: 0.7, cone: 0.07, noise: 0 },
    rookie: { react: 0.55, agility: 0.5, cone: 0.12, noise: 20 },
  };
  let PILOT = PILOTS.average;
  let pTarget = null, pThink = 0;
  const pNoise = new THREE.Vector3();
  /** Turns toward the nearest bandit's lead point, boosts to close, brakes before ramming, fires inside its cone
   *  within 380 units, pulls up off the ground and turns back from the walls. Writes the shared Input like a keyboard. */
  const flyAverage = (dt) => {
    const p = game.player, inp = p.input;
    pThink -= dt;
    if (pThink <= 0 || !pTarget || !pTarget.alive) {
      pThink = PILOT.react; pTarget = null;
      pNoise.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(2 * PILOT.noise);
      let best = Infinity;
      for (const e of game.enemies) { if (!e.ac.alive) continue; const d = e.ac.pos.distanceToSquared(p.pos); if (d < best) { best = d; pTarget = e.ac; } }
    }
    let pitch = 0.03, roll = 0, yaw = 0, throttle = 0, fire = false;
    ptv.copy(p.pos).addScaledVector(p.forward, 80);
    const edge = Math.max(Math.abs(p.pos.x), Math.abs(p.pos.z));
    if (p.pos.y - groundAt(p.pos.x, p.pos.z) < 35 || ptv.y - groundAt(ptv.x, ptv.z) < 25) {
      pitch = 1; roll = clampN(p.right.y * 3, -1, 1); throttle = 1;
    } else if (edge > BOUNDS.half - 150 || p.pos.y > BOUNDS.ceiling - 60) {
      pilotBrain.steerTo(paim.set(0, 220, 0), 0.7); pitch = inp.pitch; roll = inp.roll; yaw = inp.yaw;
    } else if (pTarget) {
      const dist = p.pos.distanceTo(pTarget.pos);
      paim.copy(pTarget.pos).addScaledVector(pTarget.velocity, dist / BULLET_SPEED).add(pNoise);
      pilotBrain.steerTo(paim, PILOT.agility);
      pitch = inp.pitch; roll = inp.roll; yaw = inp.yaw;
      const l = p.toLocal(paim, ptv), off = Math.atan2(Math.hypot(l.x, l.y), l.z);
      fire = dist < 380 && off < PILOT.cone;
      throttle = dist > 240 ? 1 : (dist < 60 && l.z > 0 ? -1 : 0);
    }
    input.pitch = pitch; input.roll = roll; input.yaw = yaw; input.throttle = throttle; input.fire = fire;
  };
  window.__flyAverage = flyAverage;   // for staging: `__flyAverage(1/120); __game.update(1/120)` per step
  const profileOnce = (wave, seconds, s, pilot) => {
    seed = s; Math.random = seeded; PILOT = PILOTS[pilot] || PILOTS.average;
    game.medals = new Medals(false);
    const origDamage = Aircraft.prototype.damage, origFire = game.fire;
    const n = { pShots: 0, eShots: 0, pHits: 0, eHits: 0, taken: 0 };
    Aircraft.prototype.damage = function (amt) { if (this.team === 1) n.pHits++; else { n.eHits++; n.taken += amt; } return origDamage.call(this, amt); };
    game.fire = function (ac, ...rest) { if (ac.gunTimer <= 0) { if (ac === game.player) n.pShots++; else n.eShots++; } return origFire.call(this, ac, ...rest); };
    game.start();
    for (let i = 1; i < wave; i++) game.nextWave();
    pTarget = null; pThink = 0;
    const states = {}, windows = [], DT = 1 / 120, startWave = game.wave;
    let aliveT = 0, banditT = 0, huntedT = 0, tailT = 0, shotT = 0, freeT = 0, freeRun = 0, t = 0, cleared = -1;
    for (; t < seconds && game.state === 'playing'; t += DT) {
      flyAverage(DT);
      game.update(DT);
      if (game.wave > startWave && cleared < 0) cleared = t;
      const p = game.player;
      let alive = 0, hunted = false, tail = false, shot = false, pursuing = false;
      for (const e of game.enemies) {
        const ac = e.ac; if (!ac.alive) continue;
        alive++;
        const st = e.brain.state; states[st] = (states[st] || 0) + DT;
        if (st === 'pursue') pursuing = true;
        const dist = ac.pos.distanceTo(p.pos);
        const nose = ac.forward.dot(pdir.copy(p.pos).sub(ac.pos).normalize());   // 1 = the bandit points straight at you
        const l = p.toLocal(ac.pos, ptv);
        const ahead = l.z > 0 && Math.atan2(Math.hypot(l.x, l.y), l.z) < 0.6;
        if (st === 'pursue' && dist < 500 && nose > 0.86) hunted = true;
        if (l.z < 0 && dist < 260 && nose > 0.94) tail = true;
        if (ahead && dist < 420 && nose < 0.35) shot = true;
      }
      if (alive === 0) { if (freeRun > 0) { windows.push(freeRun); freeRun = 0; } continue; }
      aliveT += DT; banditT += alive * DT;
      if (hunted) huntedT += DT;
      if (tail) tailT += DT;
      if (shot) shotT += DT;
      if (!pursuing) { freeT += DT; freeRun += DT; } else if (freeRun > 0) { windows.push(freeRun); freeRun = 0; }
    }
    if (freeRun > 0) windows.push(freeRun);
    Aircraft.prototype.damage = origDamage; game.fire = origFire;
    const kills = game.kills, health = game.player.health, died = game.state !== 'playing', reached = game.wave, cause = died ? game.deathCause : null, cushionT = game.cushioned;
    game.abort();
    Math.random = realRandom; game.medals = realMedals;
    const f = (x) => +x.toFixed(3);
    const stateFrac = {}; for (const k in states) stateFrac[k] = f(states[k] / (banditT || 1));
    return {
      wave, waveReached: reached, seconds: f(t), died, cause, cushioned: f(cushionT), cleared: cleared < 0 ? null : f(cleared), kills, healthLeft: Math.round(health), damageTaken: Math.round(n.taken),
      shots: n.pShots, hits: n.pHits, accuracy: f(n.pHits / (n.pShots || 1)), banditShots: n.eShots, banditHits: n.eHits,
      // fractions of the time at least one bandit was alive
      huntedFrac: f(huntedT / (aliveT || 1)),   // a pursuing bandit had its nose on you within 500
      onTailFrac: f(tailT / (aliveT || 1)),     // one sat behind you within 260, lined up
      shotFrac: f(shotT / (aliveT || 1)),       // one was ahead of you within 420 showing you its tail or side
      freeFrac: f(freeT / (aliveT || 1)),       // nobody was pursuing you at all
      freeWindows: windows.length, freeMean: f(windows.reduce((a, b) => a + b, 0) / (windows.length || 1)), freeMax: f(windows.reduce((a, b) => Math.max(a, b), 0)),
      states: stateFrac,
    };
  };
  /** Flies `runs` seeded fights from `wave` with the scripted pilot and averages the measurements (per-run in `runs`). */
  window.__aiProfile = ({ wave = 1, seconds = 60, runs = 3, seedBase = 4242, pilot = 'average' } = {}) => {
    const rs = [];
    try { for (let r = 0; r < runs; r++) rs.push(profileOnce(wave, seconds, seedBase + r * 7919, pilot)); }
    finally { Math.random = realRandom; }
    const avg = {};
    for (const k in rs[0]) {
      const vals = rs.map((x) => x[k]);
      if (vals.every((v) => typeof v === 'number' || v === null)) { const nums = vals.filter((v) => v !== null); avg[k] = nums.length ? +(nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(3) : null; }
      else if (vals.every((v) => typeof v === 'boolean')) avg[k] = +(vals.filter(Boolean).length / vals.length).toFixed(2);
      else if (vals.every((v) => v && typeof v === 'object')) { avg[k] = {}; for (const v of vals) for (const s in v) avg[k][s] = +((avg[k][s] || 0) + v[s] / vals.length).toFixed(3); }
      else avg[k] = vals[0];
    }
    avg.runs = rs;
    return avg;
  };
  /**
   * Throughput bench. Frames are submitted back to back with the animation loop paused and randomness seeded:
   *  cpuMsPerFrame   sim step + render submission (synchronous JS work)
   *  wallMsPerFrame  elapsed until the GPU queue drains, i.e. max(cpu, gpu): the real frame cost
   *  gpuTimestampMs  GPU timestamp queries, per frame (Chrome quantizes and inflates these; use for trends only)
   *  drawCalls       across every pass of one frame (shadow, reflection, scene, bloom, output)
   */
  window.__bench = async (frames = 120) => {
    const info = renderer.info, device = renderer.backend.device;
    const loop = renderer._animation._animationLoop;
    renderer.setAnimationLoop(null);
    Math.random = seeded;
    let draws = 0;
    if (device) await device.queue.onSubmittedWorkDone();
    const t0 = performance.now();
    for (let i = 0; i < frames; i++) {
      info.reset();
      input.update(); game.update(1 / 120); frame(1 / 60);
      draws = info.render.drawCalls;
    }
    const cpu = (performance.now() - t0) / frames;
    if (device) await device.queue.onSubmittedWorkDone();
    const wall = (performance.now() - t0) / frames;
    await renderer.resolveTimestampsAsync('render');
    const gpuTs = (info.render.timestamp || 0) / frames;
    renderer.setAnimationLoop(loop);
    Math.random = realRandom;
    return { cpuMsPerFrame: +cpu.toFixed(2), wallMsPerFrame: +wall.toFixed(2), gpuTimestampMs: +gpuTs.toFixed(2), drawCalls: draws, size: [innerWidth, innerHeight, devicePixelRatio] };
  };
  /** Best of `runs` benches: robust to background load. */
  window.__benchMin = async (runs = 3, frames = 180) => {
    let best = null;
    for (let r = 0; r < runs; r++) { const b = await window.__bench(frames); if (!best || b.wallMsPerFrame < best.wallMsPerFrame) best = { ...b, cpuMsPerFrame: Math.min(b.cpuMsPerFrame, best ? best.cpuMsPerFrame : 1e9) }; }
    return best;
  };
}
