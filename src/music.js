// The music engine: a look-ahead sequencer on the game's Web Audio graph plus a bank of modelled instruments.
// Scores (see scores.js) are plain objects: tempo, swing, length in bars and an `at(m, bar, step, t)` callback that
// plays notes on this engine. Nothing is a file; every sound is synthesised, and the loop has no seam.
const rnd = (a, b) => a + Math.random() * (b - a);
export const f = (midi) => 440 * Math.pow(2, (midi - 69) / 12);

export class Music {
  constructor(sound, score) { this.sound = sound; this.score = score; this.playing = false; this.timer = null; this.ready = false; }
  get STEP() { return 60 / this.score.bpm / 4; }

  /** Scales the theme's level while it plays: full on the title, ducked under the engine in play. */
  setLevel(scale) {
    this.scale = scale;
    if (this.playing && this.out) this.out.gain.setTargetAtTime((this.score.level ?? 0.5) * scale, this.sound.ctx.currentTime, 0.6);
  }

  setScore(score) {
    if (score === this.score) return;
    const was = this.playing;
    if (was) this.stop(true);
    this.score = score;
    if (was) this.play();
  }

  setup() {
    const ctx = this.sound.ctx;
    if (this.ready || !ctx) return;
    this.ready = true;
    this.out = ctx.createGain(); this.out.gain.value = 0; this.out.connect(this.sound.master);
    // a big soft room, and a tempo-synced echo that only some voices go through
    const ir = ctx.createBuffer(2, ctx.sampleRate * 2.6, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) { const d = ir.getChannelData(ch); for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 2.8) * (i < 2000 ? i / 2000 : 1); }
    this.verb = ctx.createConvolver(); this.verb.buffer = ir;
    const verbOut = ctx.createGain(); verbOut.gain.value = 0.36; this.verb.connect(verbOut); verbOut.connect(this.out);
    this.echo = ctx.createDelay(1); this.echo.delayTime.value = 0.3;
    const fb = ctx.createGain(); fb.gain.value = 0.28;
    const fbLp = ctx.createBiquadFilter(); fbLp.type = 'lowpass'; fbLp.frequency.value = 1800;
    this.echo.connect(fbLp); fbLp.connect(fb); fb.connect(this.echo);
    const echoOut = ctx.createGain(); echoOut.gain.value = 0.16; this.echo.connect(echoOut); echoOut.connect(this.verb); echoOut.connect(this.out);
    const len = ctx.sampleRate, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noise = buf;
    // the string model lives in a worklet; until it has loaded, strings fall back to a resonant pluck
    this.ks = false;
    if (ctx.audioWorklet) ctx.audioWorklet.addModule(new URL('./ks.worklet.js', import.meta.url)).then(() => { this.ks = true; }).catch((e) => console.warn('string worklet unavailable', e));
  }

  play() {
    const ctx = this.sound.ctx;
    if (!ctx) return;
    this.setup();
    if (this.playing) return;
    this.playing = true;
    this.echo.delayTime.value = this.STEP * 6;
    this.out.gain.cancelScheduledValues(ctx.currentTime);
    this.out.gain.setTargetAtTime((this.score.level ?? 0.5) * (this.scale ?? 1), ctx.currentTime, 0.8);
    this.step = 0; this.next = ctx.currentTime + 0.15;
    clearInterval(this.timer);
    this.timer = setInterval(() => this.pump(), 100);
    this.pump();
  }

  stop(fast = false) {
    if (!this.playing) return;
    this.playing = false;
    const ctx = this.sound.ctx;
    this.out.gain.setTargetAtTime(0, ctx.currentTime, fast ? 0.08 : 0.35);
    clearInterval(this.timer); this.timer = null;
  }

  /** Look-ahead scheduler: books every note up to a second ahead, so a throttled background timer never leaves a gap. */
  pump() {
    const ctx = this.sound.ctx, sc = this.score, STEP = this.STEP;
    while (this.next < ctx.currentTime + 1.0) {
      const bar = Math.floor(this.step / 16), s = this.step % 16;
      // human time: swing the offbeat eighths, then drift a little
      const t = this.next + (s % 4 === 2 ? STEP * (sc.swing || 0) * 2 : 0) + rnd(-(sc.drift ?? 0.012), sc.drift ?? 0.012);
      sc.at(this, bar, s, t);
      this.step = (this.step + 1) % (sc.bars * 16);
      this.next += STEP;
    }
  }

  // ---- instruments (shared by every score) ---------------------------------------------------------------------
  /** A plucked string: the worklet Karplus-Strong model, or a resonant noise pluck if the worklet is not available. */
  string(freq, t, level, brightness, feedback, dur) {
    const ctx = this.sound.ctx;
    if (this.ks) {
      const node = new AudioWorkletNode(ctx, 'ks', { numberOfInputs: 0, outputChannelCount: [1], processorOptions: { freq, level, feedback, brightness, dur: dur + 0.5, start: t } });
      const out = ctx.createGain(); out.gain.setValueAtTime(1, t); out.gain.setValueAtTime(1, t + dur); out.gain.linearRampToValueAtTime(0, t + dur + 0.4);
      node.connect(out);
      return out;
    }
    const n = ctx.createBufferSource(); n.buffer = this.noise; n.loop = true; n.loopStart = Math.random() * 0.5;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = freq; bp.Q.value = 40;
    const out = ctx.createGain(); out.gain.setValueAtTime(level * 6, t); out.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    n.connect(bp); bp.connect(out); n.start(t, n.loopStart); n.stop(t + dur + 0.05);
    return out;
  }
  strum(midis, t, level, up) {
    const order = up ? [...midis].reverse() : midis;
    order.forEach((m, k) => { const o = this.string(f(m), t + k * rnd(0.012, 0.02), 0.09 * level, 0.3, 0.992, 1.0); o.connect(this.out); o.connect(this.verb); });
  }
  upright(freq, t, level) {
    const o = this.string(freq, t, 0.5 * level, 0.5, 0.996, 1.4);
    const ctx = this.sound.ctx;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900;
    o.connect(lp); lp.connect(this.out);
    // a sine under it for the body
    const sub = ctx.createOscillator(); sub.type = 'sine'; sub.frequency.value = freq;
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.12 * level, t + 0.03); g.gain.exponentialRampToValueAtTime(0.0001, t + 1.2);
    sub.connect(g); g.connect(this.out); sub.start(t); sub.stop(t + 1.25);
  }
  /** FM electric piano: a bright tine transient over a warm body. */
  epiano(freq, t, dur, level) {
    const ctx = this.sound.ctx;
    const car = ctx.createOscillator(), mod = ctx.createOscillator(), body = ctx.createOscillator(), bmod = ctx.createOscillator();
    car.type = mod.type = body.type = bmod.type = 'sine';
    car.frequency.value = freq; mod.frequency.value = freq * 14; body.frequency.value = freq; bmod.frequency.value = freq;
    const mi = ctx.createGain(); mi.gain.setValueAtTime(freq * 0.7, t); mi.gain.exponentialRampToValueAtTime(freq * 0.02, t + 0.06);
    const bi = ctx.createGain(); bi.gain.setValueAtTime(freq * 0.6, t); bi.gain.exponentialRampToValueAtTime(freq * 0.08, t + 0.8);
    mod.connect(mi); mi.connect(car.frequency); bmod.connect(bi); bi.connect(body.frequency);
    const g = ctx.createGain(), hold = Math.min(dur, 1.6);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(level, t + 0.006);
    g.gain.exponentialRampToValueAtTime(level * 0.45, t + 0.35); g.gain.setValueAtTime(level * 0.45 * Math.max(0.2, 1 - hold / 2.2), t + hold);
    g.gain.exponentialRampToValueAtTime(0.0001, t + hold + 0.25);
    const cg = ctx.createGain(); cg.gain.value = 0.3; const bgn = ctx.createGain(); bgn.gain.value = 0.8;
    car.connect(cg); body.connect(bgn); cg.connect(g); bgn.connect(g); g.connect(this.out); g.connect(this.verb);
    for (const o of [car, mod, body, bmod]) { o.start(t); o.stop(t + hold + 0.3); }
  }
  /** Flute: a near-sine with a little second harmonic, breath noise and vibrato that arrives late. */
  flute(freq, t, dur, level) {
    const ctx = this.sound.ctx;
    const o = ctx.createOscillator(), o2 = ctx.createOscillator(); o.type = 'sine'; o2.type = 'sine';
    o.frequency.value = freq; o2.frequency.value = freq * 2;
    const lfo = ctx.createOscillator(), lg = ctx.createGain(); lfo.frequency.value = 5.2; lg.gain.setValueAtTime(0, t); lg.gain.linearRampToValueAtTime(freq * 0.006, t + 0.35);
    lfo.connect(lg); lg.connect(o.frequency); lg.connect(o2.frequency);
    const n = ctx.createBufferSource(); n.buffer = this.noise; n.loop = true; n.loopStart = Math.random() * 0.5;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = freq; bp.Q.value = 12;
    const ng = ctx.createGain(); ng.gain.value = 0.1;
    const g2 = ctx.createGain(); g2.gain.value = 0.18;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(level, t + 0.07); g.gain.setValueAtTime(level, t + dur - 0.05); g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.1);
    o.connect(g); o2.connect(g2); g2.connect(g); n.connect(bp); bp.connect(ng); ng.connect(g);
    g.connect(this.out); g.connect(this.echo); g.connect(this.verb);
    o.start(t); o2.start(t); lfo.start(t); n.start(t, n.loopStart);
    for (const x of [o, o2, lfo, n]) x.stop(t + dur + 0.15);
  }
  /** Strings: three detuned saws through a slowly breathing low-pass, swelling in. */
  strings(freq, t, dur) {
    const ctx = this.sound.ctx;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.setValueAtTime(600, t); lp.frequency.linearRampToValueAtTime(1000, t + dur * 0.5); lp.frequency.linearRampToValueAtTime(650, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.02, t + 0.9); g.gain.setValueAtTime(0.02, t + dur - 0.5); g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.1);
    for (const det of [-9, 0, 8]) { const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = freq; o.detune.value = det; o.connect(lp); o.start(t); o.stop(t + dur + 0.15); }
    lp.connect(g); g.connect(this.out); g.connect(this.verb);
  }
  kick(t, level) {
    const ctx = this.sound.ctx;
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(120, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.14);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(level, t + 0.006); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
    o.connect(g); g.connect(this.out); o.start(t); o.stop(t + 0.35);
  }
  /** A brush on the snare: a soft swell of band-passed noise rather than a crack. */
  brush(t, level) {
    const ctx = this.sound.ctx;
    const n = ctx.createBufferSource(); n.buffer = this.noise; n.loop = true; n.loopStart = Math.random() * 0.5;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1500; bp.Q.value = 0.7;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t - 0.02 > 0 ? t - 0.02 : t); g.gain.exponentialRampToValueAtTime(level, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    n.connect(bp); bp.connect(g); g.connect(this.out); g.connect(this.verb);
    n.start(t, n.loopStart); n.stop(t + 0.3);
  }
  shaker(t, level) {
    const ctx = this.sound.ctx;
    const n = ctx.createBufferSource(); n.buffer = this.noise; n.loop = true; n.loopStart = Math.random() * 0.5;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 4800; bp.Q.value = 1.2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(level, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    n.connect(bp); bp.connect(g); g.connect(this.out); n.start(t, n.loopStart); n.stop(t + 0.12);
  }

  /** Synth brass: three detuned saws with a filter that opens on the attack, a touch of vibrato, an octave sub. */
  brass(freq, t, dur, level) {
    const ctx = this.sound.ctx;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 2;
    lp.frequency.setValueAtTime(700, t); lp.frequency.exponentialRampToValueAtTime(3400, t + 0.06); lp.frequency.exponentialRampToValueAtTime(1900, t + 0.5);
    const lfo = ctx.createOscillator(), lg = ctx.createGain(); lfo.frequency.value = 5.5; lg.gain.setValueAtTime(0, t); lg.gain.linearRampToValueAtTime(6, t + 0.3);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(level, t + 0.03); g.gain.setValueAtTime(level, t + dur - 0.05); g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.08);
    for (const det of [-8, 0, 7]) { const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = freq; o.detune.value = det; lg.connect(o.detune); o.connect(lp); o.start(t); o.stop(t + dur + 0.12); }
    const sub = ctx.createOscillator(); sub.type = 'triangle'; sub.frequency.value = freq / 2; const sg = ctx.createGain(); sg.gain.value = 0.5; sub.connect(sg); sg.connect(lp); sub.start(t); sub.stop(t + dur + 0.12);
    lfo.start(t); lfo.stop(t + dur + 0.12);
    lp.connect(g); g.connect(this.out); g.connect(this.verb);
  }
  /** Staccato strings: a short bright saw stab for ostinatos. */
  stab(freq, t, level, dur = 0.12) {
    const ctx = this.sound.ctx;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.setValueAtTime(2600, t); lp.frequency.exponentialRampToValueAtTime(900, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(level, t + 0.008); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    for (const det of [-6, 6]) { const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = freq; o.detune.value = det; o.connect(lp); o.start(t); o.stop(t + dur + 0.02); }
    lp.connect(g); g.connect(this.out); g.connect(this.verb);
  }
  /** Driving bass: saw through a plucked low-pass with a sine under it. */
  drive(freq, t, level, dur = 0.22) {
    const ctx = this.sound.ctx;
    const o = ctx.createOscillator(), sub = ctx.createOscillator(); o.type = 'sawtooth'; sub.type = 'sine';
    o.frequency.value = freq; sub.frequency.value = freq;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 3; lp.frequency.setValueAtTime(1400, t); lp.frequency.exponentialRampToValueAtTime(220, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(level, t + 0.006); g.gain.setValueAtTime(level, t + dur * 0.6); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const sg = ctx.createGain(); sg.gain.value = 0.8;
    o.connect(lp); sub.connect(sg); sg.connect(lp); lp.connect(g); g.connect(this.out);
    o.start(t); sub.start(t); o.stop(t + dur + 0.02); sub.stop(t + dur + 0.02);
  }
  /** Timpani: a long tuned thump. */
  timpani(freq, t, level) {
    const ctx = this.sound.ctx;
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(freq * 1.6, t); o.frequency.exponentialRampToValueAtTime(freq, t + 0.06);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(level, t + 0.008); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
    const n = ctx.createBufferSource(); n.buffer = this.noise; n.loop = true; n.loopStart = Math.random() * 0.5;
    const bp = ctx.createBiquadFilter(); bp.type = 'lowpass'; bp.frequency.value = 500;
    const ng = ctx.createGain(); ng.gain.setValueAtTime(level * 0.5, t); ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
    o.connect(g); g.connect(this.out); g.connect(this.verb); n.connect(bp); bp.connect(ng); ng.connect(this.out);
    o.start(t); o.stop(t + 1); n.start(t, n.loopStart); n.stop(t + 0.1);
  }
  /** A rock kick: a hard click and a fast pitch drop. */
  bigKick(t, level) {
    const ctx = this.sound.ctx;
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(190, t); o.frequency.exponentialRampToValueAtTime(48, t + 0.09);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(level, t + 0.003); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    o.connect(g); g.connect(this.out); o.start(t); o.stop(t + 0.32);
    const n = ctx.createBufferSource(); n.buffer = this.noise; n.loop = true; n.loopStart = Math.random() * 0.5;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 2500;
    const ng = ctx.createGain(); ng.gain.setValueAtTime(level * 0.35, t); ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.02);
    n.connect(hp); hp.connect(ng); ng.connect(this.out); n.start(t, n.loopStart); n.stop(t + 0.03);
  }
  /** A snare with a body and a crack, into the room. */
  snare(t, level) {
    const ctx = this.sound.ctx;
    const n = ctx.createBufferSource(); n.buffer = this.noise; n.loop = true; n.loopStart = Math.random() * 0.5;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2200; bp.Q.value = 0.6;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(level, t + 0.003); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    n.connect(bp); bp.connect(g); g.connect(this.out); g.connect(this.verb);
    const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.setValueAtTime(240, t); o.frequency.exponentialRampToValueAtTime(150, t + 0.06);
    const og = ctx.createGain(); og.gain.setValueAtTime(level * 0.7, t); og.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    o.connect(og); og.connect(this.out);
    n.start(t, n.loopStart); n.stop(t + 0.22); o.start(t); o.stop(t + 0.1);
  }
  hat(t, dur, level) {
    const ctx = this.sound.ctx;
    const n = ctx.createBufferSource(); n.buffer = this.noise; n.loop = true; n.loopStart = Math.random() * 0.5;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 7500;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(level, t + 0.002); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    n.connect(hp); hp.connect(g); g.connect(this.out); n.start(t, n.loopStart); n.stop(t + dur + 0.02);
  }
  crash(t, level) {
    const ctx = this.sound.ctx;
    const n = ctx.createBufferSource(); n.buffer = this.noise; n.loop = true; n.loopStart = Math.random() * 0.5;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 4000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(level, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + 1.6);
    n.connect(hp); hp.connect(g); g.connect(this.out); g.connect(this.verb); n.start(t, n.loopStart); n.stop(t + 1.7);
  }
  tom(freq, t, level) {
    const ctx = this.sound.ctx;
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(freq * 1.4, t); o.frequency.exponentialRampToValueAtTime(freq, t + 0.08);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(level, t + 0.005); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    o.connect(g); g.connect(this.out); g.connect(this.verb); o.start(t); o.stop(t + 0.4);
  }
  /** An engine-like drone: two low saws beating slowly under a lazy low-pass. Held for `dur`. */
  drone(freq, t, dur, level) {
    const ctx = this.sound.ctx;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.setValueAtTime(220, t); lp.frequency.linearRampToValueAtTime(700, t + dur); lp.Q.value = 1.5;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(level, t + 0.6); g.gain.setValueAtTime(level, t + dur - 0.2); g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.1);
    for (const det of [-4, 5]) { const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = freq; o.detune.value = det; o.connect(lp); o.start(t); o.stop(t + dur + 0.15); }
    lp.connect(g); g.connect(this.out);
  }
  /** A riser: filtered noise sweeping up over `dur`, for the bar before a drop. */
  riser(t, dur, level) {
    const ctx = this.sound.ctx;
    const n = ctx.createBufferSource(); n.buffer = this.noise; n.loop = true;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.2; bp.frequency.setValueAtTime(300, t); bp.frequency.exponentialRampToValueAtTime(6000, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(level, t + dur); g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.05);
    n.connect(bp); bp.connect(g); g.connect(this.out); n.start(t); n.stop(t + dur + 0.1);
  }
}
