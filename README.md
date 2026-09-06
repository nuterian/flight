# Flight

A voxel-terraced, Pixar-lit arcade dogfighting game for the browser. Fly a toy propeller plane over the
Coral Isles and survive escalating waves of AI bandits.

Art direction: Minecraft-like shapes (stepped terraces, flat slab clouds, box-built planes and palms) rendered with
bold saturated colors, realistic soft shadows, baked occlusion, wingtip vapor ribbons and a filmic grade. The water is a
six-wave analytic normal field with a real planar reflection of the scene (clouds, sun, planes, coast) rippled by the
waves and weighted by Fresnel, depth-based transparency over a sandy seafloor, shallow shimmer and noise-driven foam.
On mobile the planar reflection falls back to an analytic sky reflection.

## Run

```bash
npm install
npm run dev          # http://localhost:5173 (desktop)
npm run dev:mobile   # https on your LAN so a phone can use its motion sensors
npm run build        # production bundle in dist/
```

Phones only expose the gyroscope/accelerometer on secure origins, so use `dev:mobile` and open the printed
`https://<your-ip>:5173` URL on the phone (accept the self-signed certificate once).

## Controls

**Phone (mobile first):** tap to fly, then tilt the phone like a steering wheel to roll and turn, tip the top edge toward
you to climb. Hold FIRE, hold BOOST. The tilt is calibrated to how you're holding the phone when the run starts; the
recenter button (top right) re-calibrates. If motion sensors are unavailable or denied, a virtual stick appears on the
left half of the screen instead.

**Keyboard:** arrows or WASD for pitch and roll, Q/E rudder, Shift boost, Ctrl brake, Space fire, Enter start,
I inverts pitch, C recenters tilt, M mutes the sound (on a phone, the note button), Escape (or the x button on a
phone) abandons the run and returns to the title from any state.

## Combat zone

The playable space is an invisible 3000 x 3000 x 650 unit box. Its walls are holographic grids that fade in as you
get close and turn red when you cross them. Outside, a 10 second countdown drains your health and kills you when it
hits zero; fly back in and it recovers. The sea itself runs seamlessly to a fog-matched horizon, so the world reads
as endless while the box keeps the fight contained.

## Tech

- Three.js r185 `WebGPURenderer` with the TSL node material system. Falls back to WebGL2 automatically.
- Post-processing through `RenderPipeline`: MSAA scene pass with an emissive MRT target, so bloom only touches
  tracers, muzzle flashes, explosions and the sun.
- Ambient occlusion baked into the terrain vertex colors (wall gradients and shaded step corners), Khronos neutral
  tone mapping, PCF soft shadows, TSL range fog, GPU-animated water, GPU-swayed palm fronds, a cool-shadow color grade and vignette.
- Everything is procedural. The land is composed, not sampled: domain-warped continent noise for the coastlines,
  ridged noise for mountain spines, hills on top. On a 5-unit grid the field is then flooded into lakes (priority
  flood), drained into rivers (flow accumulation) that carve channels one terrace below their banks, and quantized
  into terraces that grow with altitude (3-unit steps on the shore, 6 in the hills, 12 in the mountains). Tops
  are greedy-merged rectangles and walls are merged runs, so 410k columns come to about 450k vertices in one
  draw call. Rivers step down as cascades and waterfalls (streaming strips on the soft batch, a rumble nearby).
  Lakes and rivers are flat quads that reuse the sea's shading. Palette: sand, wet sand, grass, brown strata,
  grey stone, a noisy snowline. Cloud slabs, palms, balloons, boats and planes are voxel batches. No asset downloads.
- Fixed 120 Hz simulation step, so the flight model behaves identically on 60 and 120 Hz displays. Camera and HUD
  update once per displayed frame, and the shadow map renders exactly once per frame (the water's reflection pass
  reuses it).
- Every box in the game is an instance of one unit cube in one of four batches: lit (props, planes, particles,
  birds, wreckage), palm fronds (lit plus wind sway and the downwash of a passing plane), glow (tracers and their
  wakes, muzzle flashes, exhaust flames, balloon burners, the sun) and soft (a translucent cube masked to a disc or
  ring in its shader: prop blur discs and splash rings). A plane is a data table of 27 boxes placed under the
  aircraft's matrix each frame: control surfaces, propeller, flexing wingtips and retracting gear included.
  Wingtip vapor ribbons share one mesh, boat wakes another. The whole dynamic world is a handful of draw calls.
- Materiality, all in the fragment shader with no textures: every block has its own tone and a 16x16 grid of
  "texels" per face, cliff walls show horizontal strata, grass hangs in a ragged fringe over lips, tops carry
  patches of moss, north-facing walls catch lichen speckle, and props and planes get a 4x4 texel grain. Bloom
  sees the emissive channel plus genuinely bright lit pixels (snow, cloud tops, glints), and a short radial smear
  of the bloom toward the sun's screen position gives sun shafts between the cloud slabs (desktop only).
- A living Overworld: a voxel pilot in the open cockpit who tracks the nearest bandit (over the shoulder when it's
  behind), leans into turns and looks around when idle; bandits arrive through an obsidian portal that assembles
  in the sky; planes scorch, shed a wingtip at half health, sputter and burn near the end; low passes throw sea
  spray, beach dust and torn fronds, and a vapour cone blooms past top speed; the last kill of a wave gets a
  slow-motion orbit; sheep, wolves and chickens live on the meadows and villagers turn to watch you pass.
- Never stuck: the pending-bandit count is derived, a bandit that stays out of reach for 35 s is recalled through a
  portal, a non-finite flight state ends the run, Escape (or the phone's x button) always returns to the title,
  motion permission cannot hang the start, storage failures are ignored, and a lost GPU device shows a reload notice.
- Feel: hit-stop and distance-scaled shake on kills, a two-frame chromatic split on the HUD when hit, tumbling
  smoking wreckage, a camera that lags through hard turns and kicks with the guns, a title-screen depth of field
  (`dof` TSL node, desktop only), a slow-motion dolly-zoom on death, and an animated HUD (wave banner, ticking
  score, kill feed, combo counter, springing cards).
- Sound is procedural Web Audio with no files: engine pitched to speed with a blade-chop LFO, speed-driven wind,
  gun rattle, hits, explosions with a sub-bass thump, a two-tone zone warning and a wave-clear jingle.

## Layout

- `src/main.js` renderer, post pipeline, start flow, game loop
- `src/boxes.js` the instanced box batch everything boxy is drawn with
- `src/dev.js` headless test hooks (dev builds only): `__step`, `__scenario`, `__bench`, `__benchMin`
- `src/world.js` terrain, sea, sky, sun, clouds, palms, balloons, boats, lighting
- `src/terrain.js` pure-JS geology: heightfield, lakes, rivers, terraces, kinds and ground queries shared by rendering, collision and AI
- `src/plane.js` the plane as a box table, liveries, per-frame placement
- `src/aircraft.js` arcade flight model
- `src/input.js`, `src/touch.js` tilt / stick / keyboard input and on-screen buttons
- `src/ai.js` enemy state machine (pursue, evade, breakaway, terrain avoidance)
- `src/bullets.js` tracers with swept-sphere hit tests
- `src/effects.js` shards, smoke, flashes
- `src/trails.js` vapor ribbons, one mesh per kind (wingtip trails, boat wakes)
- `src/audio.js` procedural Web Audio: engine, wind, guns, hits, explosions, warning, jingle
- `src/music.js` the music engine: a look-ahead sequencer and a bank of modelled instruments (FM electric piano,
  flute, strings, synth brass, staccato strings, driving bass, timpani, kit) with `src/ks.worklet.js`, a Karplus-Strong
  plucked string in an AudioWorklet for the ukulele and upright bass
- `src/scores.js` the two themes for the title and game-over screens, as data: "Dogfight" (default: a D minor build
  into a brass anthem at 150 BPM) and "Coral Isles" (laid-back D major at 96 BPM); the note button on the title
  switches between them and the choice is remembered
- `src/game.js` waves, scoring, damage, camera
- `src/hud.js` DOM HUD, target markers, lead reticle, screens
- `src/title.js` the voxel title: dirt-and-grass letters that drop in, float and face the camera
- `src/portal.js` the bandits' arrival portal: 24 lit blocks and one glow sheet, reused every wave
