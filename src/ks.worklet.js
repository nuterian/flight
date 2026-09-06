// A plucked string (Karplus-Strong) as an AudioWorklet: a burst of noise circling a fractionally tuned delay line
// through a one-pole damping filter. It lives in a worklet because Web Audio forces a 128-sample minimum on any
// node feedback cycle, which would put every string above ~345 Hz out of tune.
class KS extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { freq, level, feedback, brightness, dur, start } = options.processorOptions;
    // the two-tap damping filter adds about `brightness` samples of delay; take it out of the period so the string is in tune
    this.period = sampleRate / freq - brightness;
    this.n = Math.ceil(this.period) + 2;
    this.buf = new Float32Array(this.n);
    for (let i = 0; i < this.n; i++) this.buf[i] = (Math.random() * 2 - 1) * level;
    this.w = 0;
    this.fb = feedback; this.b = brightness;   // brightness 0..0.5: 0.5 = full two-tap low-pass, 0 = none
    this.start = start; this.stop = start + dur;
    this.last = 0;
  }
  process(inputs, outputs) {
    const out = outputs[0][0];
    if (currentTime < this.start) { out.fill(0); return true; }
    if (currentTime > this.stop) return false;
    const n = this.n, buf = this.buf, P = this.period, b = this.b, fb = this.fb;
    for (let k = 0; k < out.length; k++) {
      // fractional read one period behind the write head
      let r = this.w - P; if (r < 0) r += n;
      const i0 = r | 0, i1 = (i0 + 1) % n, frac = r - i0;
      const x = buf[i0] * (1 - frac) + buf[i1] * frac;
      const y = fb * ((1 - b) * x + b * this.last);
      this.last = x;
      buf[this.w] = y;
      out[k] = y;
      this.w = (this.w + 1) % n;
    }
    return true;
  }
}
registerProcessor('ks', KS);
