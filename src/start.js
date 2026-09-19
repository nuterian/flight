// The page's script, and nearly empty on purpose. The bundler folds every script of the page into one file, so the
// way to have the world's workers running before the game's megabyte has been fetched and parsed is for this to be
// the page's only script: it starts them (prepare.js, a few kilobytes with what it imports), puts today's sky on the
// veil that covers the canvas until the first frame is on it, and then asks for the game.
import './prepare.js';
import { dailySeed } from './daily.js';
import { LIGHTS, SKIES } from './times.js';

const sky = SKIES[LIGHTS[dailySeed() % 3]], hex = (c) => `#${c.toString(16).padStart(6, '0')}`;
document.getElementById('veil').style.background = `linear-gradient(180deg, ${hex(sky.skyTop)} 0%, ${hex(sky.skyMid)} 68%, ${hex(sky.horizon)} 100%)`;

import('./main.js').catch((err) => console.error(err));
import('./count.js').catch(() => {});   // the page count: after the game has been asked for, never before it
