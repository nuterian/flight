// One of the workers that build the world while the page starts. Each takes jobs one at a time and answers with
// arrays, handed over without a copy. The jobs and the order they are given in are in prepare.js.
import { heightRows, finishGrid, gridArrays, adoptGrid } from './terrain.js';
import { buildLand, bakeSky, bakeSun, bakeNoise } from './bake.js';

const buffers = (o) => Object.values(o).map((a) => a.buffer);
const JOBS = {
  /** The smooth heights of a band of rows. */
  heights: ({ r0, r1 }) => { const band = heightRows(r0, r1); return [band, buffers(band)]; },
  /** The stitched heights flooded, drained and terraced: the grid, kept here for `land` and sent back as a copy. */
  finish: ({ h, m }) => { finishGrid(h, m); const g = gridArrays(), copy = { H: g.H.slice(), LEVEL: g.LEVEL.slice(), WATER: g.WATER.slice(), KINDS: g.KINDS.slice() }; return [copy, buffers(copy)]; },
  /** The land's geometry, from the grid this worker holds (it finished it, or was handed it). */
  land: () => { const chunks = buildLand(); return [chunks, chunks.flatMap(buffers)]; },
  sky: () => { const a = bakeSky(); return [a, [a.buffer]]; },
  sun: ({ dir }) => { const a = bakeSun(dir); return [a, [a.buffer]]; },
  noise: () => { const a = bakeNoise(); return [a, [a.buffer]]; },
};

self.onmessage = ({ data }) => {
  try {
    if (data.grid) adoptGrid(data.grid);
    const [result, transfer] = JOBS[data.job](data);
    self.postMessage({ id: data.id, result }, transfer);
  } catch (err) {
    self.postMessage({ id: data.id, error: String(err && err.stack || err) });
  }
};
