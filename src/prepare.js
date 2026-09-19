// The world is a second of arithmetic before it is anything to draw: heights, flood and terraces, the land's
// geometry, the baked light, the water's noise. Run on the page it is a second of frozen title. Here it is shared out
// between a few workers the moment the script starts, while the renderer comes up:
//
//   heights, in bands, on every worker  ->  flood and terrace, on one  ->  the land's geometry, on that one
//   the water's noise, behind the last worker's bands                  ->  sky and the three suns, on the others
//
// The page gets the grid as soon as it is terraced and builds what needs only that (sea, props, landmarks) while the
// land is still being meshed. Every piece falls back to being computed right here if a worker cannot be had.
//
// This runs from start.js, ahead of the game, and imports nothing but grid.js and times.js: the workers are running a few
// milliseconds after the page opens, while the renderer's megabyte of script is still being fetched and parsed, and
// the world is usually there before the game asks for it. (The fallbacks load the heavy modules only if needed.)
import { ROWS, adoptGrid } from './grid.js';
import { LIGHTS, SUN_DIRS } from './times.js';

const BANDS = 16;   // interleaved between the workers, so the costly middle rows (the land) are shared evenly

/** Starts the work. `sunDirs` are the sun directions to bake shadows for. Returns promises: `grid` (resolved once
 *  the page's own terrain queries work), `land` (chunks of typed arrays), `occlusion` ([sky, ...suns], bytes over the
 *  grid) and `noise` (half floats). */
function prepareWorld(sunDirs) {
  const now = () => Math.round(performance.now()), times = { workers: now(), grid: 0, world: 0 };   // page time, for the start line
  const workers = [], waiting = new Map();
  let nextId = 1;
  try {
    const n = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
    for (let k = 0; k < n; k++) {
      const w = new Worker(new URL('./boot.worker.js', import.meta.url), { type: 'module' });
      w.onmessage = ({ data }) => { const p = waiting.get(data.id); waiting.delete(data.id); if (data.error) p.reject(new Error(data.error)); else p.resolve(data.result); };
      w.onerror = (e) => { for (const p of waiting.values()) p.reject(new Error(e.message || 'worker failed')); waiting.clear(); };
      workers.push(w);
    }
  } catch (err) { workers.length = 0; }
  const call = (k, msg, transfer = []) => new Promise((resolve, reject) => {
    if (!workers.length) { reject(new Error('no workers')); return; }
    const id = nextId++;
    waiting.set(id, { resolve, reject });
    workers[k % workers.length].postMessage({ ...msg, id }, transfer);
  });
  const direct = (what, fn) => async (err) => { console.warn(`${what}: built on the page (${err.message})`); return fn(await import('./terrain.js'), await import('./bake.js')); };

  // heights in bands on every worker, then one worker floods and terraces the stitched field
  const bands = [];
  for (let b = 0; b < BANDS; b++) { const r0 = Math.floor(b * ROWS / BANDS), r1 = Math.floor((b + 1) * ROWS / BANDS); bands.push(call(b, { job: 'heights', r0, r1 }).then((band) => ({ r0, band }))); }
  const noise = call(workers.length - 1, { job: 'noise' }).catch(direct('water noise', (t, b) => b.bakeNoise()));
  let gridCopy = null;
  const grid = Promise.all(bands).then((done) => {
    const h = new Float32Array(ROWS * ROWS), m = new Float32Array(ROWS * ROWS);
    for (const { r0, band } of done) { h.set(band.h, r0 * ROWS); m.set(band.m, r0 * ROWS); }
    return call(0, { job: 'finish', h, m }, [h.buffer, m.buffer]);
  }).then((g) => { gridCopy = g; adoptGrid(g); times.grid = now(); }).catch(direct('terrain', (t) => { gridCopy = null; t.ensureGrid(); }));

  // the first worker still holds the grid it finished and meshes the land from it; the others are handed a copy
  const land = grid.then(() => { if (!gridCopy) throw new Error('no grid on the workers'); return call(0, { job: 'land' }); }).catch(direct('land', (t, b) => b.buildLand()));
  const others = (k) => (workers.length > 1 ? 1 + k % (workers.length - 1) : 0);
  const lit = (k, msg, job) => grid.then(() => { if (!gridCopy) throw new Error('no grid on the workers'); return call(others(k), { ...msg, grid: others(k) === 0 ? undefined : gridCopy }); }).catch(direct('baked light', (t, b) => job(b)));
  const occlusion = Promise.all([lit(0, { job: 'sky' }, (b) => b.bakeSky()), ...sunDirs.map((dir, k) => lit(k + 1, { job: 'sun', dir }, (b) => b.bakeSun(dir)))]);

  Promise.all([land, occlusion, noise]).then(() => { for (const w of workers) w.terminate(); times.world = now(); times.on = workers.length; });
  return { grid, land, occlusion, noise, times };
}

/** The world, already on its way by the time anything imports this. */
export const prepared = prepareWorld(LIGHTS.map((name) => SUN_DIRS[name]));
