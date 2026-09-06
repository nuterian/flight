// Pure-JS terrain shared by rendering, collision and AI. No Three imports so it can be unit-tested in Node.
//
// The land is composed rather than sampled from one noise: warped continent noise for the coastlines, ridged noise
// for mountain spines, small hills on top. That smooth field is then processed on a 5-unit grid: depressions are
// flooded into lakes, rain is drained downhill into rivers that carve valleys, and the result is quantized into
// terraces whose height grows with altitude (3-unit steps on the shore, 6 in the hills, 12 in the mountains).
import { ImprovedNoise } from 'three/addons/math/ImprovedNoise.js';

// The geology is designed on a 3200-unit map of 5-unit columns and then scaled up: every column is SCALE times
// wider and the land SCALE times taller, so the same islands, rivers and terraces come out larger against the
// trees, the houses and the plane, at the same grid cost.
export const SCALE = 1.4;
const BASE_SIZE = 3200, BASE_CELL = 5;
export const WORLD_SIZE = BASE_SIZE * SCALE;      // terrain extent
/** Combat zone: an invisible box. Leaving it starts a 10 second countdown. */
export const BOUNDS = { half: 1500 * SCALE, ceiling: 720, grace: 10 };
export const SEA_LEVEL = 0;
export const CELL = BASE_CELL * SCALE;            // voxel column footprint
export const N = WORLD_SIZE / CELL / 2;   // cells from the centre to the edge
const W = 2 * N + 2;                 // grid width, one guard cell on each side
export const KIND = { SEA: 0, LAKE: 1, RIVER: 2, SAND: 3, WETSAND: 4, GRASS: 5, MEADOW: 6, ROCK: 7, STONE: 8, SNOW: 9 };

// Terrace tops. Level L occupies [TOPS[L-1], TOPS[L]) and its top face sits at TOPS[L]; level 0 is the sea bed.
export const TOPS = [0];
for (let t = 3; t <= 12; t += 3) TOPS.push(t * SCALE);
for (let t = 18; t <= 60; t += 6) TOPS.push(t * SCALE);
for (let t = 72; t <= 252; t += 12) TOPS.push(t * SCALE);
export const levelTop = (L) => TOPS[Math.min(Math.max(L, 0), TOPS.length - 1)];
export function levelOfHeight(h) {
  if (h < 0) return 0;
  let L = 1;
  while (L < TOPS.length - 1 && TOPS[L] <= h) L++;
  return L;
}

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
const idx = (i, j) => (i + N + 1) * W + (j + N + 1);

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

export function ensureGrid() {
  if (H) return;
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const size = W * W;
  H = new Float32Array(size); M = new Float32Array(size); F = new Float32Array(size);
  LEVEL = new Int16Array(size); WATER = new Float32Array(size).fill(-1); KINDS = new Uint8Array(size);
  DOWN = new Int32Array(size).fill(-1); ACC = new Float32Array(size).fill(1);

  // 1. smooth heights
  for (let i = -N - 1; i <= N; i++) for (let j = -N - 1; j <= N; j++) {
    const c = idx(i, j);
    H[c] = smoothHeight(i * CELL, j * CELL); M[c] = lastMountain;
  }

  // 2. priority flood: fill every depression up to its spill point. A hair of slope keeps flats draining.
  F.fill(Infinity);
  const heap = new Heap(F);
  const closed = new Uint8Array(size);
  for (let c = 0; c < size; c++) if (H[c] <= 0) { F[c] = H[c]; closed[c] = 1; heap.push(c); }
  while (heap.size) {
    const c = heap.pop();
    const ci = Math.floor(c / W), cj = c % W;
    for (const [di, dj] of NB8) {
      const ni = ci + di, nj = cj + dj;
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
    for (const [di, dj] of NB8) {
      const ni = ci + di, nj = cj + dj;
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
  if (typeof console !== 'undefined') console.info(`terrain: ${W}x${W} cells, ${nLand} land in ${Math.round(t1 - t0)} ms`);
}

// ---------------------------------------------------------------- queries
const cellI = (x) => Math.round(x / CELL), cellJ = (z) => Math.round(z / CELL);
const inGrid = (i, j) => i >= -N - 1 && i <= N && j >= -N - 1 && j <= N;

/** Smooth (un-terraced) terrain height at (x, z), bilinear over the grid. Negative below sea level. */
export function heightAt(x, z) {
  ensureGrid();
  const fi = x / CELL, fj = z / CELL;
  const i0 = Math.floor(fi), j0 = Math.floor(fj);
  if (!inGrid(i0, j0) || !inGrid(i0 + 1, j0 + 1)) return -40;
  const tx = fi - i0, tz = fj - j0;
  const a = H[idx(i0, j0)], b = H[idx(i0 + 1, j0)], c = H[idx(i0, j0 + 1)], d = H[idx(i0 + 1, j0 + 1)];
  return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
}

/** Terrace level of a column: 0 = sea, 1 = first terrace, ... */
export function levelAtCell(i, j) { ensureGrid(); return inGrid(i, j) ? LEVEL[idx(i, j)] : 0; }
export function cellKind(i, j) { ensureGrid(); return inGrid(i, j) ? KINDS[idx(i, j)] : KIND.SEA; }
/** Surface height of lake or river water over a cell, or -1 when there is none (the sea is level 0). */
export function cellWater(i, j) { ensureGrid(); return inGrid(i, j) ? WATER[idx(i, j)] : -1; }
export function cellTop(i, j) { return levelTop(levelAtCell(i, j)); }
export function mountainAt(i, j) { ensureGrid(); return inGrid(i, j) ? M[idx(i, j)] : 0; }

/** Walkable ground height under (x, z): the terrace top, or the water surface over sea, lake or river. */
export function groundAt(x, z) {
  ensureGrid();
  const i = cellI(x), j = cellJ(z);
  if (!inGrid(i, j)) return SEA_LEVEL;
  const c = idx(i, j);
  if (LEVEL[c] === 0) return SEA_LEVEL;
  if (WATER[c] >= 0) return WATER[c];
  return TOPS[LEVEL[c]];
}
export function isWaterAt(x, z) {
  ensureGrid();
  const i = cellI(x), j = cellJ(z);
  if (!inGrid(i, j)) return true;
  const c = idx(i, j);
  return LEVEL[c] === 0 || WATER[c] >= 0;
}
export function isSeaAt(x, z) { return levelAtCell(cellI(x), cellJ(z)) === 0; }
/** What kind of ground lies under (x, z). */
export function kindAt(x, z) { return cellKind(cellI(x), cellJ(z)); }
