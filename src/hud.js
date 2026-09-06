import * as THREE from 'three/webgpu';

const v = new THREE.Vector3();
const $ = (id) => document.getElementById(id);
/** Re-adds a class so its CSS animation plays again from the start. */
const restart = (el, cls) => { el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); };

export class Hud {
  constructor() {
    this.el = {
      hud: $('hud'), score: $('score'), wave: $('wave'), enemies: $('enemies'), health: $('health'), speed: $('speed'),
      crosshair: $('crosshair'), lead: $('leadret'), markers: $('markers'), banner: $('banner'), warning: $('warning'),
      vignette: $('vignette'), title: $('title'), gameover: $('gameover'), best: $('best'), finalscore: $('finalscore'),
      finalwave: $('finalwave'), finalkills: $('finalkills'), newbest: $('newbest'), touch: $('touch'),
      healthwrap: $('healthwrap'), killfeed: $('killfeed'), combo: $('combo'), mute: $('mute'), pips: $('pips'), speedbar: $('speedbar'), btnMute: $('btn-mute'),
    };
    this.pipCount = 0;
    this.shownScore = 0;
    this.cache = {};
    this.markerPool = [];
    this.bannerTimer = null;
    this.flash = 0;
    this.hitFrames = 0;
  }

  text(key, value) {
    if (this.cache[key] === value) return;
    this.cache[key] = value;
    this.el[key].textContent = value;
  }

  showScreen(name) {
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

  combo(n) { const c = this.el.combo; c.textContent = `x${n} COMBO`; c.classList.add('show'); restart(c, 'pop'); }
  comboOff() { this.el.combo.classList.remove('show'); }
  bump(key) { restart(this.el[key], 'bump'); }
  showMute(on) { this.el.mute.classList.toggle('hidden', !on); this.el.btnMute.classList.toggle('muted', on); }

  warn(msg) {
    const w = this.el.warning;
    if (msg) { if (w.textContent !== msg) w.textContent = msg; w.classList.add('show'); } else w.classList.remove('show');
  }

  damage(amount) { this.flash = Math.min(1, this.flash + amount); restart(this.el.healthwrap, 'hurt'); }
  /** Two frames of chromatic split on the HUD text. */
  hit() { this.hitFrames = 2; }

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

  updateStats({ score, wave, enemies, total, health, maxHealth, speed, maxSpeed, boost, firing }, dt) {
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

  /** Project world positions into HUD elements. */
  updateOverlay(camera, player, enemies, leadPoint, locked) {
    const W = innerWidth, H = innerHeight;
    const place = (el, p) => {
      v.copy(p).project(camera);
      const behind = v.z > 1;
      if (behind || Math.abs(v.x) > 1 || Math.abs(v.y) > 1) { el.style.display = 'none'; return false; }
      el.style.display = 'block';
      el.style.left = `${(v.x + 1) * 0.5 * W}px`;
      el.style.top = `${(1 - v.y) * 0.5 * H}px`;
      return true;
    };
    place(this.el.crosshair, v.copy(player.pos).addScaledVector(player.forward, 420));
    if (leadPoint) { place(this.el.lead, leadPoint); this.el.lead.classList.toggle('locked', locked); } else this.el.lead.style.display = 'none';

    let n = 0;
    for (const e of enemies) {
      if (!e.alive) continue;
      let m = this.markerPool[n];
      if (!m) {
        m = document.createElement('div'); m.className = 'marker';
        const d = document.createElement('span'); d.className = 'dist'; m.appendChild(d);
        this.el.markers.appendChild(m); this.markerPool.push(m);
      }
      n++;
      v.copy(e.pos).project(camera);
      const behind = v.z > 1;
      let x = v.x, y = v.y;
      if (behind) { x = -x; y = -y; }
      const inView = !behind && Math.abs(x) < 0.97 && Math.abs(y) < 0.97;
      m.style.display = 'block';
      if (inView) {
        m.classList.remove('edge');
        m.style.left = `${(x + 1) * 0.5 * W}px`; m.style.top = `${(1 - y) * 0.5 * H}px`;
        m.style.transform = 'rotate(45deg)';
        const dist = Math.round(e.pos.distanceTo(player.pos) * 3);
        const dEl = m.firstChild; if (dEl.textContent !== `${dist}`) dEl.textContent = `${dist}`;
      } else {
        m.classList.add('edge');
        const len = Math.hypot(x, y) || 1;
        let dx = x / len, dy = y / len;
        const k = 1 / Math.max(Math.abs(dx), Math.abs(dy));
        dx *= k * 0.9; dy *= k * 0.86;
        m.style.left = `${(dx + 1) * 0.5 * W}px`; m.style.top = `${(1 - dy) * 0.5 * H}px`;
        m.style.transform = `rotate(${Math.atan2(dx, dy)}rad)`;
      }
    }
    for (let i = n; i < this.markerPool.length; i++) this.markerPool[i].style.display = 'none';
  }

  resetScore() { this.shownScore = 0; this.flash = 0; this.el.killfeed.replaceChildren(); this.comboOff(); }

  showGameOver(score, wave, kills, isBest) {
    this.text('finalscore', String(score));
    this.text('finalwave', String(wave));
    this.text('finalkills', String(kills));
    this.el.newbest.classList.toggle('hidden', !isBest);
    this.showScreen('gameover');
  }
}
