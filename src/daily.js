// The daily flight: one seeded run per calendar day. The seed drives where you start, where each wave's portal
// opens and how each wave is composed, so everyone who flies today flies the same day. The world itself is fixed.
import { store } from './audio.js';

/** Local calendar date as YYYY-MM-DD. */
export function todayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
/** A short, human date for the title and the debrief. */
export function todayLabel(d = new Date()) {
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}
/** FNV-1a of the date key: the day's seed. */
export function dailySeed(key = todayKey()) {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
/** Small, fast, seedable PRNG with the same call shape as Math.random. */
export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Today's best, or null when today has not been flown yet. */
export function loadDailyBest(key = todayKey()) {
  try { const d = JSON.parse(store.get('skyfight.daily') || 'null'); return d && d.date === key ? d : null; } catch (_) { return null; }
}
export function saveDailyBest(entry) { store.set('skyfight.daily', JSON.stringify(entry)); }

/** The result line for the clipboard: date, wave, kills, score and the medals as squares, like a word-game grid.
 *  `wings` is how many of the three wave medals this run reached, `secrets` the secret medals it earned. */
export function shareLine({ date, wave, kills, score, wings, secrets, secretCount }) {
  const W = ['\u{1F7EB}', '⬜', '\u{1F7E8}'];   // brown, white, yellow squares: bronze, silver, gold
  const pips = W.map((c, i) => (i < wings ? c : '⬛')).join('') + ' ' + Array.from({ length: secretCount }, (_, i) => (i < secrets ? '\u{1F7E9}' : '⬛')).join('');
  return `Flight ${date} · wave ${wave} · ${kills} kills · ${score} · ${pips}`;
}
