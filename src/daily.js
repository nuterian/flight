// The daily flight: one seeded run per calendar day. The seed drives where you start, where each wave's portal
// opens and how each wave is composed, so everyone who flies today flies the same day. The world itself is fixed.
import { store } from './audio.js';
import { mulberry32 } from './rng.js';

/** Local calendar date as YYYY-MM-DD. */
export function todayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
/** A short, human date for the title and the debrief. */
export function todayLabel(d = new Date()) {
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}
/** The daily's number: day 1 was the first daily flight. */
export function dayNumber(key = todayKey()) {
  return Math.max(1, Math.round((Date.UTC(+key.slice(0, 4), +key.slice(5, 7) - 1, +key.slice(8, 10)) - Date.UTC(2026, 8, 6)) / 86400000) + 1);
}
/** FNV-1a of the date key: the day's seed. */
export function dailySeed(key = todayKey()) {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
export { mulberry32 };

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
  return `Flight #${dayNumber(date)} · wave ${wave} · ${kills} kills · ${score} · ${pips}`;
}
