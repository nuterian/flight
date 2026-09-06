// Medals: three for how far you get and a handful of secret ones for how you fly. Earned once, kept in storage,
// shown as small voxel pips on the title (greyed until earned) and named once on the debrief. No grinding, no
// currency, no timers.
import { store } from './audio.js';

export const MEDALS = [
  { id: 'bronze', name: 'Bronze wings', hint: 'Reach wave 3', wave: 3, color: '#c77b3a' },
  { id: 'silver', name: 'Silver wings', hint: 'Reach wave 6', wave: 6, color: '#d5dde6' },
  { id: 'gold', name: 'Gold wings', hint: 'Reach wave 10', wave: 10, color: '#ffc233' },
  { id: 'wavetop', name: 'Wavetop', hint: 'A kill from under 8 units altitude', secret: true, color: '#2fd1a0' },
  { id: 'marksman', name: 'Marksman', hint: 'A wave with every shot a hit', secret: true, color: '#2fd1a0' },
  { id: 'loop', name: 'Loop the loop', hint: 'A full loop without firing', secret: true, color: '#2fd1a0' },
  { id: 'lighthouse', name: 'Keeper', hint: 'Find the lighthouse', landmark: true, color: '#ffd166' },
  { id: 'wreck', name: 'Salvage', hint: 'Find the shipwreck', landmark: true, color: '#ffd166' },
  { id: 'pillars', name: 'Needle', hint: 'Thread the stone ring', landmark: true, color: '#ffd166' },
];
export const byId = (id) => MEDALS.find((m) => m.id === id);

export class Medals {
  /** `persist` false gives a scratch set that neither reads nor writes storage (headless tests). */
  constructor(persist = true) {
    this.persist = persist;
    this.earned = new Set();
    if (!persist) return;
    try { for (const id of JSON.parse(store.get('skyfight.medals') || '[]')) if (byId(id)) this.earned.add(id); } catch (_) { /* fresh */ }
  }
  has(id) { return this.earned.has(id); }
  /** Records a medal; returns true the first time it is earned. */
  earn(id) {
    if (!byId(id) || this.earned.has(id)) return false;
    this.earned.add(id);
    if (this.persist) store.set('skyfight.medals', JSON.stringify([...this.earned]));
    return true;
  }
}
