// physics.test.mjs — acceptance assertions from the case contract, section 13.
// Runs the SAME sim module the game uses. Exit code 0 = all gates green.

import {
  initRapier, createSim, RAPIER, BALL_R, TABLE_HX, TABLE_HZ, DT,
} from '../src/sim.js';

await initRapier();
const HZ = Math.round(1 / DT);

let passed = 0, failed = 0;
function check(name, cond, detail) {
  const tag = cond ? 'PASS' : 'FAIL';
  if (cond) passed++; else failed++;
  console.log(`[${tag}] ${name}${detail ? ' — ' + detail : ''}`);
}
const deg = (r) => (r * 180) / Math.PI;

function speedOf(sim, id) {
  const v = sim.ball(id).body.linvel();
  return Math.hypot(v.x, v.z);
}
function posOf(sim, id) {
  const p = sim.ball(id).body.translation();
  return { x: p.x, z: p.z };
}

// ---------------------------------------------------------------
// 1. Stun shot: sliding cue ball, head-on hit.
//    Cue must stop within 5 cm of the contact point,
//    object ball must take >= 85% of the cue's pre-impact speed.
// ---------------------------------------------------------------
{
  const sim = createSim({ rack: false });
  sim.placeBall(0, -0.35, 0);
  sim.spawn(1, -0.1, 0); // 25 cm ahead, so the cue arrives still sliding
  sim.strike({ x: 1, z: 0 }, 2.0, 0, 0);

  let preV = 0, postObj = 0, contactPos = null, prevCueV = 0;
  for (let i = 0; i < HZ * 4; i++) {
    sim.step();
    if (!contactPos && speedOf(sim, 1) > 0.05) {
      contactPos = posOf(sim, 0);
      preV = prevCueV;
      postObj = speedOf(sim, 1);
    }
    prevCueV = speedOf(sim, 0);
    if (contactPos && sim.isSettled()) break;
  }
  for (let i = 0; i < 10; i++) postObj = Math.max(postObj, speedOf(sim, 1));
  const stopDist = Math.hypot(posOf(sim, 0).x - contactPos.x, posOf(sim, 0).z - contactPos.z);
  check('stun: cue stops within 5cm of contact', stopDist <= 0.05, `stop distance ${(stopDist * 100).toFixed(1)}cm`);
  check('stun: object ball takes >=85% speed', postObj >= 0.85 * preV, `${((postObj / preV) * 100).toFixed(1)}% transfer (${postObj.toFixed(2)}/${preV.toFixed(2)} m/s)`);
}

// ---------------------------------------------------------------
// 2. Follow shot: topspin cue keeps moving forward after contact.
//    Measured as PEAK forward travel (the cue may later re-hit the stopped
//    object ball — real physics, not a failed follow).
// ---------------------------------------------------------------
{
  const sim = createSim({ rack: false });
  sim.placeBall(0, -0.35, 0);
  sim.spawn(1, -0.1, 0);
  sim.strike({ x: 1, z: 0 }, 2.5, 0, 0.7);

  let contactPos = null, peakX = -Infinity;
  for (let i = 0; i < HZ * 5; i++) {
    sim.step();
    if (!contactPos && speedOf(sim, 1) > 0.05) contactPos = posOf(sim, 0);
    if (contactPos) {
      peakX = Math.max(peakX, posOf(sim, 0).x);
      if (sim.isSettled()) break;
    }
  }
  const follow = peakX - contactPos.x;
  check('follow: topspin cue follows forward >15cm', follow > 0.15, `peak follow distance ${(follow * 100).toFixed(1)}cm`);
}

// ---------------------------------------------------------------
// 3. Draw shot: backspin cue comes back after contact.
// ---------------------------------------------------------------
{
  const sim = createSim({ rack: false });
  sim.placeBall(0, -0.6, 0);
  sim.spawn(1, -0.1, 0); // long approach: backspin survives the slide
  sim.strike({ x: 1, z: 0 }, 3.3, 0, -0.95);

  let contactPos = null;
  for (let i = 0; i < HZ * 6; i++) {
    sim.step();
    if (!contactPos && speedOf(sim, 1) > 0.05) contactPos = posOf(sim, 0);
    if (contactPos && sim.isSettled()) break;
  }
  const draw = contactPos.x - posOf(sim, 0).x;
  check('draw: backspin cue draws back >10cm', draw > 0.1, `draw distance ${(draw * 100).toFixed(1)}cm`);
}

// ---------------------------------------------------------------
// 4. Side spin (english): cushion rebound direction differs from
//    a no-spin control shot by >= 15 degrees.
// ---------------------------------------------------------------
{
  function reboundAngle(ox) {
    const sim = createSim({ rack: false });
    sim.placeBall(0, -0.6, 0);
    sim.strike({ x: 1, z: 0.18 }, 3.0, ox, 0);
    let hitStep = -1, outV = null;
    for (let i = 0; i < HZ * 3; i++) {
      const before = sim.ball(0).body.linvel();
      sim.step();
      const after = sim.ball(0).body.linvel();
      if (hitStep < 0 && after.x < 0 && before.x > 0) hitStep = i;
      if (hitStep >= 0 && i === hitStep + Math.round(HZ / 30)) {
        outV = { x: after.x, z: after.z };
        break;
      }
    }
    return Math.atan2(outV.z, -outV.x); // angle from the reflected x axis
  }
  const a0 = reboundAngle(0);
  const a1 = reboundAngle(0.85);
  const diff = Math.abs(deg(a1 - a0));
  check('english: side spin changes cushion rebound >=15deg', diff >= 15, `no-spin ${deg(a0).toFixed(1)}deg vs spin ${deg(a1).toFixed(1)}deg (diff ${diff.toFixed(1)}deg)`);
}

// ---------------------------------------------------------------
// 5. Break: fixed input, no overlap, no escape, settled < 10s,
//    no post-settle jitter.
// ---------------------------------------------------------------
{
  const sim = createSim({ ccd: true }); // full rack
  sim.strike({ x: 1, z: 0 }, 6.5, 0, 0);

  let maxOverlap = 0, escaped = 0;
  const settleT = (() => {
    const t0 = sim.time();
    while (sim.time() - t0 < 12) {
      sim.step();
      const st = sim.balls;
      for (let i = 0; i < st.length; i++) {
        if (!st[i].active) continue;
        const pi = st[i].body.translation();
        if (Number.isNaN(pi.x + pi.y + pi.z)) throw new Error('NaN position');
        for (let j = i + 1; j < st.length; j++) {
          if (!st[j].active) continue;
          const pj = st[j].body.translation();
          // skip balls falling into the pocket cup (physical drop, not overlap)
          if (pi.y < -0.02 || pj.y < -0.02) continue;
          const d = Math.hypot(pi.x - pj.x, pi.z - pj.z);
          maxOverlap = Math.max(maxOverlap, 2 * BALL_R - d);
        }
      }
      if (sim.isSettled()) return sim.time() - t0;
    }
    return -1;
  })();
  escaped = sim.pottedLog.filter((p) => p.escaped).length;

  check('break: settles within 10s', settleT >= 0 && settleT <= 10, `settled in ${settleT.toFixed(2)}s, potted ${sim.pottedLog.length}`);
  check('break: no tunneled/escaped balls', escaped === 0, `${escaped} escaped`);
  check('break: no visible overlap (<=0.5mm)', maxOverlap <= 0.0005, `max overlap ${(maxOverlap * 1000).toFixed(2)}mm`);

  // post-settle jitter: 1 extra second, nothing may move more than 1mm
  const before = sim.balls.filter((b) => b.active).map((b) => ({ id: b.id, ...posOf(sim, b.id) }));
  sim.stepN(HZ);
  let jitter = 0;
  for (const b of before) {
    const p = posOf(sim, b.id);
    jitter = Math.max(jitter, Math.hypot(p.x - b.x, p.z - b.z));
  }
  check('break: no post-settle jitter (<1mm in 1s)', jitter < 0.001, `max jitter ${(jitter * 1000).toFixed(3)}mm`);
}

// ---------------------------------------------------------------
// 6. Cushion reflection: medium speed, no spin, angle error <= 5deg.
// ---------------------------------------------------------------
{
  const sim = createSim({ rack: false });
  sim.placeBall(0, -0.5, 0);
  const dir = { x: 1, z: 0.25 };
  sim.strike(dir, 2.2, 0, 0);

  let inV = null, outV = null;
  for (let i = 0; i < HZ * 3; i++) {
    const before = { ...sim.ball(0).body.linvel() };
    sim.step();
    const after = sim.ball(0).body.linvel();
    if (!inV && after.x < 0) {
      inV = before;
    }
    if (inV && !outV) {
      // let cushion friction finish acting, then sample
      outV = null;
      for (let k = 0; k < Math.round(HZ / 30); k++) sim.step();
      const a = sim.ball(0).body.linvel();
      outV = { x: a.x, z: a.z };
      break;
    }
  }
  const angIn = Math.atan2(Math.abs(inV.z), Math.abs(inV.x));
  const angOut = Math.atan2(Math.abs(outV.z), Math.abs(outV.x));
  const err = Math.abs(deg(angOut - angIn));
  check('cushion: reflection angle error <=5deg', err <= 5, `in ${deg(angIn).toFixed(1)}deg out ${deg(angOut).toFixed(1)}deg (err ${err.toFixed(1)}deg)`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
