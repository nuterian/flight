import * as THREE from 'three/webgpu';
import { pass, mrt, output, emissive, vec2, vec3, vec4, float, screenUV, smoothstep, mix, luminance, color, uniform, Fn, If, Loop, length } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { dof } from 'three/addons/tsl/display/DepthOfFieldNode.js';
import { createWorld } from './world.js';
import { Boxes } from './boxes.js';
import { Input, isTouchDevice } from './input.js';
import { bindTouch } from './touch.js';
import { Hud } from './hud.js';
import { Game } from './game.js';
import { Title } from './title.js';
import { Music } from './music.js';
import { TRACKS } from './scores.js';
import { store } from './audio.js';

const $ = (id) => document.getElementById(id);
const touch = isTouchDevice();
const mobile = touch && Math.min(innerWidth, innerHeight) < 900;

async function boot() {
  const canvas = $('game');
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, powerPreference: 'high-performance', trackTimestamp: import.meta.env.DEV });
  await renderer.init();
  // If the GPU device goes away (driver reset, tab throttled to death) the canvas would just freeze: say so instead.
  renderer.backend.device?.lost?.then((info) => { if (info.reason !== 'destroyed') fatal('The graphics device was lost', info.message || 'The browser reset the GPU.'); }).catch(() => {});
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); fatal('The graphics context was lost', 'The browser reset the GPU.'); });
  renderer.setPixelRatio(Math.min(devicePixelRatio, mobile ? 1.5 : 2));
  renderer.setSize(Math.max(1, innerWidth), Math.max(1, innerHeight));
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.5, 9000);

  // Two batches draw every box in the game: lit (props, planes, particles) and glow (tracers, flashes, the sun).
  const lit = new Boxes(scene, 12000);
  const glow = new Boxes(scene, 1400, { glow: true });
  const soft = new Boxes(scene, 1800, { soft: true });   // translucent discs, rings and strips: prop blur, splashes, waterfalls
  const world = createWorld(scene, { mobile, lit, glow, soft });

  // Post-processing: scene pass with an emissive MRT target so only tracers, flashes and the sun bloom.
  const scenePass = pass(scene, camera);
  // Bloom sees the emissive channel plus whatever is genuinely bright in the lit scene (snow, sunlit cloud tops,
  // glints), so light glows the way it does in the poster while ordinary terrain stays crisp.
  const bright = output.rgb.mul(smoothstep(1.6, 3.2, luminance(output.rgb))).mul(0.7);
  scenePass.setMRT(mrt({ output, emissive: vec4(emissive.rgb.add(bright), 1) }));
  const scenePassColor = scenePass.getTextureNode('output');
  const bloomPass = bloom(scenePass.getTextureNode('emissive'), mobile ? 0.45 : 0.55, 0.35, 1.2);
  // Sun shafts: a short radial smear of the bloom toward the sun's screen position. The bloom already holds the
  // sun disc masked by the clouds, so beams appear between the slabs. Skipped entirely when the sun is off screen.
  const sun = world.sunScreen;
  const bloomTex = bloomPass.getTextureNode();
  const shafts = mobile ? vec3(0) : Fn(() => {
    const col = vec3(0).toVar();
    If(sun.strength.greaterThan(0.001), () => {
      const stepv = sun.uv.sub(screenUV).mul(0.8 / 14);
      const p = screenUV.toVar(), w = float(1).toVar();
      Loop(14, () => { p.addAssign(stepv); col.addAssign(bloomTex.sample(p).rgb.mul(w)); w.mulAssign(0.85); });
      col.mulAssign(sun.strength.mul(0.12));
    });
    return col;
  })();
  // Motion smear: the scene colour averaged along the direction each pixel moved during the frame (a sideways shift
  // for yaw and pitch, a swirl about the centre for roll, a radial stretch for forward travel), from the camera's
  // motion measured in world.update. Six taps, symmetric so nothing lags, never more than ~2% of the screen.
  const sm = world.smear;
  const smeared = mobile ? scenePassColor : Fn(() => {
    const d = screenUV.sub(0.5).mul(vec2(sm.aspect, 1));
    let off = sm.shift.add(vec2(d.y.negate(), d.x).mul(sm.roll)).add(d.mul(sm.zoom));
    off = off.mul(float(0.018).div(length(off).add(1e-5)).min(1));
    off = off.mul(smoothstep(0.05, 0.14, length(screenUV.sub(sm.focus).mul(vec2(sm.aspect, 1)))));   // your own plane stays crisp
    off = vec2(off.x.div(sm.aspect), off.y);
    const col = vec3(0).toVar();
    const taps = 6;
    for (let i = 0; i < taps; i++) col.addAssign(scenePassColor.sample(screenUV.add(off.mul(i / (taps - 1) - 0.5))).rgb);
    return vec4(col.div(taps), 1);
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
  const playGraph = grade(smeared.add(bloomPass).add(vec4(shafts, 0)));
  // Title screen only: a shallow depth of field on the cinematic orbit. Off in play, never on mobile.
  const titleGraph = mobile ? null : grade(dof(scenePassColor.add(bloomPass), scenePass.getViewZNode(), uniform(420), uniform(260), 2.4).add(vec4(shafts, 0)));
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
  const menuMusic = () => { const on = game.state === 'title' || game.state === 'gameover'; if (on) music.play(); else music.stop(); };
  menuMusic();
  if (import.meta.env.DEV) import('./dev.js').then((d) => d.attachDevHooks({ game, input, world, camera, pipeline, renderer, boxes: [lit, glow, soft], useTitleLens, title, music, menuMusic }));

  bindTouch(input, { fire: $('btn-fire'), boost: $('btn-boost'), recenter: $('btn-recenter'), stickZone: $('stickzone'), stickBase: $('stickbase'), stickKnob: $('stickknob') });
  if (touch) {
    $('controlshint').classList.add('hidden');
    $('starthint').textContent = 'TAP TO FLY';
    $('gohint').textContent = 'TAP TO FLY AGAIN';
  }

  // Help dialog: opens from the ? button, closes on its button, Escape or Enter, and never starts the game by accident.
  const help = $('help');
  const showHelp = (on) => help.classList.toggle('hidden', !on);
  $('btn-help').addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); showHelp(true); });
  $('btn-help-close').addEventListener('pointerdown', (e) => { e.preventDefault(); showHelp(false); });
  help.addEventListener('pointerdown', (e) => { if (e.target === help) showHelp(false); });

  let starting = false;
  const startGame = async () => {
    if (!help.classList.contains('hidden')) { showHelp(false); return; }
    if (starting || game.state === 'playing' || game.state === 'dead') return;
    starting = true;
    try {
      if (touch) {
        if (input.mode !== 'tilt') {
          // Motion permission can only hang on a broken browser; never let it hold the game hostage.
          const ok = await Promise.race([input.enableMotion(), new Promise((r) => setTimeout(() => r(false), 4000))]);
          if (!ok) input.useStickFallback();
        }
        hud.showTouch(true);
        $('btn-recenter').classList.toggle('hidden', input.mode !== 'tilt');
        $('stickzone').classList.toggle('stick-enabled', input.mode === 'stick');
        // Nice-to-haves: never block the start on them.
        try { document.documentElement.requestFullscreen?.()?.catch(() => {}); } catch (_) { /* optional */ }
        try { screen.orientation?.lock?.('landscape')?.catch(() => {}); } catch (_) { /* optional */ }
      }
      input.recenter();
      game.start();
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
  input.onStart = startGame;
  hud.showMute(game.audio.muted);
  input.onMute = () => hud.showMute(game.audio.toggleMute());
  $('btn-mute').addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); input.onMute(); });
  for (const id of ['title', 'gameover']) $(id).addEventListener('pointerdown', (e) => { e.preventDefault(); startGame(); });

  addEventListener('resize', () => {
    if (innerWidth === 0 || innerHeight === 0) return; // hidden tab / backgrounded pane
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  // Compile the play graph once up front so the first shot fired doesn't stall on a shader build.
  pipeline.render();
  useTitleLens(true);

  let last = performance.now();
  let acc = 0;
  const STEP = 1 / 120;
  renderer.setAnimationLoop((now) => {
    let frame = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (innerWidth === 0 || innerHeight === 0) return;
    useTitleLens(game.state === 'title');
    menuMusic();
    input.update();
    // Fixed-step simulation keeps the flight model identical at 60 and 120 Hz displays.
    acc += frame;
    let steps = 0;
    while (acc >= STEP && steps < 6) { game.update(STEP); acc -= STEP; steps++; }
    if (steps === 6) acc = 0;
    game.render(frame);
    world.update(frame, now / 1000, game.player.pos, camera, game.player.alive ? game.player.speed : 0);
    title.update(frame, now / 1000, camera, game.state === 'title');
    lit.flush(); glow.flush(); soft.flush();
    pipeline.render();
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
