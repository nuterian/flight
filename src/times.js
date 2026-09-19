// The three lights a run can fly under, as far as the start of the page needs them: where the sun stands (shadows
// are baked for each, prepare.js) and the sky's colours (the veil over the canvas wears them until the first frame,
// start.js). No imports. world.js has the rest of each light.
export const LIGHTS = ['morning', 'noon', 'golden'];
export const SUN_DIRS = { morning: [0.85, 0.4, 0.25], noon: [0.5, 0.7, 0.5], golden: [-0.62, 0.3, 0.55] };
export const SKIES = {
  morning: { skyTop: 0x3f8ce9, skyMid: 0x93cdff, horizon: 0xe2f0ff },
  noon: { skyTop: 0x2f7fe6, skyMid: 0x7fc4ff, horizon: 0xbfe0ff },
  golden: { skyTop: 0x2a5fc4, skyMid: 0x6fa3e8, horizon: 0xffc79c },
};
