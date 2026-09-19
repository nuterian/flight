import * as THREE from 'three/webgpu';
import { pass, mrt, output, emissive, vec2, vec3, vec4, float, screenUV, smoothstep, mix, luminance, color, Fn, If, Loop, length } from 'three/tsl';
import { gaussianBlur } from 'three/addons/tsl/display/GaussianBlurNode.js';
import { createWorld } from './world.js';
import { LIGHTS } from './times.js';
import { prepared } from './prepare.js';
import { Boxes } from './boxes.js';
import { Input, isTouchDevice } from './input.js';
import { bindTouch } from './touch.js';
import { Hud } from './hud.js';
import { Game } from './game.js';
import { Title } from './title.js';
import { Music } from './music.js';
import { TRACKS } from './scores.js';
import { store } from './audio.js';
import { dailySeed } from './daily.js';

const $ = (id) => document.getElementById(id);
const touch = isTouchDevice();
const mobile = touch && Math.min(innerWidth, innerHeight) < 900;
// `?perf` in the address (or P at any time) shows the frame meter.
const PERF = new URLSearchParams(location.search).has('perf');

async function boot() {
  // The start, timed: a line in the console once the first frame is really on the screen, and on the screen itself
  // with `?perf`, so how long the wait was (and on what) can be read without opening anything.
  const marks = [`script ${Math.round(performance.now())}`], mark = (what) => marks.push(`${what} ${Math.round(performance.now())}`);
  const canvas = $('game');
  // No antialiasing on the canvas itself: the only thing ever drawn to it is the post pipeline's full-screen quad, and
  // four samples of a quad are four times the bandwidth for the same picture. The scene pass below asks for its own.
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: false, powerPreference: 'high-performance', trackTimestamp: import.meta.env.DEV });
  await renderer.init();
  mark('renderer');
  // If the GPU device goes away (driver reset, tab throttled to death) the canvas would just freeze: say so instead.
  renderer.backend.device?.lost?.then((info) => { if (info.reason !== 'destroyed') fatal('The graphics device was lost', info.message || 'The browser reset the GPU.'); }).catch(() => {});
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); fatal('The graphics context was lost', 'The browser reset the GPU.'); });
  // The picture's pixel ratio: the screen's own up to 2 (1.5 on a phone), less the step or two you may have taken
  // off it with R, which is remembered.
  const deviceRatio = Math.min(devicePixelRatio, mobile ? 1.5 : 2);
  let trim = Math.min(0.5, Number(store.get('skyfight.trim')) || 0);
  const ceiling = () => Math.max(1, deviceRatio - trim);
  let ratio = ceiling();
  renderer.setPixelRatio(ratio);
  // The canvas element is sized by its stylesheet (it always fills the screen); only the drawing buffer follows the
  // window here, so a stale size during a phone's rotation can never leave bars beside the picture.
  renderer.setSize(Math.max(1, innerWidth), Math.max(1, innerHeight), false);
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.5, 9000);

  // Two batches draw every box in the game: lit (props, planes, particles) and glow (tracers, flashes, the sun).
  const lit = new Boxes(scene, 12000);
  const glow = new Boxes(scene, 1400, { glow: true });
  const soft = new Boxes(scene, 64, { soft: true });     // translucent discs and rings: prop blur, splashes, the vapour cone
  const world = await createWorld(scene, { mobile, lit, glow, soft, camera }, prepared);
  mark('world');
  world.setTimeOfDay(LIGHTS[dailySeed() % 3]);   // the title wears today's light

  // Post-processing: scene pass with an emissive MRT target so only tracers, flashes and the sun glow.
  const scenePass = pass(scene, camera, { samples: 4 });
  // The glow sees the emissive channel plus whatever is genuinely bright in the lit scene (snow, sunlit cloud tops,
  // glints), so light glows the way it does in the poster while ordinary terrain stays crisp. The knee that keeps
  // ordinary colour out of it is applied here, once, so the blurs below read a channel holding only what glows.
  const bright = output.rgb.mul(smoothstep(1.6, 3.2, luminance(output.rgb))).mul(0.7);
  const shine = emissive.rgb.add(bright);
  scenePass.setMRT(mrt({ output, emissive: vec4(shine.mul(smoothstep(1.2, 1.21, luminance(shine))), 1) }));
  const scenePassColor = scenePass.getTextureNode('output');
  // The halo: a tight blur at quarter resolution and a wide one at a sixteenth, weighted like the five-mip
  // pyramid they replace, in four render passes instead of twelve.
  const haloTex = scenePass.getTextureNode('emissive'), haloScale = mobile ? 0.82 : 1;
  const haloWide = gaussianBlur(haloTex, null, 5, { resolutionScale: 1 / 16 });
  const halo = gaussianBlur(haloTex, null, 4, { resolutionScale: 0.25 }).mul(0.75 * haloScale).add(haloWide.mul(0.5 * haloScale));
  // Sun shafts: a short radial smear of the wide glow toward the sun's screen position. The glow already holds the
  // sun disc masked by the clouds, so beams appear between the slabs. Skipped entirely when the sun is off screen.
  const sun = world.sunScreen;
  const shaftTex = haloWide.getTextureNode();
  const shafts = mobile ? vec3(0) : Fn(() => {
    const col = vec3(0).toVar();
    If(sun.strength.greaterThan(0.001), () => {
      const stepv = sun.uv.sub(screenUV).mul(0.8 / 14);
      const p = screenUV.toVar(), w = float(1).toVar();
      Loop(14, () => { p.addAssign(stepv); col.addAssign(shaftTex.sample(p).rgb.mul(w)); w.mulAssign(0.85); });
      col.mulAssign(sun.strength.mul(0.2));
    });
    return col;
  })();
  // Motion smear: the scene colour averaged along the direction each pixel moved during the frame. The camera's turn
  // slides (yaw, pitch) and swirls (roll) the whole frame; its travel is projected per pixel and divided by the
  // pixel's depth, so the ground streaks past at a low pass while the horizon holds. Your own plane, a few units
  // in front of the camera, is excluded by depth. Six symmetric taps so nothing lags, never more than 2.5% of the
  // screen. The vectors are measured in world.update, which also gates the effect behind a speed / turn threshold.
  const sm = world.smear;
  const smeared = mobile ? scenePassColor : Fn(() => {
    const out = vec4(scenePassColor.rgb, 1).toVar();
    // Off (a steady cruise, the title, a cut) the frame is read once and the depth not at all.
    If(sm.on.greaterThan(0.5), () => {
      const w = scenePass.getViewZNode().negate().max(0.5);              // distance in front of the camera
      const d = screenUV.sub(0.5).mul(vec2(sm.aspect, 1));
      let off = sm.shift.add(vec2(d.y, d.x.negate()).mul(sm.roll));
      off = off.add(sm.trans.xy.mul(sm.fy).add(d.mul(sm.trans.z)).div(w));
      off = off.mul(float(0.025).div(length(off).add(1e-5)).min(1));
      off = off.mul(smoothstep(28, 40, w));                               // the plane you are flying stays crisp
      off = vec2(off.x.div(sm.aspect), off.y).toVar();
      const col = vec3(0).toVar();
      const taps = 6;
      for (let i = 0; i < taps; i++) col.addAssign(scenePassColor.sample(screenUV.add(off.mul(i / (taps - 1) - 0.5))).rgb);
      out.assign(vec4(col.div(taps), 1));
    });
    return out;
  })();
  // Ambient occlusion is baked into the terrain vertex colors (see world.js) rather than computed per screen pixel:
  // screen-space AO showed a fixed noise lattice on the flat water while moving.
  // Filmic grade: cool the deep shadows only, lift saturation a touch, gentle vignette.
  const grade = (input) => {
    const lum = luminance(input.rgb);
    const shadowTint = mix(color(0xa4bce6), color(0xffffff), smoothstep(0.0, 0.3, lum));
    let rgb = input.rgb.mul(mix(vec3(1), shadowTint, 0.5));
    rgb = mix(vec3(luminance(rgb)), rgb, 1.12);
    const vignette = smoothstep(0.45, 1.25, screenUV.sub(0.5).length()).mul(0.22);
    return vec4(rgb.mul(float(1).sub(vignette)), 1);
  };
  const playGraph = grade(smeared.add(halo).add(vec4(shafts, 0)));
  // Title screen only: a shallow depth of field on the cinematic orbit, as a quarter-resolution blur mixed in by
  // depth, sharp at the letters and soft on the isles behind them. Two passes. Off in play, never on mobile.
  const titleGraph = mobile ? null : (() => {
    const soft = gaussianBlur(scenePassColor, null, 2, { resolutionScale: 0.25 });
    const lens = mix(scenePassColor, soft, smoothstep(float(450), float(1300), scenePass.getViewZNode().negate()));
    return grade(lens.add(halo).add(vec4(shafts, 0)));
  })();
  const pipeline = new THREE.RenderPipeline(renderer);
  pipeline.outputNode = playGraph;
  let titleLens = false;
  const useTitleLens = (on) => {
    if (on === titleLens || !titleGraph) return;
    titleLens = on;
    pipeline.outputNode = on ? titleGraph : playGraph;
    pipeline.needsUpdate = true;
  };

  const input = new Input();
  const hud = new Hud();
  const game = new Game(scene, camera, input, hud, world, { lit, glow, soft });
  const title = new Title(lit, glow);
  // The theme plays on the title and game-over screens. The context is created now (suspended until the first
  // gesture, which the sound module already listens for) so the loop is booked and starts the moment it may.
  game.audio.init();
  let trackIndex = Math.max(0, TRACKS.findIndex((tr) => tr.name === store.get('skyfight.track')));
  const music = new Music(game.audio, TRACKS[trackIndex]);
  const trackBtn = $('btn-track');
  const showTrack = () => { trackBtn.querySelector('span').textContent = TRACKS[trackIndex].name; };
  showTrack();
  trackBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault(); e.stopPropagation();
    trackIndex = (trackIndex + 1) % TRACKS.length;
    store.set('skyfight.track', TRACKS[trackIndex].name);
    music.setScore(TRACKS[trackIndex]);
    showTrack();
    trackBtn.classList.remove('pop'); void trackBtn.offsetWidth; trackBtn.classList.add('pop');
  });
  // The themes belong to the title and the debrief; in the air it is the engine, the wind and the guns.
  const menuMusic = () => { const on = game.state === 'title' || game.state === 'gameover'; if (on) music.play(); else music.stop(); };
  menuMusic();
  if (import.meta.env.DEV) import('./dev.js').then((d) => d.attachDevHooks({ game, input, world, camera, pipeline, renderer, scene, scenePass, boxes: [lit, glow, soft], useTitleLens, title, music, menuMusic }));

  bindTouch(input, { fire: $('btn-fire'), boost: $('btn-boost'), recenter: $('btn-recenter'), stickZone: $('stickzone'), stickBase: $('stickbase'), stickKnob: $('stickknob') });
  if (touch) {
    $('controlshint').classList.add('hidden');
    $('starthint').textContent = 'TAP TO FLY';
    $('gohint').textContent = 'TAP TO FLY AGAIN';
  }

  // Title tips: one short line at a time, the things the game never says in the HUD.
  const TIPS = [
    'Bandits break off after a pass. Get on their tail while they cruise.',
    'An interceptor dives from above and turns badly. Turn inside it.',
    'The ace in black barrel-rolls when you sit behind it. Wait it out.',
    'The airship shrugs off hits. Come from below and hit the gondola.',
    'Shoot the airship\'s turrets off first.',
    'Every wave\'s portal opens over a new part of the isles. Follow the teal diamond.',
    'A lighthouse, a wreck and a ring of stones are out there. Find them.',
    'Boost to catch a bandit, brake to turn inside one.',
    'Above the clouds your wingtips draw contrails.',
    'Clear a wave untouched for a bonus.',
  ];
  const tipEl = $('tip');
  let tipIndex = Math.floor(Math.random() * TIPS.length);
  const showTip = () => { tipEl.textContent = TIPS[tipIndex]; tipIndex = (tipIndex + 1) % TIPS.length; };
  showTip();
  setInterval(() => { if (game.state !== 'title') return; tipEl.classList.add('fade'); setTimeout(() => { showTip(); tipEl.classList.remove('fade'); }, 450); }, 7000);

  // Help dialog: opens from the ? button, closes on its button, Escape or Enter, and never starts the game by accident.
  const help = $('help');
  const showHelp = (on) => help.classList.toggle('hidden', !on);
  $('btn-help').addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); showHelp(true); });
  $('btn-help-close').addEventListener('pointerdown', (e) => { e.preventDefault(); showHelp(false); });
  help.addEventListener('pointerdown', (e) => { if (e.target === help) showHelp(false); });

  let starting = false, lastMode = 'free';
  /** Starts a run: 'free' as always, or 'daily' for today's seeded flight. Enter after a run repeats its mode. */
  const startGame = async (mode = lastMode) => {
    if (!help.classList.contains('hidden')) { showHelp(false); return; }
    if (starting || game.state === 'playing' || game.state === 'dead') return;
    starting = true;
    lastMode = mode;
    try {
      if (touch) {
        if (input.mode !== 'tilt') {
          // Motion permission can only hang on a broken browser; never let it hold the game hostage.
          const ok = await Promise.race([input.enableMotion(), new Promise((r) => setTimeout(() => r(false), 4000))]);
          if (!ok) { input.useStickFallback(); hud.notice('Tilt unavailable · thumb the left side to steer'); }
        }
        hud.showTouch(true);
        $('btn-recenter').classList.toggle('hidden', input.mode !== 'tilt');
        $('stickzone').classList.toggle('stick-enabled', input.mode === 'stick');
        // Nice-to-haves: never block the start on them.
        try { document.documentElement.requestFullscreen?.()?.catch(() => {}); } catch (_) { /* optional */ }
        try { screen.orientation?.lock?.('landscape')?.catch(() => {}); } catch (_) { /* optional */ }
      }
      input.recenter();
      game.start(mode);
      menuMusic();
    } catch (err) {
      console.error(err);
      game.abort();
    } finally {
      starting = false;
    }
  };
  // Escape (or the quit button on a phone) always gets you back to the title, whatever state the run is in.
  const abortRun = () => { if (!help.classList.contains('hidden')) showHelp(false); else if (game.state !== 'title') { game.abort(); hud.showTouch(false); menuMusic(); } };
  input.onAbort = abortRun;
  $('btn-quit').addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); abortRun(); });
  input.onStart = () => startGame(game.state === 'gameover' ? lastMode : 'free');
  input.onDaily = () => { if (game.state === 'title' || game.state === 'gameover') startGame('daily'); };
  // Runs start on click, not pointerdown: iPhones fire pointerdown from touchstart, and WebKit only shows the motion
  // permission prompt from a click-like gesture, so a tilt request made there fails silently and you get the stick.
  const startsFrom = (el, mode) => {
    el.addEventListener('pointerdown', (e) => { if (!e.target.closest('button, #medals')) e.preventDefault(); });
    el.addEventListener('click', (e) => { if (e.target.closest('button, #medals')) return; e.preventDefault(); startGame(mode()); });
  };
  $('btn-daily').addEventListener('pointerdown', (e) => { e.stopPropagation(); });
  $('btn-daily').addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); startGame('daily'); });
  $('btn-share').addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); hud.copyResult(); });
  $('medals').addEventListener('pointerdown', (e) => { e.stopPropagation(); });
  hud.showMute(game.audio.muted);
  input.onMute = () => hud.showMute(game.audio.toggleMute());
  $('btn-mute').addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); input.onMute(); });
  startsFrom($('title'), () => 'free');
  startsFrom($('gameover'), () => lastMode);

  const fit = () => {
    if (innerWidth === 0 || innerHeight === 0) return; // hidden tab / backgrounded pane
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight, false);
  };
  // iPhones report the old size for a moment after a rotation, so fit again once it has settled
  for (const ev of ['resize', 'orientationchange']) addEventListener(ev, () => { fit(); setTimeout(fit, 400); });
  // On an iPhone the browser's own bars only go away as a home-screen app: say so, until it is one.
  const standalone = navigator.standalone === true || matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches;
  if (touch && /iPhone|iPad/.test(navigator.userAgent) && !standalone) $('installhint').classList.remove('hidden');

  // Compile the play graph once up front so the first shot fired doesn't stall on a shader build.
  pipeline.render();
  // ... and the title's own graph (its depth of field), so the first frame of the loop does not stall on one either.
  useTitleLens(true);
  pipeline.render();
  mark('first frame sent');
  // Sent is not seen: the GPU is still building pipelines, and while it is, anything that moves on the page stutters
  // with it. So nothing moves: the canvas stays under its veil of sky (start.js) and the title's prompts stay away
  // until the queue has drained. Then it all arrives together, the picture, the letters, and the prompts with every
  // line of theirs already filled in.
  const seen = renderer.backend.device ? renderer.backend.device.queue.onSubmittedWorkDone() : Promise.resolve();
  seen.catch(() => {}).then(() => requestAnimationFrame(() => {
    mark('seen');
    const pt = prepared.times, line = `workers ${pt.workers} (grid ${pt.grid}, land and light ${pt.world}, on ${pt.on}) · ${marks.join(' · ')}`;
    console.info(`start (ms): ${line}`);
    if (PERF) hud.notice(`start · ${line}`, 20000);
    document.body.classList.add('ready');
    const veil = $('veil');
    veil.classList.add('gone');
    setTimeout(() => veil.remove(), 900);
  }));

  // Dynamic resolution: eight long frames in a row shrink the drawing buffer a step, ten seconds of headroom grow it
  // back, so a hot machine keeps its frame rate rather than its pixels. A phone may go down to a pixel ratio of 1. A
  // laptop never goes below 1.5 (a fanless one loses a third of its GPU clock after a minute of play, and this is
  // the net under that). If five seconds at the floor are still slow then pixels were never the problem, and a
  // laptop gets them back and is left alone. When those frames sat at a steady thirtieth of a second the likeliest
  // cause is a browser or a system holding the page to 30 frames a second to save the battery, which nothing here
  // can lift, so the game says so, once.
  const floor = () => Math.min(ceiling(), mobile ? 1 : 1.5);
  let slow = 0, fast = 0, stuck = 0, at30 = 0, adaptive = true, told = false;
  const resize = (r) => { ratio = r; renderer.setPixelRatio(ratio); fit(); };
  const resolution = (frame) => {
    if (game.state !== 'playing') return;
    const long = frame > 1 / 45;
    slow = long ? slow + 1 : 0; fast = long ? 0 : fast + 1;
    if (ratio <= floor() && long) { stuck++; if (frame > 0.03 && frame < 0.037) at30++; } else { stuck = Math.max(0, stuck - 1); at30 = Math.max(0, at30 - 1); }
    if (stuck > 150 && !told) {
      told = true;
      if (at30 > stuck * 0.8) hud.notice('30 fps · if on battery, check Energy Saver / Low Power Mode', 9000);
      if (!mobile) { adaptive = false; resize(ceiling()); }
    } else if (!adaptive) return;
    else if (slow >= 8 && ratio > floor()) { slow = 0; resize(Math.max(floor(), ratio - 0.25)); }
    else if (fast >= 600 && ratio < ceiling()) { fast = 0; resize(Math.min(ceiling(), ratio + 0.25)); }
  };
  // R trades pixels for headroom by hand: full, a quarter step down, a half step down, and round again. On a
  // Retina panel under four samples a pixel the steps are hard to tell apart, and each is about a seventh less work
  // for the GPU; whether they are the same picture is for the eye that is looking at it, so it is a key and not a
  // default. The choice is kept, and the dynamic resolution above works beneath it.
  addEventListener('keydown', (e) => {
    if (e.code !== 'KeyR' || e.repeat || e.metaKey || e.ctrlKey) return;
    trim = trim >= 0.5 || deviceRatio - trim - 0.25 < 1 ? 0 : trim + 0.25;
    store.set('skyfight.trim', String(trim));
    resize(ceiling());
    hud.notice(`Resolution ${ratio}× · ${renderer.domElement.width} × ${renderer.domElement.height}${trim ? '' : ' · full'}`, 2500);
  });
  // The frame meter: frames a second, the longest frame of the last half second, the script's share of a frame and
  // the size of the picture. Off, it costs two clock reads a frame.
  const meter = { el: null, on: false, frames: 0, since: performance.now(), worst: 0, cpu: 0 };
  const showMeter = (on) => {
    meter.on = on;
    if (on && !meter.el) { meter.el = document.createElement('div'); meter.el.className = 'pill'; meter.el.style.cssText = 'bottom:44px;letter-spacing:0.08em;font-variant-numeric:tabular-nums'; document.body.appendChild(meter.el); }
    if (meter.el) meter.el.classList.toggle('hidden', !on);
  };
  addEventListener('keydown', (e) => { if (e.code === 'KeyP' && !e.repeat) showMeter(!meter.on); });
  if (PERF) showMeter(true);
  const measure = (frameMs, cpuMs, now) => {
    meter.frames++; meter.cpu += cpuMs; if (frameMs > meter.worst) meter.worst = frameMs;
    if (now - meter.since < 500) return;
    const canvasEl = renderer.domElement;
    meter.el.textContent = `${Math.round(meter.frames * 1000 / (now - meter.since))} fps · worst ${meter.worst.toFixed(1)} ms · cpu ${(meter.cpu / meter.frames).toFixed(1)} ms · ${canvasEl.width}×${canvasEl.height} @${ratio}`;
    meter.frames = 0; meter.cpu = 0; meter.worst = 0; meter.since = now;
  };
  let last = performance.now();
  let acc = 0;
  const STEP = 1 / 120;
  // Nobody at the controls: on the title or the debrief, twenty seconds without a key or a pointer (or the
  // window not in front) drops the picture to every other frame. The slow orbit looks the same at half the rate, and
  // a fanless laptop left on the title is not already warm when the run starts.
  let touched = performance.now(), skip = false;
  for (const ev of ['keydown', 'pointerdown', 'pointermove', 'wheel', 'touchstart']) addEventListener(ev, () => { touched = performance.now(); }, { passive: true });
  renderer.setAnimationLoop((now) => {
    const resting = game.state !== 'playing' && game.state !== 'dead' && (performance.now() - touched > 20000 || !document.hasFocus());
    if (resting && (skip = !skip)) return;
    const began = performance.now(), sinceLast = now - last;
    let frame = Math.min(0.05, sinceLast / 1000);
    last = now;
    if (innerWidth === 0 || innerHeight === 0) return;
    resolution(frame);
    useTitleLens(game.state === 'title');
    menuMusic();
    input.update();
    // Fixed-step simulation keeps the flight model identical at 60 and 120 Hz displays.
    acc += frame;
    let steps = 0;
    while (acc >= STEP && steps < 6) { game.update(STEP); acc -= STEP; steps++; }
    if (steps === 6) acc = 0;
    game.alpha = acc / STEP;   // the frame falls this far between the last two sim steps
    game.render(frame);
    world.update(frame, now / 1000, game.player.renderPos, camera, game.player.alive ? game.player.speed : 0);
    title.update(frame, now / 1000, camera, game.state === 'title');
    lit.flush(); glow.flush(); soft.flush();
    pipeline.render();
    if (meter.on) measure(sinceLast, performance.now() - began, now);
  });
}

/** A full-screen notice with a reload button, for the failures nothing in the game can recover from. */
function fatal(title, detail) {
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;inset:20px;color:#fff;background:#1d2b3a;padding:24px;border-radius:12px;white-space:pre-wrap;z-index:99;font:16px system-ui;overflow:auto';
  el.innerHTML = `<b style="font-size:22px">${title}</b>\n\n${detail}\n\n<button style="font:inherit;padding:10px 18px;border-radius:8px;border:0;background:#ff6b57;color:#fff;cursor:pointer">Reload</button>`;
  el.querySelector('button').addEventListener('click', () => location.reload());
  document.body.appendChild(el);
}

boot().catch((err) => {
  console.error(err);
  fatal('Failed to start the renderer', String(err.stack || err));
});
