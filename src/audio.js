// Procedural Web Audio, no files: every sound is an oscillator or a looped noise buffer shaped by filters and
// envelopes. Nothing here runs until init() is called from a user gesture; before that every method is a no-op.
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
/** localStorage throws in some private modes; the game must not care. */
export const store = {
  get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* fine */ } },
};
const atten = (dist) => 1 / (1 + dist / 250);

export class Sound {
  constructor() {
    this.ctx = null;
    this.muted = store.get('skyfight.mute') === '1';
    // browsers suspend contexts behind the player's back; wake it on the next interaction or when the tab returns
    const wake = () => { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {}); };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('keydown', wake); window.addEventListener('pointerdown', wake);
    this.warnTimer = 0; this.warnHi = false; this.beatTimer = 0;
    this.lastGun = 0; this.lastHit = 0; this.lastWhiz = 0;
  }

  /** Creates the graph. Must be called from a user gesture (start). */
  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {}); return; }
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return;
    const ctx = this.ctx = new C();
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 1;
    this.master.connect(ctx.destination);
    // a gentle compressor keeps stacked explosions and gunfire from clipping
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 5; comp.attack.value = 0.003; comp.release.value = 0.2;
    comp.connect(this.master);
    this.bus = comp;
    const len = ctx.sampleRate * 2, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noise = buf;

    // engine: two detuned oscillators through a low-pass, chopped by an LFO at the blade-pass rate
    const e = this.engine = { a: ctx.createOscillator(), b: ctx.createOscillator(), lp: ctx.createBiquadFilter(), chop: ctx.createGain(), lfo: ctx.createOscillator(), lfoGain: ctx.createGain(), gain: ctx.createGain() };
    e.a.type = 'sawtooth'; e.b.type = 'square';
    e.lp.type = 'lowpass'; e.lp.frequency.value = 520; e.lp.Q.value = 1.2;
    e.chop.gain.value = 0.75; e.lfoGain.gain.value = 0.25; e.lfo.type = 'sine'; e.lfo.frequency.value = 30;
    e.gain.gain.value = 0;
    e.a.connect(e.lp); e.b.connect(e.lp); e.lp.connect(e.chop); e.chop.connect(e.gain); e.gain.connect(this.bus);
    e.lfo.connect(e.lfoGain); e.lfoGain.connect(e.chop.gain);
    e.a.start(); e.b.start(); e.lfo.start();

    // wind: band-passed noise that opens up and gets louder with speed
    const w = this.wind = { src: ctx.createBufferSource(), bp: ctx.createBiquadFilter(), gain: ctx.createGain() };
    w.src.buffer = buf; w.src.loop = true;
    w.bp.type = 'bandpass'; w.bp.frequency.value = 500; w.bp.Q.value = 0.6;
    w.gain.gain.value = 0;
    w.src.connect(w.bp); w.bp.connect(w.gain); w.gain.connect(this.bus);
    w.src.start();

    // waterfall: a low rumble you only hear near the big drops
    const f = this.fall = { src: ctx.createBufferSource(), lp: ctx.createBiquadFilter(), gain: ctx.createGain() };
    f.src.buffer = buf; f.src.loop = true; f.src.loopStart = 0.7;
    f.lp.type = 'lowpass'; f.lp.frequency.value = 380; f.lp.Q.value = 0.5;
    f.gain.gain.value = 0;
    f.src.connect(f.lp); f.lp.connect(f.gain); f.gain.connect(this.bus);
    f.src.start();
  }

  /** Ambient layers: `fall` is 0..1 closeness to the nearest big waterfall. */
  setAmbience(fall) {
    if (!this.ctx) return;
    this.fall.gain.gain.setTargetAtTime(fall * fall * 0.5, this.ctx.currentTime, 0.25);
  }

  toggleMute() {
    this.muted = !this.muted;
    store.set('skyfight.mute', this.muted ? '1' : '0');
    if (this.ctx) this.master.gain.setTargetAtTime(this.muted ? 0 : 1, this.ctx.currentTime, 0.03);
    return this.muted;
  }

  /** Continuous layers, once per displayed frame. speed 0 = engine off. `hull` 0..1 brings in a heartbeat below 0.3. */
  setFlight(speed, throttle, warning, dt, hull = 1) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime, e = this.engine, w = this.wind;
    if (hull < 0.3 && speed > 0) {
      this.beatTimer -= dt;
      if (this.beatTimer <= 0) { this.beatTimer = 0.5 + hull * 1.6; this.blip(70, 40, 'sine', 0.18, 0.28); this.blip(60, 38, 'sine', 0.14, 0.18); }
    } else this.beatTimer = 0;
    const on = speed > 0 ? 1 : 0;
    const f = 55 + speed * 0.9;
    e.a.frequency.setTargetAtTime(f, t, 0.08);
    e.b.frequency.setTargetAtTime(f * 1.5 + 2, t, 0.08);
    e.lfo.frequency.setTargetAtTime(14 + speed * 0.3, t, 0.1);
    e.lp.frequency.setTargetAtTime(420 + Math.max(0, throttle) * 500 + speed * 2, t, 0.1);
    e.gain.gain.setTargetAtTime(on * (0.13 + Math.max(0, throttle) * 0.07), t, 0.12);
    w.bp.frequency.setTargetAtTime(350 + speed * 14, t, 0.15);
    w.gain.gain.setTargetAtTime(on * (0.015 + clamp((speed - 42) / 83, 0, 1) * 0.16), t, 0.15);
    // combat-zone warning: alternating two-tone beeps
    if (warning) {
      this.warnTimer -= dt;
      if (this.warnTimer <= 0) { this.warnTimer = 0.36; this.warnHi = !this.warnHi; this.tone(this.warnHi ? 660 : 520, 'square', 0.13, 0.09); }
    } else this.warnTimer = 0;
  }

  // ---- one-shots -------------------------------------------------------------------------------------------
  gun(dist = 0) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    if (t - this.lastGun < (dist > 0 ? 0.06 : 0.03)) return;
    this.lastGun = t;
    const a = atten(dist) * (dist > 0 ? 0.6 : 1);
    this.burst(1200, 'highpass', 0.045, 0.28 * a, 0.002);
    this.blip(110, 70, 'sine', 0.05, 0.22 * a);
  }

  hit(dist = 0) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    if (t - this.lastHit < 0.05) return;
    this.lastHit = t;
    const a = atten(dist);
    this.blip(900, 300, 'sine', 0.07, 0.18 * a);
    this.burst(3000, 'highpass', 0.015, 0.12 * a, 0.001);
  }

  explosion(dist = 0, size = 1) {
    if (!this.ctx) return;
    const a = atten(dist) * clamp(size, 0.6, 1.6);
    const ctx = this.ctx, t = ctx.currentTime;
    // rumble: noise with a low-pass sweeping down
    const src = ctx.createBufferSource(); src.buffer = this.noise;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
    lp.frequency.setValueAtTime(2200, t); lp.frequency.exponentialRampToValueAtTime(140, t + 0.7);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.7 * a, t + 0.015); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
    src.connect(lp); lp.connect(g); g.connect(this.bus); src.start(t); src.stop(t + 0.95);
    // sub-bass thump
    this.blip(62, 26, 'sine', 0.55, 0.8 * a);
  }

  kill(combo = 1) {
    if (!this.ctx) return;
    const up = 1 + 0.12 * (combo - 1);
    this.tone(660 * up, 'triangle', 0.08, 0.16);
    this.tone(880 * up, 'triangle', 0.14, 0.16, 0.08);
  }

  /** A portal opening: a rising shimmer. */
  portalOpen() {
    if (!this.ctx) return;
    this.blip(160, 720, 'sine', 0.7, 0.16);
    this.tone(1180, 'triangle', 0.5, 0.05, 0.25);
    this.tone(1760, 'triangle', 0.4, 0.04, 0.45);
  }
  /** A bandit stepping through: a two-note chime. */
  portalPop() { if (!this.ctx) return; this.tone(880, 'sine', 0.12, 0.13); this.tone(1320, 'sine', 0.2, 0.1, 0.06); }
  /** Punching through top speed. */
  boom() { if (!this.ctx) return; this.burst(320, 'lowpass', 0.28, 0.5, 0.005); this.blip(95, 38, 'sine', 0.32, 0.55); }

  /** A bullet whistling past: a short high crack with a falling tail. */
  whiz() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    if (t - this.lastWhiz < 0.08) return;
    this.lastWhiz = t;
    this.burst(5000, 'highpass', 0.05, 0.14, 0.002);
    this.blip(2400, 700, 'sine', 0.09, 0.08);
  }

  /** A medal: three soft rising notes, quieter than a wave clear. */
  medal() {
    if (!this.ctx) return;
    [784, 988, 1319].forEach((f, i) => this.tone(f, 'triangle', i === 2 ? 0.5 : 0.14, 0.11, i * 0.12));
  }

  waveClear() {
    if (!this.ctx) return;
    [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 'triangle', i === 3 ? 0.45 : 0.11, 0.18, i * 0.1));
    this.tone(1319, 'sine', 0.4, 0.07, 0.3);
  }

  // ---- building blocks ---------------------------------------------------------------------------------------
  /** A note: oscillator with a quick attack and exponential release. */
  tone(freq, type, dur, gain, delay = 0) {
    const ctx = this.ctx, t = ctx.currentTime + delay;
    const o = ctx.createOscillator(); o.type = type; o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + 0.008); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.bus); o.start(t); o.stop(t + dur + 0.02);
  }
  /** A pitch-sweeping note. */
  blip(f0, f1, type, dur, gain) {
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + 0.006); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.bus); o.start(t); o.stop(t + dur + 0.02);
  }
  /** A filtered noise burst. */
  burst(freq, type, dur, gain, attack) {
    const ctx = this.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource(); src.buffer = this.noise;
    src.loopStart = Math.random() * 1.5; src.loop = true;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + attack); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g); g.connect(this.bus); src.start(t, src.loopStart); src.stop(t + dur + 0.02);
  }
}
