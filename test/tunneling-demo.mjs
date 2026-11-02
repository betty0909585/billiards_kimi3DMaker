// tunneling-demo.mjs — failure→repair evidence generator (contract section 4/13).
// Measures the REAL difference between a naive Rapier setup (240 Hz, 4 solver
// iterations, default contact tolerance, no CCD) and the tuned configuration
// the game ships with (480 Hz, 12 iterations, 0.3 mm tolerance, CCD).
// Writes results to evidence/physics-ab-<timestamp>.json.

import { writeFileSync, mkdirSync } from 'node:fs';
import {
  initRapier, createSim, BALL_R, DT,
} from '../src/sim.js';

await initRapier();

const NAIVE = { ccd: false, dt: 1 / 240, solverIters: 4, allowedLinearError: 0.001 };
const TUNED = {}; // all defaults

function maxOverlapDuringBreak(opts, speed) {
  const sim = createSim(opts);
  sim.strike({ x: 1, z: 0 }, speed, 0, 0);
  let maxOverlap = 0;
  const t0 = sim.time();
  while (sim.time() - t0 < 12 && !sim.isSettled()) {
    sim.step();
    const st = sim.balls;
    for (let i = 0; i < st.length; i++) {
      if (!st[i].active) continue;
      const pi = st[i].body.translation();
      for (let j = i + 1; j < st.length; j++) {
        if (!st[j].active) continue;
        const pj = st[j].body.translation();
        maxOverlap = Math.max(maxOverlap, 2 * BALL_R - Math.hypot(pi.x - pj.x, pi.z - pj.z));
      }
    }
  }
  return {
    maxOverlapMm: +(maxOverlap * 1000).toFixed(2),
    escaped: sim.pottedLog.filter((p) => p.escaped).length,
    settleS: +(sim.time() - t0).toFixed(2),
  };
}

function pointBlankMinDistance(opts, speed) {
  // Stress case: cue 30 cm behind an object ball, fired well past game max speed.
  const sim = createSim({ ...opts, rack: false });
  sim.placeBall(0, -0.4, 0);
  sim.spawn(1, -0.1, 0);
  sim.strike({ x: 1, z: 0 }, speed, 0, 0);
  let minDist = Infinity;
  for (let i = 0; i < Math.round((1 / (opts.dt ?? DT)) * 2); i++) {
    sim.step();
    const a = sim.ball(0).body.translation();
    const b = sim.ball(1).body.translation();
    minDist = Math.min(minDist, Math.hypot(a.x - b.x, a.z - b.z));
  }
  return {
    minCenterDistMm: +(minDist * 1000).toFixed(2),
    penetrationMm: +((2 * BALL_R - minDist) * 1000).toFixed(2),
    escaped: sim.pottedLog.filter((p) => p.escaped).length,
  };
}

const report = {
  date: new Date().toISOString(),
  configs: {
    naive: '240 Hz, 4 solver iters, 1.0 mm contact tolerance, CCD off',
    tuned: '480 Hz, 12 solver iters, 0.3 mm contact tolerance, CCD on',
  },
  breakAt65ms: { naive: maxOverlapDuringBreak(NAIVE, 6.5), tuned: maxOverlapDuringBreak(TUNED, 6.5) },
  pointBlankAt9ms: { naive: pointBlankMinDistance(NAIVE, 9), tuned: pointBlankMinDistance(TUNED, 9) },
};

console.log(JSON.stringify(report, null, 2));
mkdirSync(new URL('../evidence', import.meta.url), { recursive: true });
const file = new URL(`../evidence/physics-ab-${report.date.replace(/[:.]/g, '-')}.json`, import.meta.url);
writeFileSync(file, JSON.stringify(report, null, 2));
console.log(`\nevidence written: ${file.pathname}`);
