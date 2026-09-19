// Everything about the world that is computed once from the terrain grid and never again: the land's geometry, the
// baked light over it, the water's noise. No renderer in here, only arrays out, so it all runs in workers while the
// page starts (see prepare.js and boot.worker.js) and the page only wraps the results in meshes and textures.
import { Color, MathUtils, DataUtils } from 'three';
import { levelAtCell, cellKind, cellTop, levelTop, KIND, N, CELL, SCALE, WORLD_SIZE } from './terrain.js';
import { mulberry32 } from './rng.js';

// ---------------------------------------------------------------- terrain colors
// Tops by kind (grass darkens with altitude); walls are dirt under grass, sand under beaches, the rock's own color
// elsewhere. Strata bands and per-block tone come from the material, not the vertices, so flat runs can merge.
const C = (hex) => new Color(hex);
const TOP = {
  [KIND.SAND]: C(0xf5e0a0), [KIND.WETSAND]: C(0xd9c07a), [KIND.ROCK]: C(0x9c7a55), [KIND.STONE]: C(0x8d8f93), [KIND.SNOW]: C(0xfdfbf6),
  [KIND.LAKE]: C(0xc9b98a), [KIND.RIVER]: C(0xc4b07a),
};
const GRASS_LO = C(0xa9e05c), GRASS_HI = C(0x3f9e5c);
const WALL = { dirt: C(0xa27a52), sand: C(0xd8c17f), rock: C(0x8f6a45), stone: C(0x7c7e83), snow: C(0x9ea2a8) };
const tmpC = new Color();
function topColor(i, j, out) {
  const k = cellKind(i, j), top = cellTop(i, j);
  if (k === KIND.GRASS || k === KIND.MEADOW) return out.copy(GRASS_LO).lerp(GRASS_HI, MathUtils.clamp(top / (66 * SCALE), 0, 1));
  return out.copy(TOP[k] || GRASS_LO);
}
function wallColor(kind, out) {
  if (kind === KIND.GRASS || kind === KIND.MEADOW) return out.copy(WALL.dirt);
  if (kind === KIND.SAND || kind === KIND.WETSAND || kind === KIND.LAKE || kind === KIND.RIVER) return out.copy(WALL.sand);
  if (kind === KIND.ROCK) return out.copy(WALL.rock);
  if (kind === KIND.SNOW) return out.copy(WALL.snow);
  return out.copy(WALL.stone);
}

// ---------------------------------------------------------------- the land (voxel columns, greedy-merged)
/** The land as chunks of indexed quads: [{ position, normal, color, lip, topcol, index }], typed arrays. */
export function buildLand() {
  const t0 = performance.now();
  // The land is cut into a 4x4 grid of meshes so each pass draws only the part it can see: the shadow map covers a
  // sixteenth of the map, the view and the water's mirror about half. A quad belongs to the chunk its first corner
  // is in (a long merged run may reach into the next one; the chunk's bounds are measured from what it holds).
  // Four corners and six indices a quad.
  const CHUNKS = 4, chunkSize = WORLD_SIZE / CHUNKS;
  const chunks = Array.from({ length: CHUNKS * CHUNKS }, () => ({ pos: [], nrm: [], colr: [], lip: [], topcol: [], idx: [] }));
  const chunkAt = (x, z) => chunks[MathUtils.clamp(Math.floor((x + WORLD_SIZE / 2) / chunkSize), 0, CHUNKS - 1) * CHUNKS + MathUtils.clamp(Math.floor((z + WORLD_SIZE / 2) / chunkSize), 0, CHUNKS - 1)];
  const NO_LIP = -1000;
  const corners = (c, ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, nx, ny, nz) => {
    const v = c.pos.length / 3;
    c.pos.push(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz);
    c.nrm.push(nx, ny, nz, nx, ny, nz, nx, ny, nz, nx, ny, nz);
    c.idx.push(v, v + 1, v + 2, v, v + 2, v + 3);
  };
  const quad = (ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, nx, ny, nz, col) => {
    const c = chunkAt(ax, az);
    corners(c, ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, nx, ny, nz);
    for (let k = 0; k < 4; k++) { c.colr.push(col.r, col.g, col.b); c.lip.push(NO_LIP); c.topcol.push(0, 0, 0); }
  };
  // Wall quad with per-vertex color: a/d are the bottom corners (lo color), b/c the top corners (hi color).
  // `fringe` is the top face's color when grass should hang over the lip, else null.
  const wallQuad = (ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, nx, ny, nz, hi, lo, fringe) => {
    const c = chunkAt(ax, az);
    corners(c, ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, nx, ny, nz);
    c.colr.push(lo.r, lo.g, lo.b, hi.r, hi.g, hi.b, hi.r, hi.g, hi.b, lo.r, lo.g, lo.b);
    for (let k = 0; k < 4; k++) { c.lip.push(fringe ? by : NO_LIP); c.topcol.push(fringe ? fringe.r : 0, fringe ? fringe.g : 0, fringe ? fringe.b : 0); }
  };
  const S = 2 * N;
  const at = (i, j) => (i + N) * S + (j + N);
  const half = CELL / 2, SEA_BOTTOM = -8;

  // per-cell top color key: kind/altitude color darkened by baked occlusion, quantized so equal cells merge
  const level = new Int16Array(S * S), key = new Int32Array(S * S), kinds = new Uint8Array(S * S);
  const palette = [], paletteKind = [], paletteIndex = new Map();
  const colorId = (c, kind) => { const h = c.getHex(); let id = paletteIndex.get(h); if (id === undefined) { id = palette.length; palette.push(c.clone()); paletteKind.push(kind); paletteIndex.set(h, id); } return id; };
  for (let i = -N; i < N; i++) for (let j = -N; j < N; j++) {
    const L = levelAtCell(i, j), c = at(i, j);
    level[c] = L; kinds[c] = cellKind(i, j);
    if (L === 0) continue;
    topColor(i, j, tmpC);
    let higher = 0;
    if (levelAtCell(i + 1, j) > L) higher++; if (levelAtCell(i - 1, j) > L) higher++;
    if (levelAtCell(i, j + 1) > L) higher++; if (levelAtCell(i, j - 1) > L) higher++;
    tmpC.multiplyScalar(1 - higher * 0.05);
    key[c] = (L << 16) | colorId(tmpC, kinds[c]);
  }

  // tops: greedy rectangles of equal level and color
  const done = new Uint8Array(S * S);
  for (let j = -N; j < N; j++) for (let i = -N; i < N; i++) {
    const c = at(i, j);
    if (done[c] || level[c] === 0) continue;
    const k = key[c];
    let w = 1;
    while (i + w < N && !done[at(i + w, j)] && level[at(i + w, j)] > 0 && key[at(i + w, j)] === k) w++;
    let h = 1;
    outer: while (j + h < N) {
      for (let a = 0; a < w; a++) { const cc = at(i + a, j + h); if (done[cc] || level[cc] === 0 || key[cc] !== k) break outer; }
      h++;
    }
    for (let b = 0; b < h; b++) for (let a = 0; a < w; a++) done[at(i + a, j + b)] = 1;
    const top = levelTop(level[c]), x0 = i * CELL - half, x1 = (i + w - 1) * CELL + half, z0 = j * CELL - half, z1 = (j + h - 1) * CELL + half;
    quad(x0, top, z0, x0, top, z1, x1, top, z1, x1, top, z0, 0, 1, 0, palette[k & 0xffff]);
  }

  // walls: one per level drop between neighbours, merged along runs of equal height and color
  const hi = new Color(), lo = new Color();
  const emitWall = (dir, i0, j0, len, L, nl, cid) => {
    const top = levelTop(L), bottom = nl === 0 ? SEA_BOTTOM : levelTop(nl), kind = paletteKind[cid];
    wallColor(kind, hi).multiplyScalar(0.9);
    lo.copy(hi).multiplyScalar(nl === 0 ? 0.86 : 0.78);
    const fringe = (kind === KIND.GRASS || kind === KIND.MEADOW) ? palette[cid] : null;
    const x = i0 * CELL, z = j0 * CELL;
    if (dir === 0) { const xa = x + half, za = z - half, zb = z - half + len * CELL; wallQuad(xa, bottom, za, xa, top, za, xa, top, zb, xa, bottom, zb, 1, 0, 0, hi, lo, fringe); }
    else if (dir === 1) { const xa = x - half, zb = z - half, za = z - half + len * CELL; wallQuad(xa, bottom, za, xa, top, za, xa, top, zb, xa, bottom, zb, -1, 0, 0, hi, lo, fringe); }
    else if (dir === 2) { const za = z + half, xa = x - half + len * CELL, xb = x - half; wallQuad(xa, bottom, za, xa, top, za, xb, top, za, xb, bottom, za, 0, 0, 1, hi, lo, fringe); }
    else { const za = z - half, xa = x - half, xb = x - half + len * CELL; wallQuad(xa, bottom, za, xa, top, za, xb, top, za, xb, bottom, za, 0, 0, -1, hi, lo, fringe); }
  };
  const wallKey = (c, n) => { const L = level[c], nl = n < 0 ? 0 : level[n]; return nl < L ? ((L << 24) | (nl << 12) | (key[c] & 0xfff)) : -1; };
  const neighbour = (i, j) => (i >= -N && i < N && j >= -N && j < N) ? at(i, j) : -1;
  for (let dir = 0; dir < 4; dir++) {
    const di = dir === 0 ? 1 : dir === 1 ? -1 : 0, dj = dir === 2 ? 1 : dir === 3 ? -1 : 0;
    const alongJ = dir < 2;   // ±x walls run along j, ±z walls along i
    for (let u = -N; u < N; u++) {
      let run = -1, runStart = 0, runLen = 0;
      for (let v = -N; v <= N; v++) {
        let k = -1;
        if (v < N) {
          const i = alongJ ? u : v, j = alongJ ? v : u;
          const c = at(i, j);
          if (level[c] > 0) k = wallKey(c, neighbour(i + di, j + dj));
        }
        if (k === run && k !== -1) { runLen++; continue; }
        if (run !== -1) emitWall(dir, alongJ ? u : runStart, alongJ ? runStart : u, runLen, run >> 24, (run >> 12) & 0xfff, run & 0xfff);
        run = k; runStart = v; runLen = 1;
      }
    }
  }

  // shallows: a foam ring around every coastline, sitting just above the swell, merged along runs
  const foam = new Color(0xd8fff7);
  for (let j = -N; j < N; j++) {
    let start = -1;
    for (let i = -N; i <= N; i++) {
      let ring = false;
      if (i < N && level[at(i, j)] === 0) ring = levelAtCell(i + 1, j) > 0 || levelAtCell(i - 1, j) > 0 || levelAtCell(i, j + 1) > 0 || levelAtCell(i, j - 1) > 0;
      if (ring && start < 0) start = i;
      if (!ring && start >= 0) { const x0 = start * CELL - half, x1 = (i - 1) * CELL + half, z = j * CELL, y = 0.5; quad(x0, y, z - half, x0, y, z + half, x1, y, z + half, x1, y, z - half, 0, 1, 0, foam); start = -1; }
    }
  }

  const out = chunks.filter((c) => c.idx.length).map((c) => ({
    position: new Float32Array(c.pos), normal: new Float32Array(c.nrm), color: new Float32Array(c.colr),
    lip: new Float32Array(c.lip), topcol: new Float32Array(c.topcol), index: new Uint32Array(c.idx),
  }));
  console.info(`land: ${out.reduce((n, c) => n + c.position.length / 3, 0)} vertices in ${out.length} chunks, ${Math.round(performance.now() - t0)} ms`);
  return out;
}

// ---------------------------------------------------------------- baked light: ambient occlusion and far sun shadows
// The sun is fixed for a run and the terrain never moves, so two things are baked once into one texture over the
// grid, and read per pixel by world position (the greedy-merged mesh has no vertices where they would be needed):
//  R    sky visibility: how much of the sky a cell sees, from the horizon angle in eight directions (ambient occlusion
//       for the terraces, creases and valley floors)
//  GBA  sun occlusion for morning, noon and golden hour: whether higher ground toward the sun blocks it, marched on a
//       half-resolution grid. Beyond the reach of the real shadow map this is what shades the far hills and valleys.
// Each channel is its own job (one grid-sized byte array out), so the four of them can run side by side.
export const OCCLUSION_W = 2 * N + 2;
const tops = () => {
  const W = OCCLUSION_W, top = new Float32Array(W * W);
  for (let i = -N - 1; i <= N; i++) for (let j = -N - 1; j <= N; j++) top[(i + N + 1) * W + (j + N + 1)] = cellTop(i, j);
  return top;
};

/** Sky visibility: the steepest slope up in each of eight directions, one atan per direction. */
export function bakeSky() {
  const W = OCCLUSION_W, top = tops(), out = new Uint8Array(W * W);
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]], STEPS = [1, 2, 3, 5, 8, 12];
  const offs = DIRS.map(([da, db]) => STEPS.map((s) => [da * s * W + db * s, 1 / (s * CELL * (da && db ? 1.414 : 1))]));
  const PAD = 12;
  for (let a = 0; a < W; a++) for (let b = 0; b < W; b++) {
    const c = a * W + b, h = top[c];
    const inside = a >= PAD && a < W - PAD && b >= PAD && b < W - PAD;
    let occ = 0;
    for (let k = 0; k < 8; k++) {
      let best = 0;
      const o = offs[k];
      if (inside) { for (let q = 0; q < 6; q++) { const sl = (top[c + o[q][0]] - h) * o[q][1]; if (sl > best) best = sl; } }
      if (best > 0) occ += Math.min(1, Math.atan(best) / (Math.PI * 0.5));
    }
    occ /= 8;
    out[c] = Math.round(255 * (1 - 0.8 * Math.pow(occ, 1.1)));
  }
  return out;
}

/** Sun occlusion for a sun in direction `d`, on every other cell (copied into its 2x2 block; linear filtering softens
 *  the edges): march toward the sun along precomputed grid offsets and stop at the first higher ground that blocks it. */
export function bakeSun(d) {
  const W = OCCLUSION_W, top = tops(), out = new Uint8Array(W * W);
  const hl = Math.hypot(d[0], d[2]), ux = d[0] / hl, uz = d[2] / hl, slope = d[1] / hl;
  const steps = [];
  for (let s = 1; s <= 64; s += s < 16 ? 1 : 2) steps.push([Math.round(ux * s) * W + Math.round(uz * s), s * CELL * slope + 0.6, Math.round(ux * s), Math.round(uz * s)]);
  const M = 66;
  for (let a = 0; a < W; a += 2) for (let b = 0; b < W; b += 2) {
    const c = a * W + b, h = top[c];
    let lit = 255;
    const inside = a >= M && a < W - M && b >= M && b < W - M;
    for (let q = 0; q < steps.length; q++) {
      const st = steps[q];
      let hh;
      if (inside) hh = top[c + st[0]];
      else { const aa = Math.min(W - 1, Math.max(0, a + st[2])), bb = Math.min(W - 1, Math.max(0, b + st[3])); hh = top[aa * W + bb]; }
      if (hh > h + st[1]) { lit = 0; break; }
    }
    out[c] = lit;
    if (b + 1 < W) out[c + 1] = lit;
    if (a + 1 < W) { out[c + W] = lit; if (b + 1 < W) out[c + W + 1] = lit; }
  }
  return out;
}

// ---------------------------------------------------------------- the water's noise
// The water's three noises (gusts, the shimmer of the shallows, the foam's edge) are 3D Perlin noise over (x, z, time).
// Evaluated in the shader that is eight hashed gradients and a quintic blend, three times over, on every pixel of
// the sea. Here the same noise is evaluated once, at load, into a volume that tiles in all three axes, and the shader
// reads it with one filtered sample each. 32 lattice cells across at 8 texels a cell, 8 cells deep in time at 4.
export const NOISE = { cells: 32, cellsT: 8, size: 256, sizeT: 32 };
/** The volume as half floats, x fastest, then z, then time. */
export function bakeNoise() {
  const { cells, cellsT, size, sizeT } = NOISE;
  const r = mulberry32(90210), perm = new Uint8Array(512);
  for (let i = 0; i < 256; i++) perm[i] = i;
  for (let i = 255; i > 0; i--) { const j = Math.floor(r() * (i + 1)), t = perm[i]; perm[i] = perm[j]; perm[j] = t; }
  for (let i = 0; i < 256; i++) perm[i + 256] = perm[i];
  const grad = (h, x, y, z) => { h &= 15; const u = h < 8 ? x : y, v = h < 4 ? y : (h === 12 || h === 14 ? x : z); return ((h & 1) ? -u : u) + ((h & 2) ? -v : v); };
  // per axis, per texel: the lattice cell (wrapped to the period), the cell after it, the offset into it and its fade
  const axis = (n, period) => {
    const i0 = new Uint8Array(n), i1 = new Uint8Array(n), f = new Float32Array(n), w = new Float32Array(n);
    for (let k = 0; k < n; k++) { const c = (k + 0.5) * period / n, i = Math.floor(c), t = c - i; i0[k] = i % period; i1[k] = (i + 1) % period; f[k] = t; w[k] = t * t * t * (t * (t * 6 - 15) + 10); }
    return { i0, i1, f, w };
  };
  const X = axis(size, cells), Z = axis(sizeT, cellsT);
  const data = new Uint16Array(size * size * sizeT), half = DataUtils.toHalfFloat;
  let o = 0;
  for (let c = 0; c < sizeT; c++) {
    const zf = Z.f[c], zw = Z.w[c], pz0 = Z.i0[c], pz1 = Z.i1[c];
    for (let b = 0; b < size; b++) {
      const yf = X.f[b], yw = X.w[b], py0 = perm[X.i0[b]], py1 = perm[X.i1[b]];
      for (let a = 0; a < size; a++) {
        const xf = X.f[a], xw = X.w[a], px0 = X.i0[a], px1 = X.i1[a];
        const h00 = perm[perm[px0 + py0 & 255] + pz0], h10 = perm[perm[px1 + py0 & 255] + pz0], h01 = perm[perm[px0 + py1 & 255] + pz0], h11 = perm[perm[px1 + py1 & 255] + pz0];
        const k00 = perm[perm[px0 + py0 & 255] + pz1], k10 = perm[perm[px1 + py0 & 255] + pz1], k01 = perm[perm[px0 + py1 & 255] + pz1], k11 = perm[perm[px1 + py1 & 255] + pz1];
        const n00 = grad(h00, xf, yf, zf), n10 = grad(h10, xf - 1, yf, zf), n01 = grad(h01, xf, yf - 1, zf), n11 = grad(h11, xf - 1, yf - 1, zf);
        const m00 = grad(k00, xf, yf, zf - 1), m10 = grad(k10, xf - 1, yf, zf - 1), m01 = grad(k01, xf, yf - 1, zf - 1), m11 = grad(k11, xf - 1, yf - 1, zf - 1);
        const lo = n00 + (n10 - n00) * xw, hi = n01 + (n11 - n01) * xw, near = lo + (hi - lo) * yw;
        const lo2 = m00 + (m10 - m00) * xw, hi2 = m01 + (m11 - m01) * xw, far = lo2 + (hi2 - lo2) * yw;
        data[o++] = half((near + (far - near) * zw) * 0.982);
      }
    }
  }
  return data;
}
