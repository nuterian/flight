// Mobile-first input: device tilt for pitch/roll with on-screen fire/boost buttons.
// Falls back to a virtual joystick (touch without motion sensors) and keyboard on desktop.
import * as THREE from 'three/webgpu';

export const isTouchDevice = () => (navigator.maxTouchPoints > 0 || 'ontouchstart' in window);

/** How quick the controls are, chosen on the title and remembered. `k` scales how fast a held key builds to full
 *  stick and how little tilt it takes; Normal is the default. */
export const SENSITIVITY = [{ name: 'Gentle', k: 0.75 }, { name: 'Normal', k: 1 }, { name: 'Quick', k: 1.3 }];
const RAMP = 3.4;          // a held key builds to full stick at this rate a second at Normal (about a third of a second)
const TILT_RANGE = 0.52;   // radians of tilt for full deflection at Normal (30 degrees)

export class Input {
  constructor() {
    this.pitch = 0; this.roll = 0; this.yaw = 0; this.throttle = 0; this.fire = false; this.lock = false;
    this.invertPitch = false;
    this.mode = 'keyboard';               // 'keyboard' | 'tilt' | 'stick'
    this.keys = new Set();
    this.touch = { fire: false, boost: false, brake: false, lock: false, stick: null };
    this.gravity = new THREE.Vector3(0, 0, 9.8);   // smoothed, screen-oriented gravity vector
    this.neutral = { roll: 0, pitch: 0.7 };
    this.sens = SENSITIVITY[1];
    this.kb = { pitch: 0, roll: 0, yaw: 0 };   // the keyboard's stick, ramped toward the keys (see update)
    // the tilt's gravity, smoothed by a One Euro filter per axis: steady when the phone is held still, quick when it moves
    this.grav = [0, 1, 2].map(() => ({ x: 0, dx: 0, t: 0 }));
    this.onStart = null;                   // callback: user pressed start
    this.onMute = null;                    // callback: M pressed
    this.onAbort = null;                   // callback: Escape pressed
    this.onDaily = null;                   // callback: T pressed (today's flight)

    window.addEventListener('keydown', (e) => {
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) e.preventDefault();
      this.keys.add(e.code);
      if (e.code === 'Enter' && this.onStart) this.onStart();
      if (e.code === 'KeyI') this.invertPitch = !this.invertPitch;
      if (e.code === 'KeyC') this.recenter();
      if (e.code === 'KeyM' && this.onMute) this.onMute();
      if (e.code === 'Escape' && this.onAbort) this.onAbort();
      if (e.code === 'KeyT' && this.onDaily) this.onDaily();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    this.padButtons = 0;   // last frame's pressed mask, for edge-triggered pad buttons
  }

  /** The first connected gamepad, folded into the same axes the keyboard feeds: left stick flies, right trigger or
   *  A fires, left trigger or X boosts, B brakes, Y locks a missile on, bumpers are the rudder, Start starts, Back quits
   *  and the d-pad's down mutes. */
  pad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : null;
    let gp = null;
    if (pads) for (const g of pads) if (g && g.connected) { gp = g; break; }
    if (!gp) return null;
    const b = (i) => (gp.buttons[i] ? (gp.buttons[i].value > 0.4 || gp.buttons[i].pressed) : false);
    const roll = curve(gp.axes[0] || 0, 0.12), pitch = curve(-(gp.axes[1] || 0), 0.12);
    const mask = (b(9) ? 1 : 0) | (b(8) ? 2 : 0) | (b(13) ? 4 : 0);
    const rose = mask & ~this.padButtons;
    this.padButtons = mask;
    if (rose & 1 && this.onStart) this.onStart();
    if (rose & 2 && this.onAbort) this.onAbort();
    if (rose & 4 && this.onMute) this.onMute();
    return { roll, pitch, yaw: (b(5) ? 1 : 0) - (b(4) ? 1 : 0), fire: b(7) || b(0), boost: b(6) || b(2), brake: b(1), lock: b(3) };
  }

  /** Must be called from a user gesture (tap). Requests motion permission on iOS. */
  async enableMotion() {
    if (!isTouchDevice()) return false;
    try {
      if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
        const res = await DeviceMotionEvent.requestPermission();
        if (res !== 'granted') return false;
      }
    } catch (err) {
      return false;
    }
    return new Promise((resolve) => {
      let settled = false;
      const handler = (e) => {
        const a = e.accelerationIncludingGravity, lin = e.acceleration;
        if (!a || a.x == null) return;
        // the phone's own fusion (gyro and accelerometer) separates the hand's motion from gravity where it can, so a
        // jolt of the hands does not read as tilt
        if (lin && lin.x != null) this.onMotion(a.x - lin.x, a.y - lin.y, a.z - lin.z, e.timeStamp);
        else this.onMotion(a.x, a.y, a.z, e.timeStamp);
        if (!settled) { settled = true; this.mode = 'tilt'; setTimeout(() => this.recenter(), 250); resolve(true); }
      };
      window.addEventListener('devicemotion', handler);
      setTimeout(() => { if (!settled) { settled = true; window.removeEventListener('devicemotion', handler); resolve(false); } }, 2000);
    });
  }

  onMotion(x, y, z, ms = performance.now()) {
    // iOS reports gravity with the opposite sign to Android/spec; normalize so z is positive when the screen faces up.
    const sign = (/iPhone|iPad|iPod/.test(navigator.userAgent) && !window.MSStream) ? -1 : 1;
    this.gravity.set(oneEuro(this.grav[0], x * sign, ms), oneEuro(this.grav[1], y * sign, ms), oneEuro(this.grav[2], z * sign, ms));
  }

  /**
   * Screen frame expressed in device axes: which device direction is "screen up" and "screen right".
   * Derived from gravity at calibration time (the top edge of a hand-held phone is higher than the bottom),
   * so it works in any landscape/portrait grip without trusting screen.orientation quirks.
   */
  computeFrame() {
    const g = this.gravity;
    const inPlane = Math.hypot(g.x, g.y);
    let ux, uy;
    if (inPlane > 1.5) { ux = g.x / inPlane; uy = g.y / inPlane; }
    else {
      const angle = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
      const rad = THREE.MathUtils.degToRad(angle);
      ux = -Math.sin(rad); uy = Math.cos(rad);
    }
    this.frame = { ux, uy, rx: uy, ry: -ux };
  }

  tiltAngles() {
    const g = this.gravity, f = this.frame || (this.computeFrame(), this.frame);
    const sx = g.x * f.rx + g.y * f.ry;   // component toward screen-right
    const sy = g.x * f.ux + g.y * f.uy;   // component toward screen-up
    const gz = Math.max(0.5, g.z);
    // roll: tilt the phone like a steering wheel. pitch: tip the top edge toward you to climb.
    return { roll: Math.atan2(-sx, gz), pitch: Math.atan2(sy, gz) };
  }

  recenter() {
    if (this.mode === 'tilt') { this.computeFrame(); this.neutral = this.tiltAngles(); }
  }

  useStickFallback() { this.mode = 'stick'; }

  /** `dt` is the frame's length in seconds. */
  update(dt = 1 / 60) {
    const k = this.keys, sens = this.sens.k;
    const axis = (neg, pos) => (k.has(pos) ? 1 : 0) - (k.has(neg) ? 1 : 0);
    // A key is not a full stick the instant it goes down: it builds to full over about a third of a second, so a tap
    // nudges the nose a couple of degrees and a hold still turns as hard as ever. Letting go, or reversing, is quick.
    const ramp = (name, want) => {
      let v = this.kb[name];
      if (want === 0 || want * v < 0) v = Math.abs(v) <= dt * 12 ? 0 : v - Math.sign(v) * dt * 12;
      if (want !== 0 && want * v >= 0) v = THREE.MathUtils.clamp(v + want * dt * RAMP * sens, -1, 1);
      return (this.kb[name] = v);
    };
    let pitch = 0, roll = 0, yaw = 0, throttle = 0, fire = false;

    if (this.mode === 'tilt') {
      const a = this.tiltAngles();
      const range = TILT_RANGE / sens;
      roll = THREE.MathUtils.clamp((a.roll - this.neutral.roll) / range, -1, 1);
      pitch = THREE.MathUtils.clamp((a.pitch - this.neutral.pitch) / range, -1, 1);
      // Dead zone with smooth response curve so a resting hand doesn't jitter the plane.
      roll = curve(roll, 0.08); pitch = curve(pitch, 0.08);
    } else if (this.mode === 'stick' && this.touch.stick) {
      roll = this.touch.stick.x; pitch = -this.touch.stick.y;
    }

    // Keyboard always works as a fallback layer, additive so a laptop with touch still plays. A gamepad too.
    const gp = this.pad();
    const sign = (v) => Math.sign(v);
    const kp = ramp('pitch', sign(axis('ArrowDown', 'ArrowUp') + axis('KeyS', 'KeyW'))) + (gp ? gp.pitch : 0);
    const kr = ramp('roll', sign(axis('ArrowLeft', 'ArrowRight') + axis('KeyA', 'KeyD'))) + (gp ? gp.roll : 0);
    yaw = THREE.MathUtils.clamp(ramp('yaw', axis('KeyQ', 'KeyE')) + (gp ? gp.yaw : 0), -1, 1);
    pitch = THREE.MathUtils.clamp(pitch + kp, -1, 1);
    roll = THREE.MathUtils.clamp(roll + kr, -1, 1);
    if (this.invertPitch) pitch = -pitch;

    throttle = (k.has('ShiftLeft') || k.has('ShiftRight') || this.touch.boost || (gp && gp.boost)) ? 1 : ((k.has('ControlLeft') || k.has('ControlRight') || this.touch.brake || (gp && gp.brake)) ? -1 : 0);
    fire = k.has('Space') || this.touch.fire || !!(gp && gp.fire);
    this.lock = k.has('KeyF') || this.touch.lock || !!(gp && gp.lock);

    this.pitch = pitch; this.roll = roll; this.yaw = yaw; this.throttle = throttle; this.fire = fire;
  }
}

/** One Euro filter step (Casiez et al.): a low-pass whose cutoff rises with the signal's speed, so a still hand is
 *  smoothed hard and a deliberate tilt comes through without lag. `f` keeps the state; `ms` is the sample's time. */
function oneEuro(f, x, ms, minCutoff = 1, beta = 0.1, dCutoff = 1) {
  const dt = f.t ? Math.min(0.1, Math.max(1e-3, (ms - f.t) / 1000)) : 0;
  f.t = ms;
  if (!dt) { f.x = x; f.dx = 0; return x; }
  const alpha = (fc) => 1 / (1 + 1 / (2 * Math.PI * fc * dt));
  f.dx += alpha(dCutoff) * ((x - f.x) / dt - f.dx);
  f.x += alpha(minCutoff + beta * Math.abs(f.dx)) * (x - f.x);
  return f.x;
}

function curve(v, dead) {
  const a = Math.abs(v);
  if (a < dead) return 0;
  const t = (a - dead) / (1 - dead);
  return Math.sign(v) * (t * t * (3 - 2 * t) * 0.6 + t * 0.4);
}
