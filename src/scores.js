// The two themes, as data plus an `at(m, bar, step, t)` that plays them on the music engine (music.js).
import { f } from './music.js';

const rnd = (a, b) => a + Math.random() * (b - a);

// ---------------------------------------------------------------- Coral Isles: the laid-back one
const CI = {
  D: { bass: 38, tones: [62, 66, 69, 74], uke: [69, 74, 78, 81] }, A: { bass: 33, tones: [57, 61, 64, 69], uke: [69, 73, 76, 81] },
  Bm: { bass: 35, tones: [59, 62, 66, 71], uke: [71, 74, 78, 83] }, G: { bass: 31, tones: [55, 59, 62, 67], uke: [67, 71, 74, 79] },
  Fm: { bass: 30, tones: [54, 57, 61, 66], uke: [66, 69, 73, 78] },
};
const CI_A = ['D', 'A', 'Bm', 'G', 'D', 'A', 'G', 'A'], CI_B = ['Bm', 'Fm', 'G', 'D', 'Bm', 'Fm', 'G', 'A'];
const CI_PROG = [...CI_A, ...CI_A, ...CI_B, ...CI_A];
const CI_HOOK = [
  [[74, 0, .5], [78, .5, .5], [81, 1, 1], [83, 2, .5], [81, 2.5, .5], [78, 3, 1]],
  [[76, 0, .75], [73, .75, .25], [76, 1, 1], [81, 2, 1.5]],
  [[83, 0, .5], [81, .5, .5], [78, 1, 1], [76, 2, .5], [78, 2.5, .5], [81, 3, 1]],
  [[79, 0, 1], [78, 1, .5], [76, 1.5, .5], [74, 2, 2]],
  [[74, 0, .5], [78, .5, .5], [81, 1, 1], [83, 2, .5], [81, 2.5, .5], [78, 3, 1]],
  [[76, 0, .75], [73, .75, .25], [76, 1, 1], [78, 2, .5], [81, 2.5, 1.5]],
  [[79, 0, .5], [81, .5, .5], [83, 1, 1], [86, 2, 1], [85, 3, .5], [83, 3.5, .5]],
  [[81, 0, 1.5], [78, 1.5, .5], [76, 2, .5], [74, 2.5, 1.5]],
];
const CI_BRIDGE = [
  [[86, 0, 1], [85, 1, .5], [83, 1.5, .5], [81, 2, 2]],
  [[81, 0, .5], [83, .5, .5], [85, 1, 1], [81, 2, 2]],
  [[83, 0, .5], [81, .5, .5], [79, 1, 1], [78, 2, .5], [79, 2.5, .5], [81, 3, 1]],
  [[78, 0, 1.5], [74, 1.5, .5], [76, 2, .5], [78, 2.5, 1.5]],
  [[86, 0, 1], [85, 1, .5], [83, 1.5, .5], [81, 2, 2]],
  [[81, 0, .5], [83, .5, .5], [85, 1, 1], [86, 2, 2]],
  [[86, 0, .5], [85, .5, .5], [83, 1, 1], [81, 2, .5], [79, 2.5, .5], [78, 3, 1]],
  [[76, 0, 1], [78, 1, .5], [81, 1.5, .5], [85, 2, 2]],
];
const CI_MELODY = [...CI_HOOK, ...CI_HOOK, ...CI_BRIDGE, ...CI_HOOK];
const DMAJ = [2, 4, 6, 7, 9, 11, 1];
const thirdBelow = (midi, scale) => {
  const pc = ((midi % 12) + 12) % 12, i = scale.indexOf(pc);
  if (i < 0) return midi - 4;
  const j = (i + 5) % 7, down = scale[j] > pc ? 12 - (scale[j] - pc) : pc - scale[j];
  return midi - down;
};

export const ISLES = {
  name: 'Coral Isles', bpm: 96, swing: 0.28, drift: 0.012, bars: 32, level: 0.5,
  at(m, bar, s, t) {
    const STEP = m.STEP, beat = s / 4, section = bar < 8 ? 0 : bar < 16 ? 1 : bar < 24 ? 2 : 3, chord = CI[CI_PROG[bar]];
    for (const [n, start, len] of CI_MELODY[bar]) if (Math.abs(start - beat) < 1e-6) {
      const dur = len * STEP * 4, vel = rnd(0.8, 1) * (len >= 1 ? 1 : 0.85);
      m.epiano(f(n), t, dur, 0.5 * vel);
      if (section >= 2) m.flute(f(n + 12), t + rnd(0.005, 0.02), dur, 0.09 * vel);
      if (section === 3) m.epiano(f(thirdBelow(n, DMAJ)), t + rnd(0.004, 0.015), dur, 0.28 * vel);
    }
    if (section >= 1 && (s === 0 || s === 6)) for (const n of chord.tones) m.epiano(f(n), t + rnd(0, 0.02), STEP * 5, s === 0 ? 0.16 : 0.11);
    if (section >= 1 && (s === 4 || s === 6 || s === 12 || s === 14)) m.strum(chord.uke, t, s % 8 === 4 ? 0.7 : 0.45, s % 8 === 6);
    if (s === 0 || s === 8) m.upright(f(chord.bass), t, rnd(0.85, 1));
    else if (s === 12 && section >= 1) m.upright(f(chord.bass + 7), t, 0.7);
    if (s === 0 && section >= 1) for (const n of chord.tones.slice(0, 3)) m.strings(f(n - 12), t, STEP * 16);
    if (section >= 1) {
      if (s === 0 || s === 8) m.kick(t, rnd(0.22, 0.28));
      if (s === 4 || s === 12) m.brush(t, rnd(0.05, 0.07));
    }
  },
};

// ---------------------------------------------------------------- Dogfight: the one that gets you in the plane
// D minor, 150 BPM. Eight bars of build (drone, string ostinato, timpani, a horn call, a roll), then the brass theme
// over galloping bass and a full kit, a lifted bridge, and the theme back with strings answering, into a turnaround.
const DF = {
  Dm: { bass: 38, tones: [62, 65, 69, 74] }, Bb: { bass: 34, tones: [58, 62, 65, 70] }, F: { bass: 41, tones: [65, 69, 72, 77] },
  C: { bass: 36, tones: [60, 64, 67, 72] }, Gm: { bass: 43, tones: [67, 70, 74, 79] }, A: { bass: 33, tones: [57, 61, 64, 69] },
};
const DF_A = ['Dm', 'Bb', 'F', 'C', 'Dm', 'Bb', 'F', 'A'], DF_B = ['Gm', 'Dm', 'Bb', 'A', 'Gm', 'Dm', 'Bb', 'A'];
const DF_PROG = [...DF_A, ...DF_A, ...DF_B, ...DF_A];
const DF_CALL = [[], [], [], [], [[69, 0, 4]], [[74, 0, 4]], [[77, 0, 3], [76, 3, 1]], [[74, 0, 3.5]]];
const DF_THEME = [
  [[74, 0, .5], [74, .5, .5], [77, 1, 1], [81, 2, 1.5], [79, 3.5, .5]],
  [[77, 0, .5], [79, .5, .5], [82, 1, 1.5], [81, 2.5, .5], [79, 3, 1]],
  [[77, 0, .5], [77, .5, .5], [81, 1, 1], [84, 2, 1.5], [82, 3.5, .5]],
  [[81, 0, 1], [79, 1, .5], [77, 1.5, .5], [76, 2, 2]],
  [[74, 0, .5], [74, .5, .5], [77, 1, 1], [81, 2, 1.5], [79, 3.5, .5]],
  [[77, 0, .5], [79, .5, .5], [82, 1, 1.5], [84, 2.5, .5], [82, 3, 1]],
  [[81, 0, .5], [81, .5, .5], [84, 1, 1], [86, 2, 1.5], [84, 3.5, .5]],
  [[82, 0, .5], [81, .5, .5], [79, 1, 1], [73, 2, 1], [74, 3, 1]],
];
const DF_BRIDGE = [
  [[79, 0, 1], [82, 1, .5], [84, 1.5, .5], [86, 2, 2]],
  [[86, 0, .5], [84, .5, .5], [81, 1, 1], [77, 2, 2]],
  [[82, 0, 1], [84, 1, .5], [86, 1.5, .5], [89, 2, 2]],
  [[85, 0, 1], [81, 1, 1], [76, 2, 2]],
  [[79, 0, 1], [82, 1, .5], [84, 1.5, .5], [86, 2, 2]],
  [[86, 0, .5], [84, .5, .5], [81, 1, 1], [86, 2, 2]],
  [[89, 0, 1], [86, 1, .5], [84, 1.5, .5], [82, 2, 2]],
  [[85, 0, 1.5], [84, 1.5, .5], [85, 2, .5], [86, 2.5, 1.5]],
];
const DF_MELODY = [...DF_CALL, ...DF_THEME, ...DF_BRIDGE, ...DF_THEME];
const DMIN = [2, 4, 5, 7, 9, 10, 0];
const GALLOP = [1, 0, 1, 1];   // dun-da-da on every beat

export const DOGFIGHT = {
  name: 'Dogfight', bpm: 150, swing: 0, drift: 0.005, bars: 32, level: 0.46,
  at(m, bar, s, t) {
    const STEP = m.STEP, beat = s / 4, section = bar < 8 ? 0 : bar < 16 ? 1 : bar < 24 ? 2 : 3, chord = DF[DF_PROG[bar]];
    const lastBar = bar % 8 === 7, barT = t - beat * STEP * 4;
    // melody: horn call in the build, brass theme after; strings answer a third below in the last chorus
    for (const [n, start, len] of DF_MELODY[bar]) if (Math.abs(start - beat) < 1e-6) {
      const dur = len * STEP * 4;
      m.brass(f(n), t, dur, section === 0 ? 0.09 : 0.15);
      if (section === 3) m.stab(f(thirdBelow(n, DMIN)), t + 0.01, 0.06, Math.min(dur, 0.5));
    }
    // build: an engine drone, a string ostinato that crescendos, timpani, and a roll into the drop
    if (section === 0) {
      if (s === 0 && bar % 4 === 0) m.drone(f(38), barT, STEP * 64, 0.09);
      if (s % 2 === 0) m.stab(f(chord.tones[[0, 1, 2, 3, 2, 1, 3, 2][s / 2]]), t, 0.03 + bar * 0.008, 0.11);
      if (s === 0 || s === 8) m.timpani(f(chord.bass), t, 0.28 + bar * 0.05);
      if (bar >= 6 && s === 12) m.tom(f(chord.bass + 12), t, 0.3);
      if (lastBar) { if (s >= 8) m.snare(t, 0.12 + (s - 8) * 0.03); if (s === 0) m.riser(t, STEP * 16, 0.12); }
      return;
    }
    // the band: galloping bass, ostinato strings up the octave, kit, a crash on every phrase start
    if (GALLOP[s % 4]) m.drive(f(chord.bass), t, s % 4 === 0 ? 0.32 : 0.22, s % 4 === 0 ? 0.3 : 0.16);
    if (s % 2 === 0) m.stab(f(chord.tones[[0, 2, 1, 3, 0, 2, 3, 1][s / 2]] + (section === 2 ? 12 : 0)), t, section === 2 ? 0.05 : 0.04, 0.1);
    if (s === 0 && section >= 2) for (const n of chord.tones.slice(0, 3)) m.strings(f(n), t, STEP * 16);
    if (s === 0 || s === 8 || s === 6) m.bigKick(t, s === 6 ? 0.5 : 0.7);
    if (s === 4 || s === 12) m.snare(t, 0.32);
    if (s % 2 === 1) m.hat(t, 0.03, s % 4 === 3 ? 0.07 : 0.045);
    if (lastBar && s >= 12) { m.snare(t, 0.22 + (s - 12) * 0.05); m.tom(f(chord.bass + (s - 12) * 3 + 12), t, 0.3); }
    if (s === 0 && bar % 8 === 0) m.crash(t, 0.16);
    if (s === 0 && bar % 8 === 0) m.timpani(f(chord.bass), t, 0.5);
  },
};

export const TRACKS = [DOGFIGHT, ISLES];
