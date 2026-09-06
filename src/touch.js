// Wires on-screen touch controls (fire, boost, recenter, virtual stick) into the Input object.
export function bindTouch(input, els) {
  const hold = (el, key) => {
    const on = (e) => {
      e.preventDefault(); input.touch[key] = true; el.classList.add('down');
      // press feedback: a ring pulse and a tick of haptics where the phone allows it
      el.classList.remove('tap'); void el.offsetWidth; el.classList.add('tap');
      try { navigator.vibrate?.(12); } catch (_) { /* optional */ }
      try { el.setPointerCapture(e.pointerId); } catch (_) { /* noop */ }
    };
    const off = (e) => { e.preventDefault(); input.touch[key] = false; el.classList.remove('down'); };
    el.addEventListener('pointerdown', on);
    el.addEventListener('pointerup', off);
    el.addEventListener('pointercancel', off);
    el.addEventListener('lostpointercapture', off);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  };
  hold(els.fire, 'fire');
  hold(els.boost, 'boost');
  els.recenter.addEventListener('pointerdown', (e) => { e.preventDefault(); input.recenter(); els.recenter.classList.add('spin'); setTimeout(() => els.recenter.classList.remove('spin'), 400); });

  // Virtual stick: appears wherever the thumb lands in the left zone (only in stick mode).
  const zone = els.stickZone, base = els.stickBase, knob = els.stickKnob;
  let active = null, ox = 0, oy = 0;
  const R = 58;
  zone.addEventListener('pointerdown', (e) => {
    if (input.mode !== 'stick' || active !== null) return;
    e.preventDefault();
    active = e.pointerId; ox = e.clientX; oy = e.clientY;
    base.style.left = `${ox}px`; base.style.top = `${oy}px`; base.classList.add('show');
    knob.style.transform = 'translate(0px,0px)';
    input.touch.stick = { x: 0, y: 0 };
    try { zone.setPointerCapture(e.pointerId); } catch (_) { /* synthetic events */ }
  });
  zone.addEventListener('pointermove', (e) => {
    if (e.pointerId !== active) return;
    let dx = e.clientX - ox, dy = e.clientY - oy;
    const len = Math.hypot(dx, dy);
    if (len > R) { dx *= R / len; dy *= R / len; }
    knob.style.transform = `translate(${dx}px,${dy}px)`;
    input.touch.stick = { x: dx / R, y: dy / R };
  });
  const end = (e) => {
    if (e.pointerId !== active) return;
    active = null; input.touch.stick = null; base.classList.remove('show');
  };
  zone.addEventListener('pointerup', end);
  zone.addEventListener('pointercancel', end);
}
