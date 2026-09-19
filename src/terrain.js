// Pure-JS terrain: how the grid that grid.js serves is made. (Everything grid.js exports is re-exported from here.)
//
// The land is composed rather than sampled from one noise: warped continent noise for the coastlines, ridged noise
// for mountain spines, small hills on top. That smooth field is then processed on a 5-unit grid: depressions are
// flooded into lakes, rain is drained downhill into rivers that carve valleys, and the result is quantized into
// terraces whose height grows with altitude (3-unit steps on the shore, 6 in the hills, 12 in the mountains).
import { ImprovedNoise } from 'three/addons/math/ImprovedNoise.js';
import { SCALE, BASE_SIZE, CELL, N, ROWS as W, KIND, TOPS, levelTop, levelOfHeight, gridArrays, adoptGrid, onMissingGrid } from './grid.js';
export * from './grid.js';

const noise = new ImprovedNoise();
const n2 = (x, z, s) => noise.noise(x, z, s);

function fbm(x, z, octaves, seed = 7.31) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * n2(x * freq, z * freq, seed);
    norm += amp; amp *= 0.5; freq *= 2.07;
  }
  return sum / norm;
}
/** Sharp-crested noise in 0..1: ridges where the underlying noise crosses zero. */
function ridged(x, z, octaves, seed = 3.7) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    let n = 1 - Math.abs(n2(x * freq, z * freq, seed));
    n *= n;
    sum += n * amp; norm += amp; amp *= 0.5; freq *= 2.1;
  }
  return sum / norm;
}

let lastMountain = 0;
/** The smooth, un-carved height field. Negative below sea level. Leaves the mountain weight in `lastMountain`. */
function smoothHeight(x, z) {
  x /= SCALE; z /= SCALE;   // the design space
  // warp the domain so coastlines twist into bays, spits and fjords instead of blobs
  const wx = x + 300 * n2(x / 950 + 3.1, z / 950 + 7.7, 11.3);
  const wz = z + 300 * n2(x / 950 - 5.2, z / 950 + 1.3, 17.9);
  let land = fbm(wx / 1050 + 13.7, wz / 1050 + 4.2, 4) * 2.6;
  land += fbm(wx / 330 + 5.5, wz / 330 + 9.1, 2) * 0.45;
  const r = Math.hypot(x, z) / (BASE_SIZE * 0.5);
  land += 0.16 - Math.pow(Math.min(r, 1.25), 5) * 1.9;
  if (land < 0) { lastMountain = 0; return land * 85; }             // sea floor
  const inland = smooth01((land - 0.10) / 0.35);
  const spine = ridged(wx / 560 + 2.2, wz / 560 - 6.1, 3);
  const mountain = inland * Math.pow(spine, 1.7);
  lastMountain = mountain;
  let h = land * 60;
  h += mountain * 150;
  h += fbm(wx / 170 + 1.7, wz / 170 + 8.3, 2, 5.5) * 9 * smooth01(land / 0.08);   // hills, faded out at the shore
  return h * SCALE;   // the land grows with the map; the sea floor keeps its depths, so the water looks the same
}
const smooth01 = (t) => { t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); };

// ---------------------------------------------------------------- the grid
let H = null, M = null, F = null, LEVEL = null, WATER = null, KINDS = null, DOWN = null, ACC = null;

/** Binary min-heap of cell indices keyed by a float array. */
class Heap {
  constructor(key) { this.key = key; this.a = []; }
  push(v) { const a = this.a, k = this.key; a.push(v); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (k[a[p]] <= k[a[i]]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; } }
  pop() {
    const a = this.a, k = this.key, top = a[0], last = a.pop();
    if (a.length) { a[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < a.length && k[a[l]] < k[a[m]]) m = l; if (r < a.length && k[a[r]] < k[a[m]]) m = r; if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; } }
    return top;
  }
  get size() { return this.a.length; }
}

const NB8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const NB4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const RIVER_MIN = 170;               // cells of catchment before a stream shows

/** Step 1 for rows [r0, r1): the smooth height and the mountain weight of every cell in them. Each cell stands alone,
 *  so the rows can be shared out between workers and stitched back together (see prepare.js). */
export function heightRows(r0, r1) {
  const h = new Float32Array((r1 - r0) * W), m = new Float32Array((r1 - r0) * W);
  for (let a = r0; a < r1; a++) for (let b = 0; b < W; b++) {
    const c = (a - r0) * W + b;
    h[c] = smoothHeight((a - N - 1) * CELL, (b - N - 1) * CELL); m[c] = lastMountain;
  }
  return { h, m };
}

/** The whole grid, here and now. The game boots through prepare.js instead, which builds it in workers and hands
 *  it over with `adoptGrid`; this is what runs when there are no workers, and in Node. */
export function ensureGrid() {
  if (gridArrays().H) return;
  const { h, m } = heightRows(0, W);
  finishGrid(h, m);
}

/** Steps 2 to 6 over finished heights: flood, drain, classify the water, terrace, name the ground. */
export function finishGrid(heights, mountain) {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const size = W * W;
  H = heights; M = mountain; F = new Float32Array(size);
  LEVEL = new Int16Array(size); WATER = new Float32Array(size).fill(-1); KINDS = new Uint8Array(size);
  DOWN = new Int32Array(size).fill(-1); ACC = new Float32Array(size).fill(1);

  // 2. priority flood: fill every depression up to its spill point. A hair of slope keeps flats draining.
  F.fill(Infinity);
  const heap = new Heap(F);
  const closed = new Uint8Array(size);
  // (Every sea cell is a source, but only one with land beside it can ever raise anything: the open sea, four
  // fifths of the grid, stays out of the heap.)
  for (let c = 0; c < size; c++) if (H[c] <= 0) { F[c] = H[c]; closed[c] = 1; }
  for (let c = 0; c < size; c++) {
    if (!closed[c]) continue;
    const ci = Math.floor(c / W), cj = c % W;
    let shore = false;
    for (let k = 0; k < 8 && !shore; k++) { const ni = ci + NB8[k][0], nj = cj + NB8[k][1]; shore = ni >= 0 && nj >= 0 && ni < W && nj < W && !closed[ni * W + nj]; }
    if (shore) heap.push(c);
  }
  while (heap.size) {
    const c = heap.pop();
    const ci = Math.floor(c / W), cj = c % W;
    for (let k = 0; k < 8; k++) {
      const ni = ci + NB8[k][0], nj = cj + NB8[k][1];
      if (ni < 0 || nj < 0 || ni >= W || nj >= W) continue;
      const n = ni * W + nj;
      if (closed[n]) continue;
      closed[n] = 1;
      F[n] = Math.max(H[n], F[c] + 0.002);
      heap.push(n);
    }
  }

  // 3. drain: every land cell flows to its lowest neighbour on the filled surface; rain accumulates downhill.
  const order = new Int32Array(size);
  let nLand = 0;
  for (let c = 0; c < size; c++) {
    if (F[c] <= 0) continue;
    order[nLand++] = c;
    const ci = Math.floor(c / W), cj = c % W;
    let best = -1, bestF = F[c];
    for (let k = 0; k < 8; k++) {
      const ni = ci + NB8[k][0], nj = cj + NB8[k][1];
      if (ni < 0 || nj < 0 || ni >= W || nj >= W) continue;
      const n = ni * W + nj;
      if (F[n] < bestF) { bestF = F[n]; best = n; }
    }
    DOWN[c] = best;
  }
  const land = order.subarray(0, nLand);
  land.sort((a, b) => F[b] - F[a]);
  for (const c of land) if (DOWN[c] >= 0) ACC[DOWN[c]] += ACC[c];

  // 4. classify water: lakes where the flood raised the surface, rivers where enough rain gathers.
  const isLake = new Uint8Array(size), isRiver = new Uint8Array(size);
  for (let c = 0; c < size; c++) {
    if (F[c] <= 0) continue;
    if (F[c] > H[c] + 0.4 && F[c] > 3.5) isLake[c] = 1;
    else if (ACC[c] >= RIVER_MIN) isRiver[c] = 1;
  }
  // wide rivers: big catchments spill onto their 4-neighbours
  const wide = [];
  for (let c = 0; c < size; c++) if (isRiver[c] && ACC[c] >= RIVER_MIN * 3) wide.push(c);
  for (const c of wide) {
    const ci = Math.floor(c / W), cj = c % W;
    for (const [di, dj] of NB4) {
      const n = (ci + di) * W + (cj + dj);
      if (n >= 0 && n < size && !isLake[n] && F[n] > 0 && !isRiver[n]) { isRiver[n] = 1; DOWN[n] = c; F[n] = Math.max(F[n], F[c]); }
    }
  }

  // 5. terraces. Land: quantize the smooth height. Lakes: sink the floor under the surface. Rivers: cut a channel
  //    one terrace below the banks, never rising downstream.
  for (let c = 0; c < size; c++) {
    if (isLake[c]) {
      LEVEL[c] = Math.min(levelOfHeight(H[c]), levelOfHeight(F[c] - 0.5) - 1);
      if (LEVEL[c] <= 0) { LEVEL[c] = 0; isLake[c] = 0; continue; }
      WATER[c] = F[c] - 0.3;
    } else LEVEL[c] = levelOfHeight(H[c]);
  }
  for (const c of land) {
    if (!isRiver[c]) continue;
    const ci = Math.floor(c / W), cj = c % W;
    let bank = 99;
    for (const [di, dj] of NB4) {
      const n = (ci + di) * W + (cj + dj);
      if (n < 0 || n >= size || isRiver[n] || isLake[n]) continue;
      bank = Math.min(bank, LEVEL[n]);
    }
    LEVEL[c] = Math.min(levelOfHeight(H[c]), (bank === 99 ? levelOfHeight(F[c]) : bank) - 1);
  }
  for (const c of land) {                       // downstream never higher than upstream (land is sorted high → low)
    if (!isRiver[c]) continue;
    const d = DOWN[c];
    if (d >= 0 && isRiver[d]) LEVEL[d] = Math.min(LEVEL[d], LEVEL[c]);
  }
  for (const c of land) {
    if (!isRiver[c]) continue;
    if (LEVEL[c] <= 0) { LEVEL[c] = 0; isRiver[c] = 0; continue; }   // the mouth: it is the sea now
    const L = LEVEL[c];
    WATER[c] = TOPS[L] + 0.6 * (levelTop(L + 1) - TOPS[L]);
  }

  // 6. kinds
  for (let c = 0; c < size; c++) {
    if (LEVEL[c] === 0) { KINDS[c] = KIND.SEA; continue; }
    if (isLake[c]) { KINDS[c] = KIND.LAKE; continue; }
    if (isRiver[c]) { KINDS[c] = KIND.RIVER; continue; }
    const ci = Math.floor(c / W), cj = c % W;
    const top = TOPS[LEVEL[c]], m = M[c];
    let steep = 0, wet = false;
    for (const [di, dj] of NB4) {
      const n = (ci + di) * W + (cj + dj);
      if (n < 0 || n >= size) continue;
      steep = Math.max(steep, LEVEL[c] - LEVEL[n]);
      if (LEVEL[n] === 0 || WATER[n] >= 0) wet = true;
    }
    const x = (ci - N - 1) * CELL, z = (cj - N - 1) * CELL;
    const snowline = (112 + n2(x / (260 * SCALE) + 9.1, z / (260 * SCALE) + 2.4, 21.7) * 26) * SCALE;
    if (top >= snowline) KINDS[c] = KIND.SNOW;
    else if (top >= 90 * SCALE || (m > 0.45 && top >= 54 * SCALE)) KINDS[c] = KIND.STONE;
    else if ((m > 0.3 && top >= 24 * SCALE) || steep >= 3) KINDS[c] = KIND.ROCK;
    else if (top <= 6 * SCALE && m < 0.25) KINDS[c] = wet ? KIND.WETSAND : KIND.SAND;
    else if (top <= 42 * SCALE) KINDS[c] = KIND.GRASS;
    else KINDS[c] = KIND.MEADOW;
  }

  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  if (typeof console !== 'undefined') console.info(`terrain: ${W}x${W} cells, ${nLand} land, flooded and terraced in ${Math.round(t1 - t0)} ms`);
  adoptGrid({ H, LEVEL, WATER, KINDS });
  H = M = F = LEVEL = WATER = KINDS = DOWN = ACC = null;   // the queries have what they read; the rest was scaffolding
}
onMissingGrid(ensureGrid);
