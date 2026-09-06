// Three landmarks worth finding, placed by terrain queries and built from the shared box batches: a lighthouse on a
// headland whose beam sweeps the sea, a shipwreck broken on a reef, and a ring of stone pillars in the highlands you
// can thread. Finding one is worth a small bonus, a medal the first time, and a line in the feed.
import * as THREE from 'three/webgpu';
import { ensureGrid, levelAtCell, cellKind, cellTop, heightAt, isSeaAt, KIND, N, CELL } from './terrain.js';

const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3();
const Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1), X = new THREE.Vector3(1, 0, 0);
const isLand = (i, j) => levelAtCell(i, j) > 0;
const isSea = (i, j) => levelAtCell(i, j) === 0;

/** Fraction of cells within `r` (sampled every other cell) for which `test` holds. */
function around(i, j, r, test) {
  let n = 0, k = 0;
  for (let di = -r; di <= r; di += 2) for (let dj = -r; dj <= r; dj += 2) { k++; if (test(i + di, j + dj)) n++; }
  return n / k;
}

/** The headland: land a few terraces up, land all round it, with the most sea within eight cells. */
function findHeadland() {
  let best = null, bestScore = 0.35;
  for (let i = -N + 12; i < N - 12; i += 2) for (let j = -N + 12; j < N - 12; j += 2) {
    const L = levelAtCell(i, j), k = cellKind(i, j);
    if (L < 2 || L > 12 || k === KIND.LAKE || k === KIND.RIVER) continue;
    if (!isLand(i + 1, j) || !isLand(i - 1, j) || !isLand(i, j + 1) || !isLand(i, j - 1)) continue;
    const sea = around(i, j, 8, isSea) + L * 0.01;   // a little height breaks ties toward a proper bluff
    if (sea > bestScore) { bestScore = sea; best = { i, j }; }
  }
  return best;
}
/** The reef: shallow sea, three cells or more from any land, the shallowest such spot. */
function findReef() {
  let best = null, bestH = -Infinity;
  for (let i = -N + 12; i < N - 12; i += 3) for (let j = -N + 12; j < N - 12; j += 3) {
    if (!isSea(i, j)) continue;
    const h = heightAt(i * CELL, j * CELL);
    if (h > -3.5 || h < -9 || h <= bestH) continue;   // sea-floor depths are unscaled
    if (around(i, j, 8, isLand) > 0) continue;
    bestH = h; best = { i, j };
  }
  return best;
}
/** The highland: the highest spot whose 5x5 neighbourhood is within a terrace of it, on stone or meadow. */
function findHighland() {
  let best = null, bestL = 11;
  for (let i = -N + 10; i < N - 10; i += 2) for (let j = -N + 10; j < N - 10; j += 2) {
    const L = levelAtCell(i, j), k = cellKind(i, j);
    if (L <= bestL || (k !== KIND.STONE && k !== KIND.MEADOW && k !== KIND.ROCK && k !== KIND.SNOW)) continue;
    let flat = true;
    for (let di = -3; di <= 3 && flat; di++) for (let dj = -3; dj <= 3; dj++) if (Math.abs(levelAtCell(i + di, j + dj) - L) > 1) { flat = false; break; }
    if (!flat) continue;
    bestL = L; best = { i, j };
  }
  return best;
}

export function buildLandmarks(lit, glow) {
  ensureGrid();
  const box = (x, y, z, sx, sy, sz, hex, rough = 0.85) => { const i = lit.alloc(); lit.color(i, hex); lit.scalar(i, rough); lit.matrix(i, m.compose(p.set(x, y, z), q.identity(), s.set(sx, sy, sz))); return i; };
  const tilted = (x, y, z, sx, sy, sz, hex, rot) => { const i = lit.alloc(); lit.color(i, hex); lit.scalar(i, 0.85); lit.matrix(i, m.compose(p.set(x, y, z), rot, s.set(sx, sy, sz))); return i; };
  const list = [];

  // --- the lighthouse: a banded tower, a dark gallery, the lamp, and one long beam through it that sweeps
  const head = findHeadland();
  let beam = -1, lamp = null;
  if (head) {
    const x = head.i * CELL, z = head.j * CELL, y = cellTop(head.i, head.j);
    box(x, y + 1, z, 7, 2, 7, 0x9ea2a8);
    for (let k = 0; k < 6; k++) box(x, y + 2 + 2.3 * (k + 0.5), z, 4.6 - k * 0.25, 2.3, 4.6 - k * 0.25, k % 2 ? 0xd94a3a : 0xfff6e5, 0.7);
    const top = y + 2 + 6 * 2.3;
    box(x, top + 0.6, z, 5.2, 1.2, 5.2, 0x2b2f3a);
    box(x, top + 2.4, z, 2.6, 2.4, 2.6, 0xbfe9ff, 0.15);
    box(x, top + 4.2, z, 3.4, 1.2, 3.4, 0xd94a3a); box(x, top + 5.2, z, 1.6, 1.0, 1.6, 0xd94a3a);
    const lampSlot = glow.alloc(); glow.color(lampSlot, 0xfff1c0); glow.scalar(lampSlot, 3); glow.matrix(lampSlot, m.compose(p.set(x, top + 2.4, z), q.identity(), s.set(1.6, 1.6, 1.6)));
    beam = glow.alloc(); glow.color(beam, 0xfff1c0); glow.scalar(beam, 1.1);
    lamp = new THREE.Vector3(x, top + 2.4, z);
    list.push({ id: 'lighthouse', pos: lamp, radius: 50, name: 'LIGHTHOUSE' });
  }

  // --- the shipwreck: a hull broken in two on the reef, ribs showing, the mast down with a rag of sail
  const reef = findReef();
  if (reef) {
    const x = reef.i * CELL, z = reef.j * CELL, yaw = 0.7;
    const rot = new THREE.Quaternion().setFromAxisAngle(Y, yaw).multiply(q.setFromAxisAngle(Z, 0.35));
    const rot2 = new THREE.Quaternion().setFromAxisAngle(Y, yaw + 0.5).multiply(q.setFromAxisAngle(Z, -0.5));
    tilted(x, -0.6, z, 6, 4.5, 14, 0x5a3d2a, rot);                                        // stern half
    tilted(x + Math.cos(yaw) * 2, 0.4, z - Math.sin(yaw) * 2, 5, 1, 13, 0x8a6a4a, rot);   // deck
    tilted(x - Math.sin(yaw) * 14, -1.4, z - Math.cos(yaw) * 14, 5, 4, 8, 0x5a3d2a, rot2); // bow, broken off
    for (let k = 0; k < 3; k++) tilted(x + Math.sin(yaw) * (6 + k * 3), 0.2, z + Math.cos(yaw) * (6 + k * 3), 0.6, 4.5, 0.6, 0x8a6a4a, rot);   // ribs
    const mastRot = new THREE.Quaternion().setFromAxisAngle(Y, yaw).multiply(q.setFromAxisAngle(X, 1.1));
    tilted(x + 2, 4, z + 3, 0.6, 16, 0.6, 0x8a6a4a, mastRot);
    tilted(x + 2.5, 6.5, z + 6, 0.25, 5, 5, 0xe9dccb, mastRot);
    box(x - 4, 0.3, z + 5, 1.6, 1.6, 1.6, 0x7a5a3a); box(x + 6, 0.3, z - 3, 1.6, 1.6, 1.6, 0x7a5a3a);   // barrels adrift
    list.push({ id: 'wreck', pos: new THREE.Vector3(x, 0, z), radius: 40, low: 30, name: 'SHIPWRECK' });
  }

  // --- the stone ring: eight pillars on the highland, a gap between each you can fly through
  const high = findHighland();
  if (high) {
    const x = high.i * CELL, z = high.j * CELL, y = cellTop(high.i, high.j);
    for (let k = 0; k < 8; k++) {
      const a = k / 8 * Math.PI * 2, px = x + Math.cos(a) * 24, pz = z + Math.sin(a) * 24;
      const base = cellTop(Math.round(px / CELL), Math.round(pz / CELL));
      box(px, base + 8, pz, 3.2, 16, 3.2, k % 2 ? 0x8d8f93 : 0x7c7e83, 0.9);
      box(px, base + 16.6, pz, 4, 1.4, 4, 0x6a6d74, 0.9);
    }
    box(x, y + 0.8, z, 6, 1.6, 6, 0x6a6d74, 0.9);
    list.push({ id: 'pillars', pos: new THREE.Vector3(x, y, z), radius: 11, ring: [y + 2, y + 17], name: 'STONE RING' });
  }

  let sweep = 0;
  /** Per frame: the beam sweeps. */
  const animate = (dt) => {
    if (beam < 0) return;
    sweep += dt * 0.45;
    m.compose(lamp, q.setFromAxisAngle(Y, sweep), s.set(1.6, 1.0, 300));
    glow.matrix(beam, m);
  };
  /** Per sim step: which landmark, if any, the plane has just found. `found` is the run's set. */
  const check = (pos, found) => {
    for (const l of list) {
      if (found.has(l.id)) continue;
      const dx = pos.x - l.pos.x, dz = pos.z - l.pos.z, dh = Math.hypot(dx, dz);
      if (l.ring) { if (dh < l.radius && pos.y > l.ring[0] && pos.y < l.ring[1]) return l; continue; }
      if (l.low !== undefined) { if (dh < l.radius && pos.y < l.low) return l; continue; }
      if (Math.hypot(dh, pos.y - l.pos.y) < l.radius) return l;
    }
    return null;
  };
  console.info(`landmarks: ${list.map((l) => `${l.id} (${Math.round(l.pos.x)}, ${Math.round(l.pos.z)})`).join(', ')}`);
  return { list, animate, check };
}

/** Arenas: named parts of the map a wave's portal can open over. Found once from the terrain. */
export function findArenas(villages) {
  ensureGrid();
  const out = [];
  // the mountain lake: the lake cell with the most lake around it
  let best = null, bestS = 0.2;
  for (let i = -N + 8; i < N - 8; i += 3) for (let j = -N + 8; j < N - 8; j += 3) {
    if (cellKind(i, j) !== KIND.LAKE) continue;
    const sc = around(i, j, 10, (a, b) => cellKind(a, b) === KIND.LAKE);
    if (sc > bestS) { bestS = sc; best = { i, j }; }
  }
  if (best) { const y = cellTop(best.i, best.j); out.push({ id: 'lake', name: y > 40 ? 'THE MOUNTAIN LAKE' : 'THE LAKE', x: best.i * CELL, z: best.j * CELL, y }); }
  // the fjord: sea, with sea close around it, and the most land a little further out
  best = null; bestS = 0.45;
  for (let i = -N + 12; i < N - 12; i += 3) for (let j = -N + 12; j < N - 12; j += 3) {
    if (!isSea(i, j) || around(i, j, 3, isSea) < 0.95) continue;
    const sc = around(i, j, 14, isLand);
    if (sc > bestS) { bestS = sc; best = { i, j }; }
  }
  if (best) out.push({ id: 'fjord', name: 'THE FJORD', x: best.i * CELL, z: best.j * CELL, y: 0 });
  // the peak: the highest ground
  best = null; bestS = 0;
  for (let i = -N + 8; i < N - 8; i += 2) for (let j = -N + 8; j < N - 8; j += 2) { const t = cellTop(i, j); if (t > bestS) { bestS = t; best = { i, j }; } }
  if (best) out.push({ id: 'peak', name: 'THE HIGH PEAKS', x: best.i * CELL, z: best.j * CELL, y: bestS });
  // the village bay: over the first village
  if (villages && villages.length) out.push({ id: 'bay', name: 'THE VILLAGE BAY', x: villages[0].x, z: villages[0].z, y: villages[0].y });
  // open water: the sea cell farthest from any land, for the wide-open fights
  best = null; bestS = 0.999;
  for (let i = -N + 20; i < N - 20; i += 5) for (let j = -N + 20; j < N - 20; j += 5) {
    if (!isSea(i, j)) continue;
    const sc = around(i, j, 16, isSea);
    if (sc >= bestS && Math.hypot(i, j) < N * 0.8) { bestS = sc; best = { i, j }; }
  }
  if (best) out.push({ id: 'sea', name: 'THE OPEN SEA', x: best.i * CELL, z: best.j * CELL, y: 0 });
  console.info(`arenas: ${out.map((a) => `${a.id} (${Math.round(a.x)}, ${Math.round(a.z)})`).join(', ')}`);
  return out;
}
