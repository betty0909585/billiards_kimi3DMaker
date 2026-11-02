// bargames.test.mjs — dice face reading, dice match, roulette odds,
// plus a real Rapier dice-roll integration check. Exit code 0 = all green.

import * as THREE from 'three';
import { diceTopValue, createDiceMatch, rouletteHit } from '../src/barlogic.js';
import { initRapier, RAPIER } from '../src/sim.js';

await initRapier();

let passed = 0, failed = 0;
function check(name, cond, detail) {
  const tag = cond ? 'PASS' : 'FAIL';
  if (cond) passed++; else failed++;
  console.log(`[${tag}] ${name}${detail ? ' — ' + detail : ''}`);
}

// ---------------------------------------------------------------
// 1. diceTopValue: all six face-up orientations.
// ---------------------------------------------------------------
{
  const q = new THREE.Quaternion();
  check('upright die shows 1', diceTopValue(q) === 1);
  check('180° about x shows 6',
    diceTopValue(q.clone().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI)) === 6);
  check('-90° about z shows 4',
    diceTopValue(q.clone().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -Math.PI / 2)) === 4);
  check('90° about z shows 3',
    diceTopValue(q.clone().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2)) === 3);
  check('-90° about x shows 2',
    diceTopValue(q.clone().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2)) === 2);
  check('90° about x shows 5',
    diceTopValue(q.clone().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2)) === 5);
  // a small tilt off upright still reads 1
  const tilt = q.clone().setFromEuler(new THREE.Euler(0.2, 0.3, 0.1));
  check('small tilt still reads top face', diceTopValue(tilt) === 1);
}

// ---------------------------------------------------------------
// 2. Dice match (best of 3).
// ---------------------------------------------------------------
{
  const m = createDiceMatch();
  check('round win goes to the higher total', m.play(14, 9) === 'player');
  check('draw keeps scores level', m.play(10, 10) === 'draw');
  check('second player round wins the match', m.play(12, 8) === 'player' && m.score().over && m.score().pw === 2);
  m.reset();
  check('reset reopens the match', !m.score().over && m.score().pw === 0);
  m.play(5, 12); m.play(8, 13);
  check('house can take the match', m.score().over && m.score().hw === 2);
}

// ---------------------------------------------------------------
// 3. Roulette odds boundary.
// ---------------------------------------------------------------
{
  check('rng 0 is a hit', rouletteHit(() => 0) === true);
  check('rng just under 1/6 is a hit', rouletteHit(() => 1 / 6 - 1e-9) === true);
  check('rng just over 1/6 is safe', rouletteHit(() => 1 / 6 + 1e-9) === false);
  check('rng 0.99 is safe', rouletteHit(() => 0.99) === false);
}

// ---------------------------------------------------------------
// 4. Real dice roll in the tray (Rapier): settles, values 1..6,
//    dice stay inside the tray.
// ---------------------------------------------------------------
{
  const { createDiceSim } = await import('../src/bargames-dicesim.js').catch(() => ({}));
  // the sim is built inside bargames.js; for the node test we rebuild it inline
  // with the same parameters (bargames.js itself needs the DOM for pips).
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = 1 / 240;
  const cx = 0, cy = 0.78, cz = 0, hx = 0.17, hz = 0.11;
  world.createCollider(RAPIER.ColliderDesc.cuboid(hx + 0.03, 0.02, hz + 0.03)
    .setTranslation(cx, cy - 0.02, cz).setFriction(0.55).setRestitution(0.2));
  const H = 0.05;
  for (const [dx, dz, whx, whz] of [
    [-hx, 0, 0.012, hz], [hx, 0, 0.012, hz],
    [0, -hz, hx, 0.012], [0, hz, hx, 0.012],
  ]) {
    world.createCollider(RAPIER.ColliderDesc.cuboid(whx, H, whz)
      .setTranslation(cx + dx, cy + H, cz + dz).setFriction(0.3).setRestitution(0.45));
  }
  const DIE = 0.011;
  const dice = [];
  for (let i = 0; i < 6; i++) {
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(cx, cy + 0.05 + i * 0.03, cz)
        .setLinearDamping(0.08).setAngularDamping(0.3).setCanSleep(false)
    );
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(DIE, DIE, DIE)
        .setDensity(650).setFriction(0.45).setRestitution(0.32),
      body
    );
    dice.push(body);
  }
  // roll all six with the bargames roll() parameters
  let rngState = 42;
  const rng = () => { rngState = (rngState * 1664525 + 1013904223) >>> 0; return rngState / 4294967296; };
  for (const b of dice) {
    b.setTranslation({
      x: cx + (rng() - 0.5) * hx * 1.1,
      y: cy + 0.14 + rng() * 0.05,
      z: cz + (rng() - 0.5) * hz * 1.1,
    }, true);
    b.setLinvel({ x: (rng() - 0.5) * 1.7, y: -0.5 - rng() * 0.7, z: (rng() - 0.5) * 1.3 }, true);
    b.setAngvel({ x: (rng() - 0.5) * 26, y: (rng() - 0.5) * 26, z: (rng() - 0.5) * 26 }, true);
  }
  for (let i = 0; i < 240 * 5; i++) world.step();
  const settled = dice.every((b) => {
    const v = b.linvel(), w = b.angvel();
    return Math.hypot(v.x, v.y, v.z) < 0.045 && Math.hypot(w.x, w.y, w.z) < 0.4;
  });
  check('dice settle in the tray', settled);
  const vals = dice.map((b) => diceTopValue(b.rotation()));
  check('all reads are valid faces', vals.every((v) => v >= 1 && v <= 6), vals.join(','));
  const inside = dice.every((b) => {
    const p = b.translation();
    return Math.abs(p.x - cx) < hx + 0.03 && Math.abs(p.z - cz) < hz + 0.03 && p.y > cy;
  });
  check('dice stay inside the tray walls', inside);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
