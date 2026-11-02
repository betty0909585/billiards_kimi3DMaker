// barlogic.js — pure logic for the bar-stool mini-games (dice/roulette).
// No DOM, no Rapier — runs in browser and Node.

import * as THREE from 'three';

// --- dice ---------------------------------------------------------------
// Standard dice: opposite faces sum to 7. Face → value for a die whose
// local axes map: +y=1, -y=6, +x=3, -x=4, +z=2, -z=5.
const FACE_VAL = { py: 1, ny: 6, px: 3, nx: 4, pz: 2, nz: 5 };
const AXES = [
  ['py', [0, 1, 0]], ['ny', [0, -1, 0]],
  ['px', [1, 0, 0]], ['nx', [-1, 0, 0]],
  ['pz', [0, 0, 1]], ['nz', [0, 0, -1]],
];
const _axis = new THREE.Vector3();

/** Value showing on the die's top face, given its world rotation quaternion. */
export function diceTopValue(q) {
  let best = 'py', bestY = -2;
  for (const [k, a] of AXES) {
    const y = _axis.set(a[0], a[1], a[2]).applyQuaternion(q).y;
    if (y > bestY) { bestY = y; best = k; }
  }
  return FACE_VAL[best];
}

/** Best-of-3 high-low match: compare two totals, first to 2 rounds wins. */
export function createDiceMatch() {
  const match = { pw: 0, hw: 0, round: 0, over: false };
  return {
    ...match,
    /** record one round; returns 'player' | 'house' | 'draw' */
    play(playerTotal, houseTotal) {
      match.round++;
      let r = 'draw';
      if (playerTotal > houseTotal) { match.pw++; r = 'player'; }
      else if (houseTotal > playerTotal) { match.hw++; r = 'house'; }
      if (match.pw >= 2 || match.hw >= 2) match.over = true;
      return r;
    },
    score: () => ({ pw: match.pw, hw: match.hw, round: match.round, over: match.over }),
    reset() { match.pw = 0; match.hw = 0; match.round = 0; match.over = false; },
  };
}

// --- russian roulette -----------------------------------------------------
/** One pull after a fresh cylinder spin: 1 in 6 chambers. */
export function rouletteHit(rng = Math.random) {
  return rng() < 1 / 6;
}
