import * as THREE from 'three/webgpu';
import {
  color, positionLocal, positionWorld, normalize, mix, smoothstep, dot, float, vec2, vec3, attribute, time, sin, cos,
  saturate, pow, uniform, fog, rangeFogFactor, instanceIndex, hash, cameraPosition, reflect, transformNormalToView, mx_noise_float, reflector, uv, abs, fract, max as tslMax, min as tslMin, length, exp, floor, select, normalWorld, vertexColor, step, dot as tslDot, luminance, positionView,
} from 'three/tsl';
import { ensureGrid, heightAt, levelAtCell, cellKind, cellWater, cellTop, levelTop, waterfalls, isSeaAt, KIND, N as HALF_CELLS, CELL, BOUNDS } from './terrain.js';
import { Boxes, local, softParam, STRIP } from './boxes.js';
import { Trails } from './trails.js';
import { buildLandmarks, findArenas } from './landmarks.js';

// Bold, saturated storybook palette.
export const PALETTE = {
  shallow: 0x3fe6d4, deep: 0x1a74e8, foam: 0xffffff, floorSand: 0xf3dc93, floorDeep: 0x1c6f9a,
  sky: 0x2f7fe6, horizon: 0xbfe0ff, fogColor: 0xbfe0ff, cloud: 0xffffff, sunGlow: 0xffc27a,
  trunk: 0xb8743d, leaf: 0x3fc45f, leafDark: 0x2ea24d,
};
export const SUN_DIR = new THREE.Vector3(0.5, 0.7, 0.5).normalize();   // mutated in place by setTimeOfDay
// Time of day: a sun direction and the tints that go with it. High noon is the original look; morning is cool
// and clear with the sun low in the east; golden hour is warm with long shadows. Everything stays readable.
export const TIMES = {
  morning: { dir: [0.85, 0.4, 0.25], sun: [0xfff8ec, 3.0], hemi: [0xb2d8ff, 0xd8c8a6, 1.35], fog: 0xd8e8f6, skyTop: 0x3f8ce9, skyMid: 0x93cdff, horizon: 0xe2f0ff, glow: 0xffe0b0, disc: 0xfff8ea },
  noon: { dir: [0.5, 0.7, 0.5], sun: [0xfff1d8, 3.3], hemi: [0x9fd0ff, 0xe4c58c, 1.25], fog: 0xbfe0ff, skyTop: 0x2f7fe6, skyMid: 0x7fc4ff, horizon: 0xbfe0ff, glow: 0xffc27a, disc: 0xfff3d6 },
  golden: { dir: [-0.62, 0.3, 0.55], sun: [0xffc98a, 3.5], hemi: [0x8cb0e6, 0xdca070, 1.1], fog: 0xf2cfa8, skyTop: 0x2a5fc4, skyMid: 0x6fa3e8, horizon: 0xffc79c, glow: 0xff9a4a, disc: 0xffe0b0 },
};

const rng = mulberry32(1337);
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = (a = 0, b = 1) => a + rng() * (b - a);
const FUN = [0xff5a3c, 0xffc233, 0x2fd1a0, 0x3d8dff, 0xb45cff, 0xff6fb0, 0xffe066];

// ---------------------------------------------------------------- terrain colors
// Tops by kind (grass darkens with altitude); walls are dirt under grass, sand under beaches, the rock's own color
// elsewhere. Strata bands and per-block tone come from the material, not the vertices, so flat runs can merge.
const C = (hex) => new THREE.Color(hex);
const TOP = {
  [KIND.SAND]: C(0xf5e0a0), [KIND.WETSAND]: C(0xd9c07a), [KIND.ROCK]: C(0x9c7a55), [KIND.STONE]: C(0x8d8f93), [KIND.SNOW]: C(0xfdfbf6),
  [KIND.LAKE]: C(0xc9b98a), [KIND.RIVER]: C(0xc4b07a),
};
const GRASS_LO = C(0xa9e05c), GRASS_HI = C(0x3f9e5c);
const WALL = { dirt: C(0xa27a52), sand: C(0xd8c17f), rock: C(0x8f6a45), stone: C(0x7c7e83), snow: C(0x9ea2a8) };
const tmpC = new THREE.Color();
function topColor(i, j, out) {
  const k = cellKind(i, j), top = cellTop(i, j);
  if (k === KIND.GRASS || k === KIND.MEADOW) return out.copy(GRASS_LO).lerp(GRASS_HI, THREE.MathUtils.clamp(top / 66, 0, 1));
  return out.copy(TOP[k] || GRASS_LO);
}
function wallColor(kind, out) {
  if (kind === KIND.GRASS || kind === KIND.MEADOW) return out.copy(WALL.dirt);
  if (kind === KIND.SAND || kind === KIND.WETSAND || kind === KIND.LAKE || kind === KIND.RIVER) return out.copy(WALL.sand);
  if (kind === KIND.ROCK) return out.copy(WALL.rock);
  if (kind === KIND.SNOW) return out.copy(WALL.snow);
  return out.copy(WALL.stone);
}

// ---------------------------------------------------------------- terrain (voxel columns, greedy-merged)
function buildTerrain() {
  ensureGrid();
  const N = HALF_CELLS;
  const pos = [], nrm = [], colr = [], lip = [], topcol = [];
  const NO_LIP = -1000;
  const quad = (ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, nx, ny, nz, col) => {
    pos.push(ax, ay, az, bx, by, bz, cx, cy, cz, ax, ay, az, cx, cy, cz, dx, dy, dz);
    for (let k = 0; k < 6; k++) { nrm.push(nx, ny, nz); colr.push(col.r, col.g, col.b); lip.push(NO_LIP); topcol.push(0, 0, 0); }
  };
  // Wall quad with per-vertex color: a/d are the bottom corners (lo color), b/c the top corners (hi color).
  // `fringe` is the top face's color when grass should hang over the lip, else null.
  const wallQuad = (ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, nx, ny, nz, hi, lo, fringe) => {
    pos.push(ax, ay, az, bx, by, bz, cx, cy, cz, ax, ay, az, cx, cy, cz, dx, dy, dz);
    const cols = [lo, hi, hi, lo, hi, lo];
    for (let k = 0; k < 6; k++) {
      nrm.push(nx, ny, nz); colr.push(cols[k].r, cols[k].g, cols[k].b);
      lip.push(fringe ? by : NO_LIP); topcol.push(fringe ? fringe.r : 0, fringe ? fringe.g : 0, fringe ? fringe.b : 0);
    }
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
  const hi = new THREE.Color(), lo = new THREE.Color();
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
  const foam = new THREE.Color(0xd8fff7);
  for (let j = -N; j < N; j++) {
    let start = -1;
    for (let i = -N; i <= N; i++) {
      let ring = false;
      if (i < N && level[at(i, j)] === 0) ring = levelAtCell(i + 1, j) > 0 || levelAtCell(i - 1, j) > 0 || levelAtCell(i, j + 1) > 0 || levelAtCell(i, j - 1) > 0;
      if (ring && start < 0) start = i;
      if (!ring && start >= 0) { const x0 = start * CELL - half, x1 = (i - 1) * CELL + half, z = j * CELL, y = 0.5; quad(x0, y, z - half, x0, y, z + half, x1, y, z + half, x1, y, z - half, 0, 1, 0, foam); start = -1; }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colr, 3));
  geo.setAttribute('lip', new THREE.Float32BufferAttribute(lip, 1));
  geo.setAttribute('topcol', new THREE.Float32BufferAttribute(topcol, 3));
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.95 });
  mat.colorNode = terrainColor();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.castShadow = true;
  console.info(`terrain mesh: ${pos.length / 3} vertices`);
  return mesh;
}

// Block-level materiality, all in the fragment shader so flat runs of blocks can still share one quad:
//  - every block has its own tone, and a 16x16 grid of "texels" inside each face so it reads as pixel art up close
//  - walls show horizontal strata every 3 units and a green fringe of grass hanging over the lip
//  - tops carry patches of moss / darker turf from a slow noise; north-facing walls catch pale lichen speckle
function terrainColor() {
  const base = vertexColor();
  const cell = floor(positionWorld.xz.div(CELL).add(0.5));
  const tone = hash(cell.x.add(cell.y.mul(917.31)).add(3.7)).mul(0.14).add(0.93);
  const texel = floor(positionWorld.mul(16 / CELL));
  const texelHash = hash(tslDot(texel, vec3(1, 57.3, 113.7)).add(0.31));
  const grain = texelHash.mul(0.12).add(0.94);
  const isWall = normalWorld.y.lessThan(0.5);
  const band = floor(positionWorld.y.div(3).add(0.02));
  const strata = hash(band.mul(7.13).add(0.5)).mul(0.36).add(0.78);
  let col = base.mul(tone).mul(grain).mul(select(isWall, strata, float(1)));
  // moss and turf patches on the tops (not on snow)
  // (two hashed cell scales instead of noise: patches of a few blocks, cheap per pixel)
  const coarse = floor(positionWorld.xz.div(CELL * 3).add(0.5));
  const patch = hash(coarse.x.add(coarse.y.mul(311.7)).add(9.1)).mul(0.7).add(tone.sub(0.93).mul(2.1));
  const moss = smoothstep(0.55, 0.7, patch).mul(0.5).mul(step(luminance(base), 0.8)).mul(select(isWall, float(0), float(1)));
  col = mix(col, color(0x4f9a3f).mul(grain), moss);
  // grass fringe: the top's color creeping down the wall below the lip, ragged by texel
  const below = attribute('lip', 'float').sub(positionWorld.y).add(texelHash.mul(0.9));
  const fringe = smoothstep(1.3, 0.35, below).mul(step(float(0.01), attribute('topcol', 'vec3').g));
  col = mix(col, attribute('topcol', 'vec3').mul(grain).mul(0.92), fringe);
  // lichen on the shaded, north-facing walls
  const lichen = step(0.86, texelHash).mul(smoothstep(-0.3, -0.8, normalWorld.z)).mul(select(isWall, float(0.5), float(0)));
  col = mix(col, color(0xc2cca6), lichen);
  return col;
}


// Lakes and rivers: flat quads at each cell's water surface, drawn with the sea's own material (analytic sky, no
// planar reflection, no swell), so fresh water looks exactly like the sea without touching its shader.
function buildFreshWater(material) {
  const N = HALF_CELLS, half = CELL / 2;
  const pos = [], dep = [], edge = [], idx = [];
  let v = 0;
  for (let j = -N; j < N; j++) {
    let start = -1, level = -1, d = 0;
    const flush = (i) => {
      if (start < 0) return;
      const x0 = start * CELL - half, x1 = (i - 1) * CELL + half, z0 = j * CELL - half, z1 = j * CELL + half;
      pos.push(x0, level, z0, x1, level, z0, x1, level, z1, x0, level, z1);
      for (let k = 0; k < 4; k++) { dep.push(d); edge.push(0); }
      idx.push(v, v + 2, v + 1, v, v + 3, v + 2); v += 4;
      start = -1;
    };
    for (let i = -N; i <= N; i++) {
      const w = i < N ? cellWater(i, j) : -1;
      let dd = 0;
      if (w >= 0) { const k = cellKind(i, j); dd = k === KIND.RIVER ? 0.3 : Math.round(THREE.MathUtils.clamp((w - cellTop(i, j)) / 38, 0.12, 1) * 20) / 20; }
      if (w >= 0 && start >= 0 && w === level && dd === d) continue;
      flush(i);
      if (w >= 0) { start = i; level = w; d = dd; }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('depth', new THREE.Float32BufferAttribute(dep, 1));
  geo.setAttribute('edge', new THREE.Float32BufferAttribute(edge, 1));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, material);
  mesh.receiveShadow = true;
  mesh.renderOrder = 1;
  mesh.frustumCulled = false;
  return mesh;
}

// Waterfalls: a streaming strip down the drop, a foam pool where it lands, spray on the big ones.
function buildWaterfalls(soft) {
  const q = new THREE.Quaternion(), qy = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
  const flat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
  const m = new THREE.Matrix4(), p = new THREE.Vector3(), sc = new THREE.Vector3();
  const big = [];
  for (const f of waterfalls()) {
    const acrossX = f.dirX !== 0;               // water flows along x: the strip's face must look along x
    q.copy(acrossX ? qy : new THREE.Quaternion());
    const strip = soft.alloc(); if (strip < 0) break;
    soft.color(strip, 0xd6f2ff); soft.scalar(strip, softParam(0.78, STRIP));
    soft.matrix(strip, m.compose(p.set(f.x, (f.top + f.bottom) / 2 + 0.3, f.z), q, sc.set(f.width * 0.8, f.drop + 0.6, 0.5)));
    const pool = soft.alloc(); if (pool < 0) break;
    const px = f.x + f.dirX * f.width * 0.5, pz = f.z + f.dirZ * f.width * 0.5;
    soft.color(pool, 0xffffff); soft.scalar(pool, softParam(0.4, 0));
    soft.matrix(pool, m.compose(p.set(px, f.bottom + 0.3, pz), flat, sc.set(f.width * 1.3, f.width * 1.3, 1)));
    if (f.drop >= 8) big.push({ x: f.x, y: f.bottom, z: f.z, drop: f.drop, dirX: f.dirX, dirZ: f.dirZ, width: f.width });
  }
  return big;
}

// ---------------------------------------------------------------- water
// Directional wave set: [dirX, dirZ, wavenumber, amplitude, speed]. Slopes are analytic so the normal is exact.
const WAVES = [
  [1.0, 0.3, 0.045, 0.9, 1.3], [-0.6, 1.0, 0.09, 0.5, 1.9], [0.8, -0.7, 0.17, 0.3, 2.6],
  [0.2, 1.0, 0.31, 0.12, 3.6], [-1.0, -0.4, 0.55, 0.05, 4.8], [0.5, 0.9, 0.9, 0.02, 6.5],
];

function waveSlopes(P, detailFade) {
  let sx = float(0), sz = float(0);
  WAVES.forEach(([dx, dz, k, a, sp], i) => {
    const len = Math.hypot(dx, dz), ux = dx / len, uz = dz / len;
    const phase = P.x.mul(ux).add(P.y.mul(uz)).mul(k).add(time.mul(sp));
    let c = cos(phase).mul(a * k);
    if (i >= 2) c = c.mul(detailFade);   // fine chop fades out with distance so far water doesn't sparkle-alias
    sx = sx.add(c.mul(ux)); sz = sz.add(c.mul(uz));
  });
  return { sx, sz };
}

function buildWater({ mobile }) {
  const size = 4800, seg = 240;
  // Geometry stays in the XY plane and the mesh is rotated, so the reflector can read the plane from the object.
  const geo = new THREE.PlaneGeometry(size, size, seg, seg);
  const p = geo.attributes.position;
  const dep = new Float32Array(p.count), edge = new Float32Array(p.count);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = -p.getY(i);
    dep[i] = THREE.MathUtils.clamp(-heightAt(x, z) / 38, 0, 1);
    // swell fades to zero at the rim so the near mesh meets the flat far ocean without a seam
    edge[i] = 1 - THREE.MathUtils.smoothstep(Math.max(Math.abs(x), Math.abs(z)), size * 0.5 - 500, size * 0.5 - 60);
  }
  geo.setAttribute('depth', new THREE.BufferAttribute(dep, 1));
  geo.setAttribute('edge', new THREE.BufferAttribute(edge, 1));

  const near = new THREE.Mesh(geo, new THREE.MeshStandardNodeMaterial({ roughness: 0.2, metalness: 0.0, transparent: true }));
  near.rotation.x = -Math.PI / 2;
  near.receiveShadow = true;
  near.renderOrder = 1;

  // One reflection pass shared by the near and far ocean.
  let reflection = null;
  if (!mobile) reflection = reflector({ target: near, resolutionScale: 0.5 });

  const shade = (mat, d, edgeNode, useReflection) => {
    const deepMix = smoothstep(0.0, 0.7, d);
    const P = positionWorld.xz;
    const camDist = cameraPosition.sub(positionWorld).length();
    const detailFade = smoothstep(float(700), float(80), camDist);
    const { sx, sz } = waveSlopes(P, detailFade);
    const gust = mx_noise_float(vec3(P.mul(0.012), time.mul(0.12))).mul(0.45).add(0.85);
    const shallowCalm = mix(float(0.45), float(1.0), deepMix);
    const nW = normalize(vec3(sx.negate().mul(gust).mul(shallowCalm), 1.0, sz.negate().mul(gust).mul(shallowCalm)));
    mat.normalNode = transformNormalToView(nW);

    const V = normalize(cameraPosition.sub(positionWorld));
    const ndv = saturate(dot(nW, V));
    const fresnel = pow(float(1).sub(ndv), 3).mul(0.72).add(0.16).mul(mix(float(0.45), float(1.0), deepMix));
    // Analytic sky mirror everywhere; near the camera the real planar reflection takes over (blended so the
    // near mesh and the far ocean, which cannot read the reflection while it renders, meet without a seam).
    const R = reflect(V.negate(), nW);
    let skyRefl = mix(color(0xcfe8ff), color(PALETTE.sky), saturate(R.y.mul(1.6)));
    if (reflection && useReflection) {
      const distort = vec2(sx, sz).mul(0.3).mul(mix(float(0.15), float(1.0), detailFade));
      const real = reflection.sample(reflection.uvNode.add(distort)).rgb;
      skyRefl = mix(skyRefl, real, smoothstep(float(2300), float(1400), camDist));
    }
    let base = mix(color(PALETTE.shallow), color(PALETTE.deep), deepMix);
    const shimmer = mx_noise_float(vec3(P.mul(0.08), time.mul(0.45))).mul(0.5).add(0.5);
    base = base.add(color(0xbfffee).mul(shimmer.mul(0.22)).mul(float(1).sub(deepMix)));
    const foamBand = smoothstep(0.15, 0.0, d);
    const foamNoise = mx_noise_float(vec3(P.mul(0.14).add(vec2(time.mul(0.25), 0)), time.mul(0.35))).mul(0.5).add(0.5);
    const foam = foamBand.mul(smoothstep(0.3, 0.7, foamNoise.mul(0.65).add(foamBand.mul(0.5))));
    const foamMix = foam.mul(0.9);
    mat.colorNode = mix(base.mul(float(1).sub(fresnel)), color(PALETTE.foam), foamMix);
    mat.emissiveNode = skyRefl.mul(fresnel).mul(float(1).sub(foamMix));
    mat.opacityNode = mix(float(0.5), float(0.97), smoothstep(0.0, 0.32, d)).add(fresnel.mul(0.5)).add(foam).min(1.0);
    // vertex swell (bigger in deep water); local +Z is world up because the mesh is rotated
    const wave = sin(time.mul(0.9).add(positionLocal.x.mul(0.03)).add(positionLocal.y.mul(0.02))).mul(0.5)
      .add(sin(time.mul(0.6).add(positionLocal.y.mul(0.045)).sub(positionLocal.x.mul(0.015))).mul(0.35));
    mat.positionNode = positionLocal.add(vec3(0, 0, wave.mul(mix(float(0.15), float(1.0), d)).mul(edgeNode)));
  };
  shade(near.material, attribute('depth', 'float'), attribute('edge', 'float'), true);

  // Far ocean: same look, constant deep water, flat, opaque, runs out past the fog to the horizon.
  // Built as a frame around the near mesh (not underneath it) so the swell can never poke through it.
  const farShape = new THREE.Shape();
  const F = 20000, h = size / 2;
  farShape.moveTo(-F, -F); farShape.lineTo(F, -F); farShape.lineTo(F, F); farShape.lineTo(-F, F); farShape.closePath();
  const hole = new THREE.Path();
  hole.moveTo(-h, -h); hole.lineTo(-h, h); hole.lineTo(h, h); hole.lineTo(h, -h); hole.closePath();
  farShape.holes.push(hole);
  const far = new THREE.Mesh(new THREE.ShapeGeometry(farShape), new THREE.MeshStandardNodeMaterial({ roughness: 0.2, metalness: 0.0 }));
  far.rotation.x = -Math.PI / 2;
  far.position.y = 0;
  far.frustumCulled = false;
  shade(far.material, float(1), float(0), false);
  // Lakes and rivers reuse the same shading with their own depth and no swell.
  const lakeMaterial = new THREE.MeshStandardNodeMaterial({ roughness: 0.2, metalness: 0.0, transparent: true });
  shade(lakeMaterial, attribute('depth', 'float'), float(0), false);
  return { near, far, lakeMaterial };
}

// The combat zone: five holographic grid walls that fade in as you approach and burn red when you're outside.
function buildBounds() {
  const H = BOUNDS.half, C = BOUNDS.ceiling;
  const danger = uniform(0);
  const group = new THREE.Group();
  const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
  mat.fog = false;
  const cell = 50;
  const g = fract(uv());   // uv is pre-scaled per wall so one cell = 50 world units
  const lineW = 0.035;
  const line = tslMax(smoothstep(lineW, 0.0, tslMin(g.x, float(1).sub(g.x))), smoothstep(lineW, 0.0, tslMin(g.y, float(1).sub(g.y))));
  const proximity = smoothstep(float(320), float(40), cameraPosition.sub(positionWorld).length());
  const pulse = sin(time.mul(6)).mul(0.5).add(0.5);
  const alpha = line.mul(proximity.mul(0.55).add(danger.mul(0.35).mul(pulse.mul(0.5).add(0.5))));
  mat.colorNode = mix(color(0x9ff3ff), color(0xff5a3c), danger);
  mat.opacityNode = alpha.min(0.9);
  const wall = (w, h, sx, sy) => {
    const geo = new THREE.PlaneGeometry(w, h, 1, 1);
    const uvA = geo.attributes.uv;
    for (let i = 0; i < uvA.count; i++) uvA.setXY(i, uvA.getX(i) * (w / cell), uvA.getY(i) * (h / cell));
    const m = new THREE.Mesh(geo, mat);
    m.frustumCulled = false;
    group.add(m);
    return m;
  };
  const n = wall(2 * H, C); n.position.set(0, C / 2, -H);
  const s = wall(2 * H, C); s.position.set(0, C / 2, H); s.rotation.y = Math.PI;
  const e = wall(2 * H, C); e.position.set(H, C / 2, 0); e.rotation.y = -Math.PI / 2;
  const w = wall(2 * H, C); w.position.set(-H, C / 2, 0); w.rotation.y = Math.PI / 2;
  const top = wall(2 * H, 2 * H); top.position.set(0, C, 0); top.rotation.x = Math.PI / 2;
  group.renderOrder = 6;
  return { group, setDanger: (v) => { danger.value = v; } };
}

// Smooth sandy seafloor visible through the shallows.
function buildSeafloor() {
  const size = 3600, seg = 180;
  const geo = new THREE.PlaneGeometry(size, size, seg, seg);
  geo.rotateX(-Math.PI / 2);
  const p = geo.attributes.position;
  const colors = new Float32Array(p.count * 3);
  const sand = new THREE.Color(PALETTE.floorSand), deep = new THREE.Color(PALETTE.floorDeep), c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i);
    const h = THREE.MathUtils.clamp(heightAt(x, z), -42, -1.5);
    p.setY(i, h);
    c.copy(sand).lerp(deep, THREE.MathUtils.smoothstep(-h, 2, 34));
    colors.set([c.r, c.g, c.b], i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 1 }));
  mesh.receiveShadow = true;
  return mesh;
}

// ---------------------------------------------------------------- sky & sun
function buildSky(sunDirUniform, tod) {
  const geo = new THREE.SphereGeometry(6500, 24, 12);
  const mat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false });
  mat.fog = false;
  const dir = normalize(positionLocal);
  const t = saturate(dir.y.mul(1.25).add(0.05));
  let c = mix(tod.horizon, tod.skyMid, smoothstep(0.0, 0.09, t));
  c = mix(c, tod.skyTop, smoothstep(0.09, 0.8, t));
  const sunDot = saturate(dot(dir, sunDirUniform));
  // warm glow around the sun and along the sun-side horizon
  const horizonGlow = smoothstep(0.35, 0.0, dir.y).mul(pow(sunDot, 3)).mul(0.35);
  c = c.add(color(0xffe1b0).mul(pow(sunDot, 120).mul(1.3))).add(tod.glow.mul(pow(sunDot, 5).mul(0.22).add(horizonGlow)));
  mat.colorNode = c;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  return mesh;
}

// ---------------------------------------------------------------- clouds: flat pixel-art slabs, mirrored for symmetry
function cloudShape() {
  const w = 5 + Math.floor(rand(0, 6)), h = 3 + Math.floor(rand(0, 4));
  const cells = new Set();
  const rects = 2 + Math.floor(rand(0, 3));
  for (let r = 0; r < rects; r++) {
    const rw = Math.max(2, Math.floor(rand(w * 0.35, w))), rh = Math.max(1, Math.floor(rand(1, h)));
    const ox = Math.floor(rand(0, w - rw + 1)), oz = Math.floor(rand(0, h - rh + 1));
    for (let x = ox; x < ox + rw; x++) for (let z = oz; z < oz + rh; z++) cells.add(`${x},${z}`);
  }
  // mirror left-right so every cloud is symmetric
  const out = [];
  for (const key of cells) {
    const [x, z] = key.split(',').map(Number);
    out.push([x, z], [w - 1 - x, z]);
  }
  const uniq = new Map(out.map(([x, z]) => [`${x},${z}`, [x - (w - 1) / 2, z - (h - 1) / 2]]));
  return [...uniq.values()];
}

function buildClouds() {
  const CS = 18, TH = 7;
  const clouds = [];
  let total = 0;
  for (let i = 0; i < 44; i++) {
    const cells = cloudShape();
    clouds.push({ x: rand(-2200, 2200), y: rand(420, 530), z: rand(-2200, 2200), vx: rand(5, 9), cells, scale: rand(0.8, 1.4) });
    total += cells.length;
  }
  const geo = new THREE.BoxGeometry(CS, TH, CS);
  // A touch of emissive fakes sky bounce so the undersides stay bright and creamy instead of muddy.
  const mat = new THREE.MeshStandardNodeMaterial({ color: PALETTE.cloud, roughness: 1, emissive: 0xe6eef8, emissiveIntensity: 0.36 });
  const mesh = new THREE.InstancedMesh(geo, mat, total);
  mesh.castShadow = true;
  mesh.frustumCulled = false;
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  const update = (dt) => {
    let i = 0;
    for (const c of clouds) {
      c.x += c.vx * dt;
      if (c.x > 2400) c.x = -2400;
      s.setScalar(c.scale);
      for (const [cx, cz] of c.cells) {
        p.set(c.x + cx * CS * c.scale, c.y, c.z + cz * CS * c.scale);
        m.compose(p, q, s);
        mesh.setMatrixAt(i++, m);
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
  };
  update(0);
  return { mesh, update, clouds };
}

// ---------------------------------------------------------------- props
const ONE = new THREE.Vector3(1, 1, 1), WORLD_UP = new THREE.Vector3(0, 1, 0), Z_AXIS = new THREE.Vector3(0, 0, 1);
const BIRD_DARK = 0x2a2f3a, GULL = 0xfff8ec;

function buildProps(scene, lit, glow) {
  // Palm fronds get their own batch so they can sway in the wind (GPU-side, per instance phase) and get shoved
  // aside by a plane passing low overhead: positionLocal here is already instance-transformed, i.e. world space.
  const phase = hash(instanceIndex).mul(6.28);
  const sway = sin(time.mul(1.3).add(phase)).mul(0.35);
  const gustPos = uniform(new THREE.Vector3(0, -1000, 0)), gustAmt = uniform(0);
  const away = positionLocal.sub(gustPos);
  const fall = exp(away.dot(away).div(-45 * 45)).mul(gustAmt);
  const push = normalize(vec3(away.x, 0, away.z).add(vec3(0.001, 0, 0))).mul(fall.mul(1.8));
  const leaves = new Boxes(scene, 6000, { positionNode: positionLocal.add(vec3(sway, 0, sway.mul(0.6))).add(push).sub(vec3(0, fall.mul(0.6), 0)) });

  // --- palms on beaches and low grass, snapped to the voxel grid
  const N = HALF_CELLS;
  const palmList = [];
  let palms = 0;
  for (let i = -N; i < N && palms < 900; i += 3) {
    for (let j = -N; j < N && palms < 900; j += 3) {
      const k = cellKind(i, j), L = levelAtCell(i, j);
      const beach = k === KIND.SAND || k === KIND.WETSAND;
      if (!(beach || (k === KIND.GRASS && L <= 7))) continue;
      if (rand() > (beach ? 0.3 : 0.08)) continue;
      const x = i * CELL, z = j * CELL, y = cellTop(i, j);
      const h = 4 + Math.floor(rand(0, 3));
      const sc = rand(0.9, 1.25);
      for (let k = 0; k < h; k++) lit.box(lit.alloc(), x, y + (k + 0.5) * 2.2 * sc, z, 1.8 * sc, 2.2 * sc, 1.8 * sc, PALETTE.trunk);
      const top = y + h * 2.2 * sc;
      const leafC = rand() < 0.5 ? PALETTE.leaf : PALETTE.leafDark;
      const arm = 4.2 * sc;
      leaves.box(leaves.alloc(), x, top + 0.8 * sc, z, 3 * sc, 1.6 * sc, 3 * sc, leafC);
      leaves.box(leaves.alloc(), x + arm, top + 0.2 * sc, z, 4.4 * sc, 1.2 * sc, 2.4 * sc, leafC);
      leaves.box(leaves.alloc(), x - arm, top + 0.2 * sc, z, 4.4 * sc, 1.2 * sc, 2.4 * sc, leafC);
      leaves.box(leaves.alloc(), x, top + 0.2 * sc, z + arm, 2.4 * sc, 1.2 * sc, 4.4 * sc, leafC);
      leaves.box(leaves.alloc(), x, top + 0.2 * sc, z - arm, 2.4 * sc, 1.2 * sc, 4.4 * sc, leafC);
      leaves.box(leaves.alloc(), x, top + 2.0 * sc, z, 1.6 * sc, 1.2 * sc, 1.6 * sc, leafC);
      lit.box(lit.alloc(), x + 1.1 * sc, top - 0.6 * sc, z + 0.6 * sc, 0.9, 0.9, 0.9, 0x9c7a55);   // coconut
      palmList.push({ x, y: top + 0.6 * sc, z, cool: 0 });
      palms++;
    }
  }
  leaves.flush();

  // A group is a run of boxes with local matrices, re-placed under a parent matrix each frame.
  const group = (boxes) => {
    const start = lit.alloc(boxes.length);
    boxes.forEach(([x, y, z, sx, sy, sz, hex], k) => { lit.color(start + k, hex); lit.scalar(start + k, 0.8); });
    return { start, locals: boxes.map(([x, y, z, sx, sy, sz]) => local(x, y, z, sx, sy, sz)), mtx: new THREE.Matrix4() };
  };

  // --- hot air balloons: stepped voxel envelopes with a flickering burner
  const balloons = [];
  const rings = [[4, 3], [8, 3], [11, 3.5], [12, 3.5], [11, 3], [8, 3], [4, 2.5]];
  const BURNER = local(0, -0.3, 0, 1.1, 1.1, 1.1);
  for (let b = 0; b < 7; b++) {
    const c1 = FUN[b % FUN.length], c2 = FUN[(b + 3) % FUN.length];
    const parts = [];
    let y = 0;
    rings.forEach(([w, h], k) => { parts.push([0, y + h / 2, 0, w, h, w, k % 2 ? c2 : c1]); y += h; });
    parts.push([0, -1.5, 0, 3, 3, 3, 0xd8b58c], [0, -8.5, 0, 4, 3, 4, 0xb48a5c]);                  // skirt, basket
    for (const [rx, rz] of [[-1.6, -1.6], [1.6, -1.6], [-1.6, 1.6], [1.6, 1.6]]) parts.push([rx, -4.5, rz, 0.25, 5, 0.25, 0x6b5442]);
    const a = rand(0, Math.PI * 2), rad = rand(300, 1100);
    const burner = glow.alloc();
    glow.color(burner, 0xffb050);
    balloons.push({ ...group(parts), burner, x: Math.cos(a) * rad, y: rand(150, 300), z: Math.sin(a) * rad, phase: rand(0, 6), drift: rand(1.5, 3.5), rot: rand(0, 6) });
  }

  // --- sailboats, each towing a pair of wake ribbons from the stern
  const boats = [];
  let tries = 0;
  const wakes = new Trails(scene, 18, 30, 1.3, { fade: 0.11, opacity: 0.55, sample: 0.3, widen: true, renderOrder: 4 });
  while (boats.length < 9 && tries++ < 6000) {
    const x = rand(-1400, 1400), z = rand(-1400, 1400);
    const h = heightAt(x, z);
    if (h > -8 || h < -34 || !isSeaAt(x, z)) continue;
    const hull = FUN[boats.length % FUN.length];
    const parts = [
      [0, 0.6, 0.5, 4, 1.6, 9, hull], [0, 0.6, -5.2, 2.4, 1.6, 2.4, hull],        // hull, stepped bow
      [0, 1.6, 0, 3.2, 0.5, 8, 0xe9d7b8], [0, 7, 0.5, 0.35, 11, 0.35, 0x8b6b4a],  // deck, mast
      [0.4, 7.5, -2.2, 0.15, 7.5, 5, 0xfff8ec], [0.4, 4.5, -3.5, 0.15, 1.5, 2.5, 0xfff8ec],   // sails
    ];
    boats.push({ ...group(parts), x, z, heading: rand(0, Math.PI * 2), phase: rand(0, 6), speed: rand(1.2, 2.4), wake: [wakes.ribbon(), wakes.ribbon()] });
  }

  // --- birds: five flocks in V formation circling over the isles. Three boxes each: body and two flapping wings.
  const BIRD_BODY = local(0, 0, 0, 0.5, 0.35, 1.3);
  const BIRD_WING = [local(-0.9, 0, 0, 1.7, 0.08, 0.5), local(0.9, 0, 0, 1.7, 0.08, 0.5)];
  const bird = (hex) => { const start = lit.alloc(3); for (let k = 0; k < 3; k++) { lit.color(start + k, hex); lit.scalar(start + k, 0.9); } return start; };
  // ten flocks that wander: a heading that drifts, banked turns, an altitude that swells, and a nudge back toward
  // the isles when they stray. Sizes vary so some are pairs and some are big skeins.
  const flocks = [];
  for (let f = 0; f < 10; f++) {
    const members = [];
    const n = 3 + Math.floor(rand(0, 7));
    for (let k = 0; k < n; k++) members.push({ start: bird(BIRD_DARK), flap: rand(0, 6), bob: rand(0, 6) });
    flocks.push({ members, x: rand(-1200, 1200), z: rand(-1200, 1200), y: rand(90, 300), heading: rand(0, 6.3), turn: 0, speed: rand(14, 22), phase: rand(0, 6), yBase: rand(90, 300) });
  }
  // --- gulls resting on beaches; they scatter when a plane buzzes them and settle back down
  const gullSpots = [];
  for (let i = -N + 4; i < N - 4 && gullSpots.length < 4; i += 5) {
    for (let j = -N + 4; j < N - 4 && gullSpots.length < 4; j += 5) {
      const sandy = (a, b) => { const k = cellKind(a, b); return k === KIND.SAND || k === KIND.WETSAND; };
      if (!sandy(i, j) || !sandy(i + 2, j) || !sandy(i, j + 2) || !sandy(i - 2, j)) continue;
      const x = i * CELL, z = j * CELL;
      if (gullSpots.some((g) => Math.hypot(g.x - x, g.z - z) < 500)) continue;
      const members = [];
      for (let k = 0; k < 6; k++) members.push({ start: bird(GULL), flap: rand(0, 6), ox: rand(-9, 9), oz: rand(-9, 9), dir: rand(0, 6.3), yaw: rand(0, 6.3) });
      gullSpots.push({ x, y: cellTop(i, j) + 0.4, z, members, fly: 0, T: 0, dirty: true });
    }
  }

  const pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scl = new THREE.Vector3(1, 1, 1), eul = new THREE.Euler();
  const bm = new THREE.Matrix4(), wm = new THREE.Matrix4(), hm = new THREE.Matrix4(), wq = new THREE.Quaternion(), side = new THREE.Vector3();

  // --- grazing life: sheep and a wolf on flat meadows, chickens that scatter, and a couple of villages
  const flat = (i, j, r, kinds, minL, maxL) => {
    const L = levelAtCell(i, j);
    if (L < minL || L > maxL) return false;
    for (let di = -r; di <= r; di++) for (let dj = -r; dj <= r; dj++) if (levelAtCell(i + di, j + dj) !== L || !kinds.includes(cellKind(i + di, j + dj))) return false;
    return true;
  };
  const spots = (r, kinds, minL, maxL, gap, max, avoid, avoidGap = 90) => {
    const out = [];
    for (let i = -N + r; i < N - r && out.length < max; i += 4) for (let j = -N + r; j < N - r && out.length < max; j += 4) {
      if (!flat(i, j, r, kinds, minL, maxL)) continue;
      const x = i * CELL, z = j * CELL;
      if (out.some((o) => Math.hypot(o.x - x, o.z - z) < gap) || avoid.some((o) => Math.hypot(o.x - x, o.z - z) < avoidGap)) continue;
      out.push({ x, y: cellTop(i, j), z });
    }
    return out;
  };
  const DARK = 0x3a3230;
  const sheepParts = (wool) => [[0, 1.6, 0, 2.2, 1.5, 2.6, wool], [0, 1.9, -1.6, 1.0, 0.9, 0.9, 0xe8d8c8], [-0.7, 0.45, -0.9, 0.4, 0.9, 0.4, DARK], [0.7, 0.45, -0.9, 0.4, 0.9, 0.4, DARK], [-0.7, 0.45, 0.9, 0.4, 0.9, 0.4, DARK], [0.7, 0.45, 0.9, 0.4, 0.9, 0.4, DARK]];
  const wolfParts = [[0, 1.2, 0, 1.2, 1.1, 2.6, 0x9a9a9c], [0, 1.7, -1.6, 1.0, 0.9, 1.0, 0xb5b5b7], [0, 1.5, -2.3, 0.5, 0.4, 0.5, 0x333333], [0, 1.5, 1.7, 0.35, 0.35, 1.2, 0x9a9a9c], [-0.4, 0.4, -0.9, 0.3, 0.8, 0.3, 0x8a8a8c], [0.4, 0.4, -0.9, 0.3, 0.8, 0.3, 0x8a8a8c], [-0.4, 0.4, 0.9, 0.3, 0.8, 0.3, 0x8a8a8c], [0.4, 0.4, 0.9, 0.3, 0.8, 0.3, 0x8a8a8c]];
  const chickenParts = [[0, 0.7, 0, 0.7, 0.6, 0.9, 0xffffff], [0, 1.15, -0.5, 0.45, 0.45, 0.45, 0xffffff], [0, 1.45, -0.5, 0.2, 0.25, 0.35, 0xff3b3b], [0, 1.1, -0.85, 0.2, 0.15, 0.25, 0xffb030], [-0.18, 0.2, 0, 0.12, 0.4, 0.12, 0xffb030], [0.18, 0.2, 0, 0.12, 0.4, 0.12, 0xffb030]];
  const villagerParts = [[0, 1.1, 0, 1.2, 2.2, 0.8, 0x2f6b4f], [0, 2.7, 0, 0.9, 1.0, 0.9, 0xc9a27e], [0, 2.55, -0.55, 0.3, 0.6, 0.3, 0xc9a27e], [0, 1.5, -0.5, 1.4, 0.5, 0.4, 0x2f6b4f]];
  const houseParts = [[0, 3, 0, 8, 6, 8, 0xe9dcc4], [0, 7.1, 0, 9.4, 2.2, 9.4, 0xb14a3a], [0, 9.2, 0, 6.2, 2, 6.2, 0xb14a3a], [0, 1.5, -4.1, 1.6, 3, 0.3, 0x6b4a2e], [2.5, 9.6, 2.5, 1, 3, 1, 0x8a8c90]];
  const meadows = spots(3, [KIND.GRASS, KIND.MEADOW], 2, 9, 320, 6, []);
  const animals = [];
  meadows.forEach((sp, k) => {
    for (let i = 0; i < 4; i++) animals.push({ kind: 'sheep', ...group(sheepParts(i === 0 ? 0xf5a6c8 : 0xf6f1e6)), sp, x: sp.x + rand(-8, 8), z: sp.z + rand(-8, 8), yaw: rand(0, 6.3), timer: rand(0, 3), walking: false, phase: rand(0, 6) });
    if (k % 2 === 0) animals.push({ kind: 'wolf', ...group(wolfParts), sp, a: rand(0, 6.3), phase: rand(0, 6) });
    if (k % 2 === 1) for (let i = 0; i < 4; i++) animals.push({ kind: 'chicken', ...group(chickenParts), sp, x: sp.x + rand(-6, 6), z: sp.z + rand(-6, 6), yaw: rand(0, 6.3), run: 0, dir: 0, phase: rand(0, 6) });
  });
  const villages = spots(2, [KIND.GRASS, KIND.MEADOW], 2, 9, 500, 2, meadows, 60);
  const villagers = [];
  for (const v of villages) {
    for (let h = 0; h < 5; h++) {
      const a = h / 5 * Math.PI * 2, hx = v.x + Math.cos(a) * 10, hz = v.z + Math.sin(a) * 10;
      const house = group(houseParts);
      // each house sits on its own cell top so a village can straddle a terrace step
      lit.place(house.start, house.locals, house.mtx.compose(pos.set(hx, cellTop(Math.round(hx / CELL), Math.round(hz / CELL)), hz), quat.setFromAxisAngle(WORLD_UP, -a + Math.PI / 2), ONE));
      for (const wx of [-2.4, 2.4]) {   // warm windows either side of the door
        const w = glow.alloc(); glow.color(w, 0xffc070); glow.scalar(w, 1.4);
        glow.matrix(w, wm.multiplyMatrices(house.mtx, local(wx, 3.6, -4.15, 1.4, 1.4, 0.3)));
      }
    }
    for (let i = 0; i < 3; i++) villagers.push({ ...group(villagerParts), x: v.x + rand(-6, 6), z: v.z + rand(-6, 6), y: v.y, yaw: rand(0, 6.3), look: 0, phase: rand(0, 6) });
  }
  const placeAnimal = (an, x, y, z, yaw, pitch) => { eul.set(pitch, yaw, 0); lit.place(an.start, an.locals, an.mtx.compose(pos.set(x, y, z), quat.setFromEuler(eul), ONE)); };

  /** Fronds fly when a plane clips a palm: calls back once per palm hit, with a cooldown per palm. */
  const brushPalms = (at, dt, onLeaf) => {
    for (const pm of palmList) {
      if (pm.cool > 0) { pm.cool -= dt; continue; }
      if (Math.abs(pm.x - at.x) > 11 || Math.abs(pm.z - at.z) > 11 || Math.abs(pm.y - at.y) > 9) continue;
      pm.cool = 0.7;
      onLeaf(pm.x, pm.y, pm.z);
    }
  };

  const placeBird = (start, x, y, z, yaw, pitch, flap) => {
    eul.set(pitch, yaw, 0); quat.setFromEuler(eul);
    bm.compose(pos.set(x, y, z), quat, ONE);
    lit.matrix(start, wm.multiplyMatrices(bm, BIRD_BODY));
    for (let k = 0; k < 2; k++) {
      hm.compose(pos.set(0, 0, 0), wq.setFromAxisAngle(Z_AXIS, k ? -flap : flap), ONE);
      hm.multiply(BIRD_WING[k]);
      lit.matrix(start + 1 + k, wm.multiplyMatrices(bm, hm));
    }
  };
  const update = (dt, t, focus, speed) => {
    for (const b of balloons) {
      b.x += b.drift * dt; if (b.x > 1600) b.x = -1600;
      b.rot += dt * 0.08;
      eul.set(Math.sin(t * 0.5 + b.phase) * 0.03, b.rot, Math.cos(t * 0.4 + b.phase) * 0.03);
      lit.place(b.start, b.locals, b.mtx.compose(pos.set(b.x, b.y + Math.sin(t * 0.4 + b.phase) * 4, b.z), quat.setFromEuler(eul), scl));
      glow.scalar(b.burner, 1.6 + Math.random() * 2.2);
      glow.matrix(b.burner, wm.multiplyMatrices(b.mtx, BURNER));
    }
    for (const bt of boats) {
      bt.x -= Math.sin(bt.heading) * bt.speed * dt;
      bt.z -= Math.cos(bt.heading) * bt.speed * dt;
      if (heightAt(bt.x, bt.z) > -6 || !isSeaAt(bt.x, bt.z)) bt.heading += Math.PI * 0.5;
      eul.set(Math.sin(t * 1.1 + bt.phase) * 0.04, bt.heading, Math.sin(t * 0.9 + bt.phase) * 0.06);
      lit.place(bt.start, bt.locals, bt.mtx.compose(pos.set(bt.x, -0.2 + Math.sin(t * 1.3 + bt.phase) * 0.3, bt.z), quat.setFromEuler(eul), scl));
      side.set(Math.cos(bt.heading), 0, -Math.sin(bt.heading));
      for (let k = 0; k < 2; k++) {
        pos.set(k ? 1.7 : -1.7, 0, 4.8).applyMatrix4(bt.mtx); pos.y = 0.9;
        wakes.push(bt.wake[k], dt, pos, side, 1);
      }
    }
    wakes.update(dt);
    for (const f of flocks) {
      // wander: a slowly drifting turn rate, plus a pull back toward the middle when far out
      let want = Math.sin(t * 0.11 + f.phase) * 0.28 + Math.sin(t * 0.037 + f.phase * 2.1) * 0.2;
      const dist = Math.hypot(f.x, f.z);
      if (dist > 1250) {
        const home = Math.atan2(-f.x, -f.z);
        let d = home - f.heading; d = Math.atan2(Math.sin(d), Math.cos(d));
        want += THREE.MathUtils.clamp(d, -0.6, 0.6);
      }
      f.turn += (want - f.turn) * Math.min(1, dt * 0.8);
      f.heading += f.turn * dt;
      const yaw = f.heading;
      const fx = -Math.sin(yaw), fz = -Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
      f.x += fx * f.speed * dt; f.z += fz * f.speed * dt;
      f.y = f.yBase + Math.sin(t * 0.07 + f.phase) * 30 + Math.sin(t * 0.23 + f.phase * 3) * 6;
      const climbing = Math.cos(t * 0.07 + f.phase) * 0.07 * 30;   // d/dt of the swell, for the flap rate and pitch
      const bank = -f.turn * 1.4;
      f.members.forEach((m, k) => {
        const row = (k + 1) >> 1, sideSign = k === 0 ? 0 : (k & 1 ? -1 : 1);
        const ox = rx * sideSign * row * 4.5 - fx * row * 5, oz = rz * sideSign * row * 4.5 - fz * row * 5;
        m.flap += dt * (8 + Math.max(0, climbing) * 2);
        eul.set(THREE.MathUtils.clamp(-climbing * 0.15, -0.3, 0.3), yaw, bank);
        quat.setFromEuler(eul);
        bm.compose(pos.set(f.x + ox, f.y - row * 0.6 + Math.sin(m.bob + t * 1.3) * 0.4, f.z + oz), quat, ONE);
        lit.matrix(m.start, wm.multiplyMatrices(bm, BIRD_BODY));
        for (let w = 0; w < 2; w++) {
          hm.compose(pos.set(0, 0, 0), wq.setFromAxisAngle(Z_AXIS, w ? -Math.sin(m.flap) * 0.6 : Math.sin(m.flap) * 0.6), ONE);
          hm.multiply(BIRD_WING[w]);
          lit.matrix(m.start + 1 + w, wm.multiplyMatrices(bm, hm));
        }
      });
    }
    for (const g of gullSpots) {
      if (g.fly <= 0 && focus && Math.hypot(focus.x - g.x, focus.y - g.y, focus.z - g.z) < 95) { g.T = 4.5; g.fly = g.T; for (const m of g.members) m.dir = rand(0, 6.3); }
      if (g.fly > 0) {
        g.fly -= dt;
        const u = 1 - g.fly / g.T, arc = Math.sin(u * Math.PI);
        for (const m of g.members) {
          m.flap += dt * 14;
          const dx = Math.sin(m.dir), dz = Math.cos(m.dir), out = u < 0.5;
          const yaw = Math.atan2(out ? dx : -dx, out ? dz : -dz);
          placeBird(m.start, g.x + m.ox + dx * arc * 32, g.y + arc * 26 + 0.5, g.z + m.oz + dz * arc * 32, yaw, out ? 0.35 : -0.25, Math.sin(m.flap) * 0.7);
        }
        g.dirty = true;
      } else if (g.dirty) {
        g.dirty = false;
        for (const m of g.members) placeBird(m.start, g.x + m.ox, g.y, g.z + m.oz, m.yaw, 0, 0.9);
      }
    }
    for (const an of animals) {
      const sp = an.sp;
      if (an.kind === 'sheep') {
        an.timer -= dt;
        if (an.timer <= 0) { an.timer = rand(2, 5); an.walking = Math.random() < 0.45; an.yaw = rand(0, 6.3); }
        if (Math.hypot(an.x - sp.x, an.z - sp.z) > 11) { an.yaw = Math.atan2(-(sp.x - an.x), -(sp.z - an.z)); an.walking = true; }
        if (an.walking) { an.x -= Math.sin(an.yaw) * 0.9 * dt; an.z -= Math.cos(an.yaw) * 0.9 * dt; }
        placeAnimal(an, an.x, sp.y, an.z, an.yaw, an.walking ? Math.sin(t * 8 + an.phase) * 0.04 : 0.12 + Math.sin(t * 1.5 + an.phase) * 0.05);
      } else if (an.kind === 'wolf') {
        an.a += dt * 0.32;
        const dx = -Math.sin(an.a), dz = Math.cos(an.a);
        placeAnimal(an, sp.x + Math.cos(an.a) * 15, sp.y, sp.z + Math.sin(an.a) * 15, Math.atan2(-dx, -dz), Math.sin(t * 9 + an.phase) * 0.05);
      } else {
        // chickens: peck about, bolt when a plane comes low
        if (an.run <= 0 && focus && Math.hypot(focus.x - an.x, focus.y - sp.y, focus.z - an.z) < 55) { an.run = 1.4; an.dir = rand(0, 6.3); }
        let hop = 0;
        if (an.run > 0) {
          an.run -= dt;
          an.yaw = an.dir;
          an.x -= Math.sin(an.dir) * 4.5 * dt; an.z -= Math.cos(an.dir) * 4.5 * dt;
          if (Math.hypot(an.x - sp.x, an.z - sp.z) > 9) an.dir += Math.PI;
          hop = Math.abs(Math.sin(t * 11 + an.phase)) * 0.7;
        }
        placeAnimal(an, an.x, sp.y + hop, an.z, an.yaw, an.run > 0 ? -0.15 : Math.sin(t * 2.2 + an.phase) * 0.12 + 0.1);
      }
    }
    for (const vg of villagers) {
      const near = focus && Math.hypot(focus.x - vg.x, focus.z - vg.z) < 150;
      const want = near ? Math.atan2(-(focus.x - vg.x), -(focus.z - vg.z)) : vg.yaw + Math.sin(t * 0.4 + vg.phase) * 0.4;
      let d = want - vg.look; d = Math.atan2(Math.sin(d), Math.cos(d));
      vg.look += d * Math.min(1, dt * 3);
      placeAnimal(vg, vg.x, vg.y + (near ? Math.abs(Math.sin(t * 6 + vg.phase)) * 0.4 : 0), vg.z, vg.look, 0);
    }
    if (focus) gustPos.value.copy(focus);
    gustAmt.value = THREE.MathUtils.clamp(speed / 80, 0, 1.4);
  };
  update(0, 0, null, 0);
  return { update, gullSpots, boats, flocks, brushPalms, meadows, villages };
}

// ---------------------------------------------------------------- assemble
export function createWorld(scene, { mobile, lit, glow, soft }) {
  const sunDirUniform = uniform(SUN_DIR.clone());
  const tod = { skyTop: uniform(new THREE.Color(TIMES.noon.skyTop)), skyMid: uniform(new THREE.Color(TIMES.noon.skyMid)), horizon: uniform(new THREE.Color(TIMES.noon.horizon)), glow: uniform(new THREE.Color(TIMES.noon.glow)), fog: uniform(new THREE.Color(TIMES.noon.fog)) };

  const sun = new THREE.DirectionalLight(0xfff1d8, 3.3);
  sun.castShadow = true;
  const sm = sun.shadow;
  sm.mapSize.set(mobile ? 1024 : 2048, mobile ? 1024 : 2048);
  const ext = 340;
  sm.camera.left = -ext; sm.camera.right = ext; sm.camera.top = ext; sm.camera.bottom = -ext;
  sm.camera.near = 10; sm.camera.far = 1600;
  sm.bias = -0.0003;
  sm.normalBias = 0.8;
  sm.radius = 3;
  // The water's reflection renders the scene with a second camera, which would redraw the shadow map a second
  // time each frame. The map doesn't depend on the viewing camera, so render it exactly once per frame instead.
  sm.autoUpdate = false;
  scene.add(sun, sun.target);

  const hemi = new THREE.HemisphereLight(0x9fd0ff, 0xe4c58c, 1.25);
  scene.add(hemi);

  // Two fogs in one: the far fog that swallows the horizon, and under it a faint haze that starts a couple of
  // hundred units out and reaches a sixth of the way to sky colour by 2600, denser near sea level than up in the
  // mountains, so distant isles sit back in the air instead of cutting out of it.
  const farFog = rangeFogFactor(1500, 4600);
  const haze = smoothstep(float(140), float(2600), positionView.z.negate()).mul(0.16)
    .mul(mix(float(1), float(0.5), smoothstep(float(0), float(320), positionWorld.y)));
  scene.fogNode = fog(tod.fog, farFog.add(haze.mul(float(1).sub(farFog))));

  const terrain = buildTerrain();
  const seafloor = buildSeafloor();
  const water = buildWater({ mobile });
  const fresh = buildFreshWater(water.lakeMaterial);
  const bigFalls = soft ? buildWaterfalls(soft) : [];
  const sky = buildSky(sunDirUniform, tod);
  const sunSlot = glow.alloc();
  glow.color(sunSlot, 0xfff3d6); glow.scalar(sunSlot, 4);
  const clouds = buildClouds();
  const props = buildProps(scene, lit, glow);
  const landmarks = buildLandmarks(lit, glow);
  const arenas = findArenas(props.villages);
  const bounds = buildBounds();
  scene.add(terrain, seafloor, water.near, water.far, fresh, sky, clouds.mesh, bounds.group);

  // Where the sun sits on screen, for the sun shafts: strength fades as it leaves the frame and is 0 behind us.
  const sunScreen = { uv: uniform(new THREE.Vector2(0.5, 0.5)), strength: uniform(0) };
  const sunNdc = new THREE.Vector3(), tmpDir = new THREE.Vector3();
  const shadowFocus = new THREE.Vector3(), sunM = new THREE.Matrix4(), sunQ = new THREE.Quaternion(), sunS = new THREE.Vector3(150, 150, 150), sunP = new THREE.Vector3(), sunE = new THREE.Euler();
  let sunSpin = 0;
  let timeOfDay = 'noon';
  /** Swings the sun and retints the light, sky and fog for one of TIMES. The water is not touched: it only
   *  receives the new light like everything else. */
  const setTimeOfDay = (name) => {
    const T = TIMES[name] || TIMES.noon;
    timeOfDay = name;
    SUN_DIR.set(T.dir[0], T.dir[1], T.dir[2]).normalize();
    sunDirUniform.value.copy(SUN_DIR);
    lightRight.crossVectors(new THREE.Vector3(0, 1, 0), SUN_DIR).normalize();
    lightUp.crossVectors(SUN_DIR, lightRight).normalize();
    sun.color.set(T.sun[0]); sun.intensity = T.sun[1];
    hemi.color.set(T.hemi[0]); hemi.groundColor.set(T.hemi[1]); hemi.intensity = T.hemi[2];
    tod.skyTop.value.set(T.skyTop); tod.skyMid.value.set(T.skyMid); tod.horizon.value.set(T.horizon); tod.glow.value.set(T.glow); tod.fog.value.set(T.fog);
    glow.color(sunSlot, T.disc);
  };
  // Motion smear for the post pass: how far the camera turned (yaw, pitch, roll) and moved (in its own frame) since
  // the last displayed frame. The rotation smears everything equally; the translation is divided by each pixel's
  // depth in the shader, so near ground streaks past while far isles and sky barely move. It only switches on past
  // a threshold of turn rate or speed, then follows the projected motion. A 180 degree shutter, softened.
  const smear = { shift: uniform(new THREE.Vector2()), roll: uniform(0), trans: uniform(new THREE.Vector3()), fy: uniform(1), aspect: uniform(1) };
  const prevCamQ = new THREE.Quaternion(), prevCamP = new THREE.Vector3(), dq = new THREE.Quaternion(), camInv = new THREE.Quaternion(), dp = new THREE.Vector3();
  let smearReady = false;
  const lightRight = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), SUN_DIR).normalize();
  const lightUp = new THREE.Vector3().crossVectors(SUN_DIR, lightRight).normalize();
  const update = (dt, t, focus, camera, speed = 0) => {
    clouds.update(dt);
    props.update(dt, t, focus, speed);
    landmarks.animate(dt);
    sky.position.copy(camera.position);
    sunSpin += dt * 0.1;
    sunP.copy(camera.position).addScaledVector(SUN_DIR, 5200);
    glow.matrix(sunSlot, sunM.compose(sunP, sunQ.setFromEuler(sunE.set(0.6, 0.4 + sunSpin, 0.2)), sunS));
    camera.updateMatrixWorld();
    sunNdc.copy(sunP).project(camera);
    const behind = sunNdc.z > 1 || SUN_DIR.dot(tmpDir.set(0, 0, -1).applyQuaternion(camera.quaternion)) < 0;
    const edge = Math.max(Math.abs(sunNdc.x), Math.abs(sunNdc.y));
    sunScreen.uv.value.set((sunNdc.x + 1) * 0.5, (sunNdc.y + 1) * 0.5);
    sunScreen.strength.value = behind ? 0 : 1 - THREE.MathUtils.smoothstep(edge, 1.0, 1.7);
    const fy = 0.5 / Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5);   // focal length in screen heights
    let gate = 0;
    if (smearReady && dt > 0 && dt < 0.1 && speed > 0) {
      dq.copy(prevCamQ).invert().multiply(camera.quaternion);                                   // the turn since last frame
      dp.copy(camera.position).sub(prevCamP).applyQuaternion(camInv.copy(camera.quaternion).invert());   // the move, in the camera's frame
      const omega = 2 * Math.acos(Math.min(1, Math.abs(dq.w))) / dt, v = dp.length() / dt;
      gate = Math.max(THREE.MathUtils.smoothstep(omega, 0.6, 1.6), THREE.MathUtils.smoothstep(v, 85, 115)) * 0.35;
    }
    if (gate > 0) {
      smear.shift.value.set(2 * dq.y * fy * gate, -2 * dq.x * fy * gate);   // yaw and pitch: the whole frame slides
      smear.roll.value = 2 * dq.z * gate;                                    // roll: the frame swirls about the centre
      smear.trans.value.copy(dp).multiplyScalar(gate);                       // travel: divided by depth per pixel
    } else { smear.shift.value.set(0, 0); smear.roll.value = 0; smear.trans.value.set(0, 0, 0); }   // a cut, a stall, the title
    prevCamQ.copy(camera.quaternion); prevCamP.copy(camera.position); smearReady = true;
    smear.fy.value = fy; smear.aspect.value = camera.aspect;
    // Snap the shadow frustum to whole shadow-map texels in light space so shadow edges don't crawl as the player moves.
    const texel = (2 * ext) / sm.mapSize.x;
    const dr = shadowFocus.copy(focus).dot(lightRight), du = focus.dot(lightUp);
    shadowFocus.addScaledVector(lightRight, -(dr - Math.round(dr / texel) * texel)).addScaledVector(lightUp, -(du - Math.round(du / texel) * texel));
    // The light sits high enough that the clouds (420..530 up) fall inside its frustum, so their shadows sweep the
    // sea and land below. The depth range is unchanged, so shadow precision is too.
    sun.position.copy(shadowFocus).addScaledVector(SUN_DIR, 1150);
    sun.target.position.copy(shadowFocus);
    sun.target.updateMatrixWorld();
    sm.needsUpdate = true;
  };

  /** Distance to the nearest big waterfall (for its rumble). */
  const nearestFall = (pos) => { let d = Infinity; for (const f of bigFalls) d = Math.min(d, Math.hypot(pos.x - f.x, pos.y - f.y, pos.z - f.z)); return d; };
  return { update, setDanger: bounds.setDanger, props, nearestFall, bigFalls, sunScreen, smear, clouds: clouds.clouds, brushPalms: props.brushPalms, setTimeOfDay, get timeOfDay() { return timeOfDay; }, landmarks, arenas };
}
