// Mobile-first input: device tilt for pitch/roll with on-screen fire/boost buttons.
// Falls back to a virtual joystick (touch without motion sensors) and keyboard on desktop.
import * as THREE from 'three/webgpu';

export const isTouchDevice = () => (navigator.maxTouchPoints > 0 || 'ontouchstart' in window);

export class Input {
  constructor() {
    this.pitch = 0; this.roll = 0; this.yaw = 0; this.throttle = 0; this.fire = false;
    this.invertPitch = false;
    this.mode = 'keyboard';               // 'keyboard' | 'tilt' | 'stick'
    this.keys = new Set();
    this.touch = { fire: false, boost: false, brake: false, stick: null };
    this.gravity = new THREE.Vector3(0, 0, 9.8);   // smoothed, screen-oriented gravity vector
    this.neutral = { roll: 0, pitch: 0.7 };
    this.tiltRange = 0.42;                 // radians of tilt for full deflection
    this.onStart = null;                   // callback: user pressed start
    this.onMute = null;                    // callback: M pressed
    this.onAbort = null;                   // callback: Escape pressed

    window.addEventListener('keydown', (e) => {
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) e.preventDefault();
      this.keys.add(e.code);
      if (e.code === 'Enter' && this.onStart) this.onStart();
      if (e.code === 'KeyI') this.invertPitch = !this.invertPitch;
      if (e.code === 'KeyC') this.recenter();
      if (e.code === 'KeyM' && this.onMute) this.onMute();
      if (e.code === 'Escape' && this.onAbort) this.onAbort();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
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
        const a = e.accelerationIncludingGravity;
        if (!a || a.x == null) return;
        this.onMotion(a.x, a.y, a.z);
        if (!settled) { settled = true; this.mode = 'tilt'; setTimeout(() => this.recenter(), 250); resolve(true); }
      };
      window.addEventListener('devicemotion', handler);
      setTimeout(() => { if (!settled) { settled = true; window.removeEventListener('devicemotion', handler); resolve(false); } }, 1200);
    });
  }

  onMotion(x, y, z) {
    // iOS reports gravity with the opposite sign to Android/spec; normalize so z is positive when the screen faces up.
    const sign = (/iPhone|iPad|iPod/.test(navigator.userAgent) && !window.MSStream) ? -1 : 1;
    const k = 0.35;
    this.gravity.x += (x * sign - this.gravity.x) * k;
    this.gravity.y += (y * sign - this.gravity.y) * k;
    this.gravity.z += (z * sign - this.gravity.z) * k;
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

  update() {
    const k = this.keys;
    const axis = (neg, pos) => (k.has(pos) ? 1 : 0) - (k.has(neg) ? 1 : 0);
    let pitch = 0, roll = 0, yaw = 0, throttle = 0, fire = false;

    if (this.mode === 'tilt') {
      const a = this.tiltAngles();
      roll = THREE.MathUtils.clamp((a.roll - this.neutral.roll) / this.tiltRange, -1, 1);
      pitch = THREE.MathUtils.clamp((a.pitch - this.neutral.pitch) / this.tiltRange, -1, 1);
      // Dead zone with smooth response curve so a resting hand doesn't jitter the plane.
      roll = curve(roll, 0.08); pitch = curve(pitch, 0.08);
    } else if (this.mode === 'stick' && this.touch.stick) {
      roll = this.touch.stick.x; pitch = -this.touch.stick.y;
    }

    // Keyboard always works as a fallback layer, additive so a laptop with touch still plays.
    const kp = axis('ArrowDown', 'ArrowUp') + axis('KeyS', 'KeyW');
    const kr = axis('ArrowLeft', 'ArrowRight') + axis('KeyA', 'KeyD');
    yaw = axis('KeyQ', 'KeyE');
    pitch = THREE.MathUtils.clamp(pitch + kp, -1, 1);
    roll = THREE.MathUtils.clamp(roll + kr, -1, 1);
    if (this.invertPitch) pitch = -pitch;

    throttle = (k.has('ShiftLeft') || k.has('ShiftRight') || this.touch.boost) ? 1 : ((k.has('ControlLeft') || k.has('ControlRight') || this.touch.brake) ? -1 : 0);
    fire = k.has('Space') || this.touch.fire;

    this.pitch = pitch; this.roll = roll; this.yaw = yaw; this.throttle = throttle; this.fire = fire;
  }
}

function curve(v, dead) {
  const a = Math.abs(v);
  if (a < dead) return 0;
  const t = (a - dead) / (1 - dead);
  return Math.sign(v) * (t * t * (3 - 2 * t) * 0.6 + t * 0.4);
}
