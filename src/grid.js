// The terrain as the game reads it: the constants of the map, the finished grid, and the ground queries over it
// that rendering, collision and the AI share. No imports at all, so the script that starts the world's workers
// (prepare.js) can load this, and nothing else, before the rest of the game has even been parsed. The grid itself is
// made in terrain.js, which hands it over with `adoptGrid`.

// The geology is designed on a 3200-unit map of 5-unit columns and then scaled up: every column is SCALE times
// wider and the land SCALE times taller, so the same islands, rivers and terraces come out larger against the
// trees, the houses and the plane, at the same grid cost.
export const SCALE = 1.4;
export const BASE_SIZE = 3200;
const BASE_CELL = 5;
export const WORLD_SIZE = BASE_SIZE * SCALE;      // terrain extent
/** Combat zone: an invisible box. Leaving it starts a 10 second countdown. */
export const BOUNDS = { half: 1500 * SCALE, ceiling: 720, grace: 10 };
export const SEA_LEVEL = 0;
export const CELL = BASE_CELL * SCALE;            // voxel column footprint
export const N = WORLD_SIZE / CELL / 2;   // cells from the centre to the edge
const W = 2 * N + 2;                 // grid width, one guard cell on each side
/** Grid rows (and columns), guard cells included. */
export const ROWS = W;
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

// ---------------------------------------------------------------- the grid
let H = null, LEVEL = null, WATER = null, KINDS = null;
const idx = (i, j) => (i + N + 1) * W + (j + N + 1);
/** What the queries below read, for handing a finished grid from a worker to the page. */
export function gridArrays() { return { H, LEVEL, WATER, KINDS }; }
export function adoptGrid(g) { H = g.H; LEVEL = g.LEVEL; WATER = g.WATER; KINDS = g.KINDS; }
/** A query on a grid that is not there yet builds it on the spot, if the generator is loaded (terrain.js registers
 *  itself here). The game never gets that far: it boots through prepare.js, which adopts a grid first. */
let generate = null;
export function onMissingGrid(fn) { generate = fn; }
function ensureGrid() { if (H) return; if (!generate) throw new Error('terrain: no grid yet'); generate(); }

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
