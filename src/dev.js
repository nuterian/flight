// Headless test hooks: step the simulation deterministically and render a frame even when the tab is hidden.
import { Music } from './music.js';

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
  window.__scenario = () => {
    seed = 1234567;
    Math.random = seeded;
    game.start();
    for (let i = 0; i < 5; i++) game.nextWave();
    for (const e of game.enemies) if (e.pending > 0) e.pending = 1e-4;
    game.update(1 / 120);
    const p = game.player;
    p.pos.set(-140, 150, 520); p.quat.set(-0.06, 0.12, 0, 1).normalize(); p.updateAxes();
    game.enemies.forEach((e, i) => { if (!e.ac.alive) return; e.ac.pos.copy(p.pos).addScaledVector(p.forward, 120 + i * 40).add({ x: (i - 3) * 30, y: (i % 2) * 20 - 10, z: 0 }); e.ac.quat.copy(p.quat); e.ac.updateAxes(); });
    window.__step(1.5, { pitch: 0.15, roll: 0.35, yaw: 0, throttle: 1, fire: true });
    Math.random = realRandom;
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
