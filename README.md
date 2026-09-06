# Flight

A voxel-terraced, Pixar-lit arcade dogfighting game for the browser. Fly a toy propeller plane over the Coral
Isles and survive escalating waves of AI bandits.

**Play it: [jugalm.com/flight](https://jugalm.com/flight/)** (also reachable as [nuterian.github.io/flight](https://nuterian.github.io/flight/))

Works in any browser with WebGPU (Chrome, Edge, Safari 26, Firefox 141+) and falls back to WebGL2 elsewhere. On a
phone, open it in landscape and tilt to steer.

## Controls

| | |
|---|---|
| `W` `A` `S` `D` or arrows | pitch, roll and turn |
| `Q` `E` | rudder |
| `Space` | fire |
| `Shift` / `Ctrl` | boost / brake |
| `I` / `C` | invert pitch / recenter tilt |
| `M` / `Esc` | mute / quit to title |

Phones: tilt like a steering wheel to roll, tip the top edge toward you to climb, hold FIRE and BOOST. The `?` on the
title screen has the full list.

Bandits arrive through a portal each wave and come in bigger packs. Quick kills chain into combos. Stay inside the
grid walls: outside them a ten-second countdown drains your hull.

## Run it yourself

```bash
npm install
npm run dev          # http://localhost:5173
npm run dev:mobile   # https on your LAN, so a phone can use its motion sensors
npm run build        # production bundle in dist/
```

Pushing to `main` builds and deploys to GitHub Pages through the workflow in `.github/workflows/`.

## How it's built

Three.js r185 `WebGPURenderer` with TSL node materials, no frameworks, no assets: every texture, model, sound and
note is generated in code.

- **World.** A composed heightfield (warped coastlines, ridged mountains, hills) is flooded into lakes, drained into
  rivers that carve valleys and cascade over cliffs, and quantized into terraces on a 5-unit grid. Water is a
  six-wave analytic surface with a real planar reflection. Per-block tone, strata, grass fringes, moss and lichen
  are done in the fragment shader.
- **Everything is a box.** Every voxel in the game is an instance of one unit cube in a handful of batches: lit,
  palm fronds (with wind and downwash), glow (tracers, flames, the sun) and soft (prop discs, splash rings,
  waterfalls). A plane is a table of 30-odd boxes placed under its matrix each frame, control surfaces, flexing
  wingtips, retracting gear and pilot included.
- **Feel.** Fixed 120 Hz simulation, hit-stop and distance-scaled shake, a camera that lags through hard turns and
  kicks with the guns, a slow-motion orbit on the last kill of a wave, wreckage that tumbles and smokes, damage
  states, sea spray and dust on low passes, birds, gulls, sheep, wolves, villagers, and a title built from riveted
  steel blocks.
- **Sound.** Procedural Web Audio: engine pitched to speed, wind, guns, hits, explosions with sub-bass, and two
  title themes ("Dogfight" and "Coral Isles") played live by a sequencer on modelled instruments, including a
  Karplus-Strong string in an AudioWorklet.

## Layout

| | |
|---|---|
| `src/main.js` | renderer, post pipeline (bloom, sun shafts, title depth of field, grade), start flow, loop |
| `src/terrain.js` | pure-JS geology: heightfield, lakes, rivers, terraces, ground queries |
| `src/world.js` | terrain mesh, sea, sky, clouds, props, wildlife, villages, lighting |
| `src/boxes.js`, `src/plane.js` | the instanced box batches and the plane as data |
| `src/aircraft.js`, `src/ai.js`, `src/bullets.js` | flight model, bandit brains, tracers |
| `src/game.js`, `src/portal.js` | waves, scoring, damage, camera, the arrival portal |
| `src/effects.js`, `src/trails.js` | particles, wreckage, vapor ribbons and wakes |
| `src/hud.js`, `src/title.js` | DOM HUD and screens, the voxel title |
| `src/audio.js`, `src/music.js`, `src/scores.js`, `src/ks.worklet.js` | sound effects, the music engine, the two themes |
| `src/input.js`, `src/touch.js` | keyboard, tilt and touch controls |
| `src/dev.js` | headless test and benchmark hooks (dev builds only) |
