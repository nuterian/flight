import * as THREE from 'three/webgpu';
import { MEDALS } from './medals.js';

const v = new THREE.Vector3();
const $ = (id) => document.getElementById(id);
/** What ended the run, as the debrief's headline. */
const CAUSES = { shot: ['SHOT', 'DOWN'], sea: ['INTO THE', 'SEA'], terrain: ['INTO THE', 'GROUND'], zone: ['LEFT THE', 'ZONE'] };
/** Re-adds a class so its CSS animation plays again from the start. */
const restart = (el, cls) => { el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); };

export class Hud {
  constructor() {
    this.el = {
      hud: $('hud'), score: $('score'), wave: $('wave'), enemies: $('enemies'), health: $('health'), speed: $('speed'),
      crosshair: $('crosshair'), lead: $('leadret'), markers: $('markers'), banner: $('banner'), warning: $('warning'),
      vignette: $('vignette'), title: $('title'), gameover: $('gameover'), best: $('best'), bestwave: $('bestwave'), newbest: $('newbest'), touch: $('touch'),
      portal: $('portalmark'), popups: $('popups'), hitarc: $('hitarc'), landmarks: $('landmarks'), dbmode: $('dbmode'), dbtitle: $('dbtitle'), notice: $('notice'), dbscore: document.querySelector('#gameover .scoreline'), dbtiles: $('dbtiles'), dblog: $('dblog'), dbmedal: $('dbmedal'), share: $('btn-share'), gohint: $('gohint'), medals: $('medals'), dailyinfo: $('dailyinfo'),
      healthwrap: $('healthwrap'), killfeed: $('killfeed'), combo: $('combo'), mute: $('mute'), pips: $('pips'), speedbar: $('speedbar'), btnMute: $('btn-mute'),
    };
    this.pipCount = 0;
    this.shownScore = 0;
    this.cache = {};
    this.markerPool = [];
    this.popupPool = []; this.popupsLive = [];
    this.lmarkPool = [];
    this.bannerTimer = null;
    this.flash = 0;
    this.hitFrames = 0;
    this.debrief = null;
  }

  text(key, value) {
    if (this.cache[key] === value) return;
    this.cache[key] = value;
    this.el[key].textContent = value;
  }

  showScreen(name) {
    this.el.notice.classList.add('hidden');
    this.el.title.classList.toggle('hidden', name !== 'title');
    this.el.gameover.classList.toggle('hidden', name !== 'gameover');
    this.el.hud.classList.toggle('hidden', name !== 'hud');
  }

  showTouch(show) { this.el.touch.classList.toggle('hidden', !show); }

  banner(msg, ms = 1800) {
    const b = this.el.banner;
    b.textContent = msg;
    restart(b, 'show');
    clearTimeout(this.bannerTimer);
    this.bannerTimer = setTimeout(() => b.classList.remove('show'), ms);
  }

  /** Kill feed entry: slides in under the bandit count, fades out on its own. */
  kill(text) {
    const feed = this.el.killfeed;
    const row = document.createElement('div');
    row.className = 'kf'; row.textContent = text;
    feed.prepend(row);
    while (feed.children.length > 4) feed.lastChild.remove();
    setTimeout(() => row.remove(), 2700);
  }

  /** Points that rise from a spot in the world: pooled, placed each frame by updateOverlay, gone after 1.3 s. */
  popup(worldPos, text, big = false) {
    let el = this.popupPool.pop();
    if (!el) { el = document.createElement('div'); el.className = 'popup'; this.el.popups.appendChild(el); }
    el.textContent = text; el.classList.toggle('big', big); el.style.display = 'block';
    restart(el, 'rise');
    this.popupsLive.push({ el, pos: worldPos.clone(), t: 0 });
  }

  combo(n) { const c = this.el.combo; c.textContent = `x${n} COMBO`; c.classList.add('show'); restart(c, 'pop'); }
  /** A bullet just missed: the crosshair flicks. */
  whiz() { restart(this.el.crosshair, 'whiz'); }
  comboOff() { this.el.combo.classList.remove('show'); }
  bump(key) { restart(this.el[key], 'bump'); }
  showMute(on) { this.el.mute.classList.toggle('hidden', !on); this.el.btnMute.classList.toggle('muted', on); }
  /** A short line of status under the top bar, gone after a few seconds: tilt unavailable, and the like. */
  notice(text, ms = 3500) {
    const n = this.el.notice;
    n.textContent = text; n.classList.remove('hidden');
    clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => n.classList.add('hidden'), ms);
  }

  warn(msg) {
    const w = this.el.warning;
    if (msg) { if (w.textContent !== msg) w.textContent = msg; w.classList.add('show'); } else w.classList.remove('show');
  }

  damage(amount) { this.flash = Math.min(1, this.flash + amount); restart(this.el.healthwrap, 'hurt'); }
  /** Two frames of chromatic split on the HUD text. */
  hit() { this.hitFrames = 2; }
  /** A red arc on the edge of the screen toward whoever just hit you. `angle` is radians clockwise from ahead. */
  hitFrom(angle) {
    const a = this.el.hitarc, deg = angle * 180 / Math.PI;
    a.style.background = `conic-gradient(from ${deg - 24}deg at 50% 50%, rgba(255,60,40,0.6) 0deg 48deg, transparent 48deg)`;
    restart(a, 'show');
  }

  /** One pip per bandit in the wave; downed ones dim out. */
  pips(total, alive) {
    const el = this.el.pips;
    if (total !== this.pipCount) {
      this.pipCount = total;
      el.replaceChildren(...Array.from({ length: total }, () => document.createElement('i')));
    }
    if (this.cache.pipsAlive !== alive) {
      this.cache.pipsAlive = alive;
      [...el.children].forEach((pip, k) => pip.classList.toggle('down', k >= alive));
    }
  }

  updateStats({ score, wave, enemies, total, health, maxHealth, speed, maxSpeed, boost, firing, combo = 0 }, dt) {
    // the combo window: a bar under the combo text that runs out as the chain is about to break
    const ck = Math.round(combo * 40);
    if (this.cache.combo !== ck) { this.cache.combo = ck; this.el.combo.style.setProperty('--left', `${(ck / 40 * 100).toFixed(1)}%`); }
    // the score ticks toward the real value instead of jumping
    if (this.shownScore !== score) {
      const diff = score - this.shownScore;
      this.shownScore = Math.abs(diff) < 1 ? score : this.shownScore + diff * Math.min(1, dt * 8);
    }
    this.text('score', String(Math.round(this.shownScore)));
    this.text('wave', String(wave));
    this.text('enemies', String(enemies));
    this.text('speed', String(Math.round(speed * 3)));
    this.pips(total || 0, enemies);
    const spd = Math.round(Math.min(100, speed / maxSpeed * 100));
    if (this.cache.spd !== spd) { this.cache.spd = spd; this.el.speedbar.style.width = `${spd}%`; }
    if (this.cache.boost !== boost) { this.cache.boost = boost; this.el.speedbar.classList.toggle('boost', !!boost); }
    if (this.cache.firing !== firing) { this.cache.firing = firing; this.el.crosshair.classList.toggle('fire', !!firing); }
    const pct = Math.max(0, health / maxHealth) * 100;
    const key = Math.round(pct);
    if (this.cache.health !== key) { this.cache.health = key; this.el.health.style.width = `${pct}%`; this.el.health.classList.toggle('low', pct < 35); }
    const split = this.hitFrames > 0;
    if (split) this.hitFrames--;
    if (this.cache.hit !== split) { this.cache.hit = split; this.el.hud.classList.toggle('hit', split); }
    this.flash = Math.max(0, this.flash - dt * 2.5);
    const lowPulse = pct < 35 ? 0.25 + Math.sin(performance.now() * 0.006) * 0.15 : 0;
    const a = Math.min(1, this.flash + lowPulse);
    // Opacity on a static gradient layer is composited on the GPU; a changing box-shadow would re-rasterize a
    // full-screen blur every frame.
    const vk = Math.round(a * 100);
    if (this.cache.vignette !== vk) { this.cache.vignette = vk; this.el.vignette.style.opacity = a.toFixed(2); }
  }

  /** Project world positions into HUD elements. `portal` is the open portal's position, or null. `dt` ages the popups. */
  updateOverlay(camera, player, enemies, leadPoint, locked, portal, landmarks, dt) {
    const W = innerWidth, H = innerHeight;
    // Pins an element to a world point. Off screen (or behind the camera) it is hidden, or with `edge` it is held at
    // the screen's border as an arrow turned toward the point, `spin` radians past the arrow's own angle. Returns
    // whether the point was in view.
    const pin = (el, p, edge = false, spin = 0) => {
      v.copy(p).project(camera);
      const behind = v.z > 1;
      let x = behind ? -v.x : v.x, y = behind ? -v.y : v.y;
      const inView = !behind && Math.abs(x) < 0.97 && Math.abs(y) < 0.97;
      if (!inView && !edge) { el.style.display = 'none'; return false; }
      if (!inView) { const k = 1 / Math.max(Math.abs(x), Math.abs(y)) / (Math.hypot(x, y) || 1); x *= k * 0.9; y *= k * 0.86; }
      el.style.display = 'block';
      el.style.left = `${(x + 1) * 0.5 * W}px`; el.style.top = `${(1 - y) * 0.5 * H}px`;
      if (edge) { el.classList.toggle('edge', !inView); el.style.transform = inView ? 'rotate(45deg)' : `rotate(${Math.atan2(x, y) + spin}rad)`; }
      return inView;
    };
    pin(this.el.crosshair, v.copy(player.pos).addScaledVector(player.forward, 420));
    if (leadPoint) { pin(this.el.lead, leadPoint); this.el.lead.classList.toggle('locked', locked); } else this.el.lead.style.display = 'none';

    let n = 0;
    for (const e of enemies) {
      if (!e.alive || e.absorb) continue;
      let m = this.markerPool[n];
      if (!m) {
        m = document.createElement('div'); m.className = 'marker';
        const d = document.createElement('span'); d.className = 'dist'; m.appendChild(d);
        this.el.markers.appendChild(m); this.markerPool.push(m);
      }
      n++;
      if (pin(m, e.pos, true)) {
        const dist = Math.round(e.pos.distanceTo(player.pos) * 3);
        const dEl = m.firstChild; if (dEl.textContent !== `${dist}`) dEl.textContent = `${dist}`;
      }
    }
    for (let i = n; i < this.markerPool.length; i++) this.markerPool[i].style.display = 'none';
    for (let i = this.popupsLive.length - 1; i >= 0; i--) {
      const it = this.popupsLive[i];
      it.t += dt;
      if (it.t > 1.3 || !pin(it.el, it.pos)) { it.el.style.display = 'none'; this.popupPool.push(it.el); this.popupsLive.splice(i, 1); }
    }
    // unfound landmarks within 520 units glimmer on screen; off screen they stay quiet, they are for finding
    let ln = 0;
    if (landmarks) for (const l of landmarks) {
      if (l.found || l.pos.distanceToSquared(player.pos) > 520 * 520) continue;
      let el = this.lmarkPool[ln];
      if (!el) { el = document.createElement('div'); el.className = 'lmark'; this.el.landmarks.appendChild(el); this.lmarkPool.push(el); }
      ln++;
      pin(el, l.pos);
    }
    for (let i = ln; i < this.lmarkPool.length; i++) this.lmarkPool[i].style.display = 'none';
    if (portal) pin(this.el.portal, portal, true, Math.PI * 0.75); else this.el.portal.style.display = 'none';
  }

  resetScore() {
    this.shownScore = 0; this.flash = 0; this.el.killfeed.replaceChildren(); this.comboOff();
    for (const it of this.popupsLive) { it.el.style.display = 'none'; this.popupPool.push(it.el); }
    this.popupsLive.length = 0;
  }

  /** The title's medal pips: every medal, coloured once earned, a question mark's worth of grey for secrets. */
  medals(medals) {
    const el = this.el.medals;
    if (el.children.length !== MEDALS.length) el.replaceChildren(...MEDALS.map(() => { const i = document.createElement('i'); i.className = 'pip'; return i; }));
    MEDALS.forEach((m, k) => {
      const pip = el.children[k], earned = medals.has(m.id);
      pip.classList.toggle('earned', earned);
      pip.style.background = earned ? m.color : '';
      pip.title = earned ? `${m.name} · ${m.hint}` : (m.secret ? 'A secret medal' : `${m.name} · ${m.hint}`);
    });
  }

  /** The title's "today's flight" line: the date and your best for it, or that it is still unflown. */
  daily(label, best) {
    this.el.dailyinfo.textContent = best ? `${label} · best ${best.best}` : `${label} · not flown yet`;
  }

  /**
   * The debrief: the score lands first and ticks up (the HUD score's own pattern), the flight log draws across,
   * then the six tiles land one after another, then the medal line, the new-best flag, the share button and the
   * prompt. `tickDebrief` drives it per frame. `log` is the run's events ({ t, k: 'wave' | 'kill' | 'hit', n }).
   */
  showDebrief({ mode, cause, score, waves, kills, accuracy, bestCombo, streak, aloft, medal, next, isBest, share, log = [] }) {
    this.el.dbmode.textContent = mode;
    const [a, b] = CAUSES[cause] || CAUSES.shot;
    this.el.dbtitle.innerHTML = `${a} <span>${b}</span>`;
    const rows = [this.el.dbscore, ...this.el.dbtiles.children];
    const fmt = {
      int: (v) => String(Math.round(v)), pct: (v) => `${Math.round(v)}%`, secs: (v) => `${v.toFixed(1)} s`, combo: (v) => (bestCombo > 0 ? `x${Math.round(v)}` : '\u2014'),
      time: (v) => `${Math.floor(v / 60)}:${String(Math.floor(v % 60)).padStart(2, '0')}`,
    };
    const spec = [[score, 'int'], [waves, 'int'], [kills, 'int'], [accuracy, 'pct'], [bestCombo, 'combo'], [streak, 'secs'], [aloft, 'time']];
    const items = spec.map(([target, f], i) => ({ el: rows[i], val: rows[i].firstChild, target, shown: 0, f: fmt[f], at: (i === 0 ? 0.3 : 1.2) + i * 0.16, landed: false }));
    for (const it of items) { it.el.classList.remove('in'); it.val.classList.remove('land'); it.val.textContent = it.f(0); }
    // the flight log: wave segments across the run's length, a tick up per kill, a tick down per hit taken, the end
    const lg = this.el.dblog, total = Math.max(1, aloft), pct = (t) => `${Math.min(100, t / total * 100).toFixed(2)}%`;
    lg.classList.remove('in');
    const parts = [];
    const waveStarts = log.filter((e) => e.k === 'wave');
    waveStarts.forEach((w, i) => {
      const from = w.t, to = i + 1 < waveStarts.length ? waveStarts[i + 1].t : aloft;
      parts.push(`<b style="left:${pct(from)};width:${pct(Math.max(0, to - from))}">${w.n}</b>`);
    });
    for (const e of log) if (e.k === 'kill' || e.k === 'hit') parts.push(`<i class="${e.k}" style="left:${pct(e.t)}"></i>`);
    parts.push(`<i class="end" style="left:${pct(aloft)}"></i>`);
    lg.innerHTML = parts.join('');
    const m = this.el.dbmedal, pip = m.firstChild, name = m.children[1], tag = m.lastChild;
    const shown = medal || next;
    m.classList.toggle('next', !medal);
    m.classList.toggle('hidden', !shown);
    if (shown) {
      pip.className = `pip${medal ? ' earned' : ''}`; pip.style.background = medal ? shown.color : '';
      name.textContent = medal ? `${shown.name} · ${shown.hint}` : `Next: ${shown.name} · ${shown.hint.toLowerCase()}`;
      tag.textContent = medal && medal.isNew ? 'NEW' : '';
    }
    this.el.newbest.classList.toggle('hidden', !isBest);
    this.el.share.classList.toggle('hidden', !share);
    this.el.share.classList.remove('done'); this.el.share.textContent = 'Copy result';
    this.shareText = share;
    const last = items[items.length - 1].at;
    const later = [[lg, 0.7], [m, last + 0.3], [this.el.newbest, last + 0.45], [this.el.share, last + 0.6], [this.el.gohint, last + 0.7]];
    for (const [el] of later) el.classList.remove('in');
    this.debrief = { t: 0, items, later };
    this.showScreen('gameover');
  }

  tickDebrief(dt) {
    const d = this.debrief;
    if (!d) return;
    d.t += dt;
    for (const it of d.items) {
      if (d.t < it.at) continue;
      it.el.classList.add('in');
      if (it.landed) continue;
      const diff = it.target - it.shown;
      it.shown = Math.abs(diff) < Math.max(0.5, Math.abs(it.target) * 0.01) ? it.target : it.shown + diff * Math.min(1, dt * 7);
      if (it.shown === it.target) { it.landed = true; it.val.classList.add('land'); }
      it.val.textContent = it.f(it.shown);
    }
    for (const [el, at] of d.later) if (d.t >= at) el.classList.add('in');
  }

  /** Copies the debrief's result line; the button says so for a moment. */
  async copyResult() {
    const text = this.shareText;
    if (!text) return;
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch (_) {
      try { const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select(); ok = document.execCommand('copy'); ta.remove(); } catch (__) { ok = false; }
    }
    this.el.share.textContent = ok ? 'Copied' : 'Could not copy';
    this.el.share.classList.toggle('done', ok);
    setTimeout(() => { this.el.share.textContent = 'Copy result'; this.el.share.classList.remove('done'); }, 1800);
  }
}
