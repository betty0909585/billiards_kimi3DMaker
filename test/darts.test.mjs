// darts.test.mjs — scoring geometry, launch solver, round state.
// Runs the SAME darts module the game uses. Exit code 0 = all gates green.

import {
  scoreAt, solveLaunch, spread, createRound, predictHit,
  R_BULL_IN, R_BULL_OUT, R_TREBLE0, R_TREBLE1, R_DOUBLE0, R_DOUBLE1,
} from '../src/darts.js';

let passed = 0, failed = 0;
function check(name, cond, detail) {
  const tag = cond ? 'PASS' : 'FAIL';
  if (cond) passed++; else failed++;
  console.log(`[${tag}] ${name}${detail ? ' — ' + detail : ''}`);
}

// ---------------------------------------------------------------
// 1. Bulls and rings on the 20 axis (top of the board).
// ---------------------------------------------------------------
{
  const h = scoreAt(0, 0);
  check('inner bull = 50', h.score === 50 && h.ring === 'inner-bull');
}
{
  const h = scoreAt((R_BULL_IN + R_BULL_OUT) / 2, 0);
  check('outer bull = 25', h.score === 25 && h.ring === 'outer-bull');
}
{
  const h = scoreAt((R_TREBLE0 + R_TREBLE1) / 2, 0);
  check('treble 20 = 60', h.score === 60 && h.mult === 3 && h.sector === 20 && h.ring === 'treble');
}
{
  const h = scoreAt((R_DOUBLE0 + R_DOUBLE1) / 2, 0);
  check('double 20 = 40', h.score === 40 && h.mult === 2 && h.sector === 20 && h.ring === 'double');
}
{
  const h = scoreAt(0.05, 0);
  check('single 20 = 20', h.score === 20 && h.mult === 1 && h.sector === 20 && h.ring === 'single');
}
{
  const h = scoreAt(R_DOUBLE1 + 0.01, 0);
  check('beyond wire = miss', h.score === 0 && h.ring === 'miss');
}

// ---------------------------------------------------------------
// 2. Sector order around the board (player's right = -z).
//    20 on top; clockwise: 1 (right), 5 (left), 3 at bottom-ish.
// ---------------------------------------------------------------
{
  const r = (R_TREBLE0 + R_TREBLE1) / 2;
  const rad = (d) => d * Math.PI / 180;
  const at = (deg) => scoreAt(r * Math.cos(rad(deg)), -r * Math.sin(rad(deg)));
  check('right of top is treble 1', at(18).score === 3 && at(18).sector === 1);
  check('left of top is treble 5', at(-18).score === 15 && at(-18).sector === 5);
  check('bottom is treble 3', at(180).score === 9 && at(180).sector === 3);
  check('half-sector boundary still 20', at(8.9).sector === 20);
  check('just past boundary is 1', at(9.1).sector === 1);
  const s = scoreAt(0, 0.05); // dz>0 = player's left, 9 o'clock
  check('9 o\'clock is single 11', s.score === 11 && s.ring === 'single');
}

// ---------------------------------------------------------------
// 3. Launch solver: trajectory passes through the aim point.
// ---------------------------------------------------------------
{
  const from = { x: -1.75, y: 1.55, z: -2.02 };
  const to = { x: -2.99, y: 1.72, z: -2.02 };
  const speed = 8.5, g = 9.81;
  const v = solveLaunch(from, to, speed, g);
  check('launch speed preserved',
    Math.abs(Math.hypot(v.x, v.y, v.z) - speed) < 1e-9,
    `|v|=${Math.hypot(v.x, v.y, v.z).toFixed(6)}`);
  // integrate and measure offset when crossing the board plane
  let p = { ...from }, vel = { ...v };
  const dt = 1e-4;
  let guard = 0;
  while (p.x > to.x && guard++ < 1e5) {
    vel.y -= g * dt;
    p.x += vel.x * dt; p.y += vel.y * dt; p.z += vel.z * dt;
  }
  const off = Math.hypot(p.y - to.y, p.z - to.z);
  check('trajectory threads the aim point', off < 0.002, `off=${(off * 1000).toFixed(2)}mm`);
}
{
  // reachable off-axis target (aim high on the board)
  const from = { x: -1.75, y: 1.55, z: -2.02 };
  const to = { x: -2.99, y: 1.85, z: -2.10 };
  const v = solveLaunch(from, to, 8.5);
  let p = { ...from }, vel = { ...v };
  const dt = 1e-4;
  let guard = 0;
  while (p.x > to.x && guard++ < 1e5) {
    vel.y -= 9.81 * dt;
    p.x += vel.x * dt; p.y += vel.y * dt; p.z += vel.z * dt;
  }
  check('off-axis aim point threaded', Math.hypot(p.y - to.y, p.z - to.z) < 0.002);
}
{
  // too slow to reach: falls back to direct aim, no NaN
  const v = solveLaunch({ x: 0, y: 0, z: 0 }, { x: -3, y: 0.5, z: 0 }, 1.0);
  const ok = Number.isFinite(v.x + v.y + v.z) && Math.abs(Math.hypot(v.x, v.y, v.z) - 1.0) < 1e-9;
  check('unreachable falls back to direct aim', ok);
}

// ---------------------------------------------------------------
// 4. Spread stays bounded; round bookkeeping.
// ---------------------------------------------------------------
{
  let maxR = 0;
  for (let i = 0; i < 500; i++) {
    const s = spread(0.006);
    maxR = Math.max(maxR, Math.hypot(s.dy, s.dz));
  }
  check('spread bounded by ~2σ', maxR < 0.006 * 2.01, `max=${(maxR * 1000).toFixed(1)}mm`);
}
{
  const round = createRound();
  const hits = [
    scoreAt((R_TREBLE0 + R_TREBLE1) / 2, 0), // 60
    scoreAt(0, 0),                           // 50
    scoreAt((R_DOUBLE0 + R_DOUBLE1) / 2, 0), // 40
  ];
  for (const h of hits) round.add(h);
  check('round closes after 3 darts', round.isDone());
  check('round total = 150', round.total() === 150);
  check('4th dart rejected', round.add(scoreAt(0, 0)) === false && round.total() === 150);
  round.reset();
  check('reset reopens the round', !round.isDone() && round.total() === 0);
}

// ---------------------------------------------------------------
// 5. predictHit: honest ballistic drop at the board plane.
// ---------------------------------------------------------------
{
  // level throw straight at the board center from 2 m out
  const from = { x: 0, y: 1.744, z: 0 };
  const center = { x: -2, y: 1.744, z: 0 };
  const h = predictHit(from, { x: -1, y: 0, z: 0 }, 10, -2, center);
  const drop = -h.dy;
  check('level throw drops under the aim point',
    Math.abs(drop - 0.5 * 9.81 * 0.2 * 0.2) < 1e-9 && Math.abs(h.dz) < 1e-12,
    `drop=${(drop * 1000).toFixed(1)}mm`);
}
{
  // faster = flatter; slower = deeper drop
  const from = { x: 0, y: 1.744, z: 0 };
  const center = { x: -2, y: 1.744, z: 0 };
  const fast = predictHit(from, { x: -1, y: 0, z: 0 }, 20, -2, center);
  const slow = predictHit(from, { x: -1, y: 0, z: 0 }, 6, -2, center);
  check('more power = shallower drop', -fast.dy < -slow.dy,
    `fast ${(-fast.dy * 1000).toFixed(0)}mm vs slow ${(-slow.dy * 1000).toFixed(0)}mm`);
  // angled upward at the sweet spot lands near the aim height
  const up = predictHit(from, { x: -1, y: 0.12, z: 0 }, 10, -2, center);
  check('upward arc can land above the level line', up.dy > -0.05);
  check('aiming away from the board returns null',
    predictHit(from, { x: 1, y: 0, z: 0 }, 10, -2, center) === null);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
