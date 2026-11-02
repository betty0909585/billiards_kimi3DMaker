// sim.js — shared billiards physics core (runs in browser and Node, no DOM).
// Single source of truth: the Rapier world state. Rendering only reads it.

import RAPIER from '@dimforge/rapier3d-compat';

export { RAPIER };

export const BALL_R = 0.028575;        // 57.2 mm regulation ball
export const TABLE_HX = 1.21;          // play half-length, fitted to model wall (2.42 m)
export const TABLE_HZ = 0.65;          // play half-width, fitted to model wall (1.30 m)
export const POCKET_CORNER_R = 0.078;
export const POCKET_SIDE_R = 0.072;
export const MAX_V = 10;                // m/s at full power (reference project: 9.0)
export const DT = 1 / 480;             // fixed physics step (sub-cm motion at break speed)

const BALL_DENSITY = 1700;             // phenolic resin ~ 170 g per ball
const REST_BALL = 0.96;                // ball-ball restitution (reference: 0.95)
const REST_CUSHION = 0.85;             // cushion restitution (reference: 0.85)
// Friction combine = average of both colliders, so ball-ball gets its own low
// value via the ball collider (0.06 ≈ reference throw) while ball-cushion
// lands where english can grab the rail:
//   ball-ball:    0.06            (spin survives contact — follow/draw stay alive)
//   ball-cushion: (0.06+0.55)/2 ≈ 0.31 (english grabs the rail)
//   ball-cloth:   0 — engine friction OFF; slide/roll is integrated analytically
//                     per step (two-phase model, see step()) for textbook feel
const FRIC_CLOTH = 0;
const FRIC_BALL = 0.06;
const FRIC_CUSHION = 0.66;
const CUSHION_H = 0.045;
const CUSHION_T = 0.06;
const GAP_CORNER = 0.088;              // cushion gap at corner pockets
const GAP_SIDE = 0.078;                // cushion gap at side pockets
const LIN_DAMP = 0.05;
const ANG_DAMP = 0.1;
const ROLL_DECEL = 0.18;                // rolling resistance, m/s^2 — real cloth is ~0.1;
                                       // 0.3 keeps the glide but bounds the wait
const CRAWL_V = 0.25;                  // below this, extra decel ramps in (kills the tail)
const CRAWL_DECEL = 0.5;
const CRAWL_SPIN_DAMP = 3.0;           // extra exponential angular damping below CRAWL_V
const SPIN_DECAY_Y = 10.0;             // explicit vertical-spin (english) decay, rad/s^2
const SLIP_ROLL = 0.05;                // slip speed below which a ball counts as rolling
const STOP_V = 0.025;                  // below this we hard-stop the ball (visually still)
const STOP_W = 0.3;
const MAX_TIP = 0.5;                   // max cue-tip offset, fraction of R
const SPIN_K = 2.5 * MAX_TIP;          // omega = SPIN_K * offset * v / R  (solid sphere)
const ESCAPE_LIMIT = 0.35;             // ball further than this past the rail = tunneled out

const HEAD_X = -TABLE_HX / 2;          // head string
const FOOT_X = TABLE_HX / 2;           // foot spot

let ready = null;
export function initRapier() {
  if (!ready) ready = RAPIER.init();
  return ready;
}

export const CUSHION_HEIGHT = CUSHION_H;
export const CUSHION_THICK = CUSHION_T;

/** The 6 physical cushion segments (shared by physics colliders and rendering). */
export function cushionSegments() {
  const railZ = TABLE_HZ + CUSHION_T / 2;
  const railX = TABLE_HX + CUSHION_T / 2;
  const segs = [];
  for (const sz of [-1, 1]) {
    const segLen = TABLE_HX - GAP_CORNER - GAP_SIDE;
    const segCx = (GAP_SIDE + TABLE_HX - GAP_CORNER) / 2;
    segs.push({ cx: -segCx, cz: sz * railZ, hx: segLen / 2, hz: CUSHION_T / 2 });
    segs.push({ cx: segCx, cz: sz * railZ, hx: segLen / 2, hz: CUSHION_T / 2 });
  }
  for (const sx of [-1, 1]) {
    const segLen = TABLE_HZ - GAP_CORNER;
    segs.push({ cx: sx * railX, cz: 0, hx: CUSHION_T / 2, hz: segLen });
  }
  return segs;
}

/** Cloth slab segments leaving square holes at the pockets (physics + render). */
export function slabSegments() {
  // Hole half-sides match capture radii (hole circumscribed circle = capture
  // radius), so a captured ball always drops while a passer-by only lips.
  // Holes are cut at the model's pocket positions (pocketLayout).
  const CORNER_HS = 0.055;
  const SIDE_HS = 0.051;
  const SLAB_X = TABLE_HX + 0.6, SLAB_Z = TABLE_HZ + 0.6;
  const ZC = 0.55;
  const segs = [{ cx: 0, cz: 0, hx: SLAB_X, hz: ZC }];
  const xSegs = [
    [-SLAB_X, -(POCKET_CORNER_X + CORNER_HS)],
    [-(POCKET_CORNER_X - CORNER_HS), -SIDE_HS],
    [SIDE_HS, POCKET_CORNER_X - CORNER_HS],
    [POCKET_CORNER_X + CORNER_HS, SLAB_X],
  ];
  for (const zc of [-(SLAB_Z + ZC) / 2, (SLAB_Z + ZC) / 2]) {
    const hz = (SLAB_Z - ZC) / 2;
    for (const [x0, x1] of xSegs)
      segs.push({ cx: (x0 + x1) / 2, cz: zc, hx: (x1 - x0) / 2, hz });
  }
  return segs;
}

/** The 6 pocket mouths (shared by capture logic and rendering).
 *  Positions are fitted to the traditional table model: corner mouths are
 *  inset from the rail lines, side mouths sit on the rail line. */
export const POCKET_CORNER_X = 1.222;
export const POCKET_CORNER_Z = 0.604;
export const POCKET_SIDE_Z = 0.635;
export function pocketLayout() {
  const out = [];
  for (const sx of [-1, 1])
    for (const sz of [-1, 1])
      out.push({ x: sx * POCKET_CORNER_X, z: sz * POCKET_CORNER_Z, r: POCKET_CORNER_R, kind: 'corner' });
  for (const sz of [-1, 1])
    out.push({ x: 0, z: sz * POCKET_SIDE_Z, r: POCKET_SIDE_R, kind: 'side' });
  return out;
}

function rackLayout(gapMm = 0.4) {
  // Standard triangle pointing -x, apex on the foot spot. Deterministic numbering:
  // 1 at apex, 8 in the middle of the third row.
  const rows = [[1], [9, 2], [10, 8, 3], [11, 4, 14, 5], [6, 12, 7, 15, 13]];
  const gap = 2 * BALL_R + gapMm / 1000;
  const dx = gap * Math.cos(Math.PI / 6); // row spacing along +x
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = 0; j < rows[i].length; j++) {
      out.push({
        id: rows[i][j],
        x: FOOT_X + i * dx,
        z: (j - i / 2) * gap,
      });
    }
  }
  return out;
}

export function createSim({
  ccd = true,
  rackGap = 3.0,
  restBall = REST_BALL,
  rack = true,
  dt = DT,
  solverIters = 16,
  allowedLinearError = 0.0003,
  clothModel = true,
} = {}) {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = dt;
  if ('numSolverIterations' in world) world.numSolverIterations = solverIters;
  try {
    world.integrationParameters.allowedLinearError = allowedLinearError;
  } catch (_) { /* older API — tolerance stays at default */ }

  const colliderInfo = new Map(); // collider.handle -> {kind, id}

  // --- playing surface (cloth): segments leave square holes at pockets.
  // Layout is shared with the renderer (slabSegments) so visual = physical.
  // --- playing surface (cloth): ONE solid cuboid. Segmented/trimesh floors
  // have seam edges that launch balls at speed (proven by probes), so the
  // surface stays continuous and pocket drops are handled by teleporting the
  // captured ball into the well below the floor.
  const cloth = world.createCollider(
    RAPIER.ColliderDesc.cuboid(TABLE_HX + 0.6, 0.05, TABLE_HZ + 0.6)
      .setTranslation(0, -0.05, 0)
      .setFriction(FRIC_CLOTH)
      .setRestitution(0.1)
  );
  colliderInfo.set(cloth.handle, { kind: 'cloth', id: -1 });

  // --- pockets: physical cups (funnel plates + bottom plate) ---
  const pockets = pocketLayout();
  for (const pk of pockets) {
    // square well: 4 vertical walls + bottom plate (no tilt to get wrong)
    const W = 0.034, DEPTH = -0.105;
    for (const [dx, dz, hx, hz] of [
      [W, 0, 0.004, W + 0.004], [-W, 0, 0.004, W + 0.004],
      [0, W, W + 0.004, 0.004], [0, -W, W + 0.004, 0.004],
    ]) {
      const c = world.createCollider(
        RAPIER.ColliderDesc.cuboid(hx, -DEPTH / 2, hz)
          .setTranslation(pk.x + dx, DEPTH / 2, pk.z + dz)
          .setFriction(0.25)
          .setRestitution(0.3)
      );
      colliderInfo.set(c.handle, { kind: 'cup', id: -1 });
    }
    const cb = world.createCollider(
      RAPIER.ColliderDesc.cuboid(W + 0.01, 0.012, W + 0.01)
        .setTranslation(pk.x, DEPTH - 0.012, pk.z)
        .setFriction(0.4)
        .setRestitution(0.25)
    );
    colliderInfo.set(cb.handle, { kind: 'cup', id: -1 });
  }

  // --- cushions: 4 corner gaps + 2 side gaps, 6 segments ---
  const cushionY = CUSHION_H / 2;
  function addCushion(cx, cz, hx, hz) {
    const c = world.createCollider(
      RAPIER.ColliderDesc.cuboid(hx, cushionY, hz)
        .setTranslation(cx, cushionY, cz)
        .setFriction(FRIC_CUSHION)
        .setRestitution(REST_CUSHION)
    );
    colliderInfo.set(c.handle, { kind: 'cushion', id: -1 });
  }
  for (const s of cushionSegments()) addCushion(s.cx, s.cz, s.hx, s.hz);
  // safety net far behind the rails: catches (and flags) anything that tunnels out
  for (const [cx, cz, hx, hz] of [
    [0, TABLE_HZ + ESCAPE_LIMIT, TABLE_HX + 1, 0.05],
    [0, -TABLE_HZ - ESCAPE_LIMIT, TABLE_HX + 1, 0.05],
    [TABLE_HX + ESCAPE_LIMIT, 0, 0.05, TABLE_HZ + 1],
    [-TABLE_HX - ESCAPE_LIMIT, 0, 0.05, TABLE_HZ + 1],
  ]) {
    const c = world.createCollider(
      RAPIER.ColliderDesc.cuboid(hx, 0.3, hz).setTranslation(cx, 0.3, cz)
    );
    colliderInfo.set(c.handle, { kind: 'net', id: -1 });
  }

  // --- balls ---
  const balls = [];
  function addBall(id, x, z) {
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(x, BALL_R, z)
        .setLinearDamping(LIN_DAMP)
        .setAngularDamping(ANG_DAMP)
        .setCanSleep(false)
        .setCcdEnabled(ccd)
    );
    const col = world.createCollider(
      RAPIER.ColliderDesc.ball(BALL_R)
        .setDensity(BALL_DENSITY)
        .setFriction(FRIC_BALL)
        .setRestitution(restBall)
        .setContactForceEventThreshold(1e-4)
        // threshold alone does NOT enable contact force events in rapier 0.20 —
        // without this flag no hit/cushion/roll event is ever emitted
        .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS),
      body
    );
    colliderInfo.set(col.handle, { kind: 'ball', id });
    balls.push({ id, body, col, active: true, potted: false, falling: false, rested: false, pocketIdx: -1 });
  }
  addBall(0, HEAD_X, 0); // cue ball
  if (rack) for (const b of rackLayout(rackGap)) addBall(b.id, b.x, b.z);

  // --- events ---
  const eventQueue = new RAPIER.EventQueue(true);
  let events = [];   // {type, impulse, a, b} since last drain
  const pottedLog = []; // {id, pocket, t, escaped}
  let simTime = 0;

  // --- API ---
  const sim = {
    world,
    balls,
    pockets,
    ccd,
    time: () => simTime,
    pottedLog,

    ball(id) {
      return balls.find((b) => b.id === id);
    },

    /** Manually add an extra ball (used by tests / practice setups). */
    spawn(id, x, z) {
      if (sim.ball(id)) throw new Error(`ball ${id} exists`);
      addBall(id, x, z);
      return sim.ball(id);
    },

    /** Strike the cue ball. dir = unit (x,z); speed in m/s;
     *  ox = side spin offset (-1..1), oy = top/back spin offset (-1..1). */
    strike(dir, speed, ox = 0, oy = 0) {
      const cue = sim.ball(0);
      if (!cue.active) return false;
      const m = Math.hypot(ox, oy);
      if (m > 1) { ox /= m; oy /= m; }
      const L = Math.hypot(dir.x, dir.z) || 1;
      const dx = dir.x / L, dz = dir.z / L;
      cue.body.setLinvel({ x: dx * speed, y: 0, z: dz * speed }, true);
      const k = (SPIN_K * speed) / BALL_R;
      cue.body.setAngvel(
        { x: dz * oy * k, y: ox * k, z: -dx * oy * k },
        true
      );
      settled = false;
      return true;
    },

    /** Teleport a ball back onto the table (e.g. cue ball after a scratch). */
    placeBall(id, x, z) {
      const b = sim.ball(id);
      b.active = true;
      b.potted = false;
      b.falling = false;
      b.rested = false;
      b.pocketIdx = -1;
      b.body.setEnabled(true);
      b.body.setTranslation({ x, y: BALL_R, z }, true);
      b.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      b.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    },

    step() {
      world.step(eventQueue);
      simTime += dt;

      eventQueue.drainContactForceEvents((e) => {
        const ia = colliderInfo.get(e.collider1());
        const ib = colliderInfo.get(e.collider2());
        if (!ia || !ib) return;
        const imp = e.totalForceMagnitude();
        if (imp < 0.02) return;
        const kinds = [ia.kind, ib.kind].sort().join('-');
        events.push({
          type: kinds === 'ball-ball' ? 'hit' : kinds.includes('cushion') ? 'cushion' : 'roll',
          impulse: imp,
          a: ia.id,
          b: ib.id,
          t: simTime,
        });
      });
      eventQueue.drainCollisionEvents(() => {});

      for (const b of balls) {
        if (!b.active) continue;
        const p = b.body.translation();

        // pocket capture (xz distance to a pocket mouth) → physical drop
        if (!b.potted) {
          for (let i = 0; i < pockets.length; i++) {
            const pk = pockets[i];
            const d = Math.hypot(p.x - pk.x, p.z - pk.z);
            if (d < pk.r) {
              b.potted = true;
              b.falling = true;
              b.pocketIdx = i;
              pottedLog.push({ id: b.id, pocket: i, t: simTime, escaped: false });
              break;
            }
          }
        }
        if (b.falling) {
          // glide to the cup center, then gravity takes over; landing in the
          // cup bottom is what fires the pocket sound/badge, not the capture
          const pk = pockets[b.pocketIdx];
          const v = b.body.linvel();
          const dx = pk.x - p.x, dz = pk.z - p.z;
          const d = Math.hypot(dx, dz);
          if (d > 0.012 && p.y > -0.01) {
            const s = Math.min(0.9, 3.0 * d);
            b.body.setLinvel({ x: (dx / d) * s, y: Math.min(v.y, 0), z: (dz / d) * s }, true);
          } else if (p.y > -0.01) {
            // centered over the mouth: pass through into the well below the floor
            b.body.setTranslation({ x: pk.x, y: -0.055, z: pk.z }, true);
            b.body.setLinvel({ x: v.x * 0.1, y: 0, z: v.z * 0.1 }, true);
          } else {
            b.body.setLinvel({ x: v.x * 0.15, y: v.y, z: v.z * 0.15 }, true);
          }
          if (p.y < -0.06) { // inside the cup well — that's a landing
            b.falling = false;
            b.rested = true;
            b.active = false;
            b.body.setEnabled(false);
            b.body.setTranslation({ x: pk.x, y: -0.076, z: pk.z }, false);
            b.body.setLinvel({ x: 0, y: 0, z: 0 }, false);
            b.body.setAngvel({ x: 0, y: 0, z: 0 }, false);
            events.push({ type: 'pocket', id: b.id, pocket: b.pocketIdx, t: simTime });
          }
          continue;
        }

        // tunneled out of the table entirely (should never happen with ccd on)
        if (
          Math.abs(p.x) > TABLE_HX + ESCAPE_LIMIT - 0.06 ||
          Math.abs(p.z) > TABLE_HZ + ESCAPE_LIMIT - 0.06
        ) {
          b.active = false;
          b.potted = true;
          b.body.setEnabled(false);
          pottedLog.push({ id: b.id, pocket: -1, t: simTime, escaped: true });
          events.push({ type: 'escape', id: b.id, t: simTime });
          continue;
        }

        // --- two-phase cloth friction (analytic, textbook billiard model) ---
        if (clothModel) {
        // Sliding phase: friction acts on the contact-point slip velocity u,
        // changing v and ω together until u = 0 (roll). Rolling phase: only
        // small rolling resistance remains; spin is bound to the roll.
        // The step is split at the phase transition (engine noise keeps slip
        // nonzero, so the threshold is physical: 0.1 mm/s).
        {
          const MU = 0.2, G = 9.81;
          let remain = dt;
          for (let guard = 0; guard < 3 && remain > 1e-12; guard++) {
            const v = b.body.linvel();
            const w = b.body.angvel();
            // u = v + ω × (−R ŷ)
            const ux = v.x + w.z * BALL_R;
            const uz = v.z - w.x * BALL_R;
            const us = Math.hypot(ux, uz);
            if (us > 1e-4) {
              // slide: |du/dt| = 3.5 μg; spin follows the solid-sphere relation
              const tToRoll = us / (3.5 * MU * G);
              const h = Math.min(remain, tToRoll);
              const nx = ux / us, nz = uz / us;
              const a = MU * G;
              const nvx = v.x - a * nx * h;
              const nvz = v.z - a * nz * h;
              const alpha = (5 * MU * G) / (2 * BALL_R);
              // ŷ × û = (nz, 0, −nx)
              let nwx = w.x + alpha * nz * h;
              let nwz = w.z + alpha * -nx * h;
              if (h >= tToRoll - 1e-12) {
                // snap exactly onto the rolling constraint (kills numeric residue)
                nwx = nvz / BALL_R;
                nwz = -nvx / BALL_R;
              }
              b.body.setLinvel({ x: nvx, y: v.y, z: nvz }, true);
              b.body.setAngvel({ x: nwx, y: w.y, z: nwz }, true);
              remain -= h;
            } else {
              // roll phase: rolling resistance (+ crawl assist), ω bound to roll
              const speed = Math.hypot(v.x, v.z);
              if (speed > 1e-6) {
                const assist = speed < CRAWL_V ? CRAWL_DECEL * (1 - speed / CRAWL_V) : 0;
                const dv = Math.min((ROLL_DECEL + assist) * remain, speed);
                const s = (speed - dv) / speed;
                const nvx = v.x * s, nvz = v.z * s;
                b.body.setLinvel({ x: nvx, y: v.y, z: nvz }, true);
                b.body.setAngvel({ x: nvz / BALL_R, y: w.y, z: -nvx / BALL_R }, true);
              }
              break;
            }
          }
        }

        }
        // explicit vertical-spin (english) decay — point contact gives no
        // friction torque about the vertical axis, so kill it ourselves.
        // Below CRAWL_V residual spin gets extra damping so the settle tail
        // doesn't depend on chaotic spin trajectories. Rolling spin exempt.
        {
          const v2 = b.body.linvel();
          const w2 = b.body.angvel();
          let wx = w2.x, wy = w2.y, wz = w2.z;
          if (Math.abs(wy) > 1e-6) {
            const dw = SPIN_DECAY_Y * dt;
            wy = Math.abs(wy) <= dw ? 0 : wy - Math.sign(wy) * dw;
          }
          const speed2 = Math.hypot(v2.x, v2.z);
          const slip2 = Math.hypot(v2.x + wz * BALL_R, v2.z - wx * BALL_R);
          if (speed2 < CRAWL_V && slip2 > SLIP_ROLL) {
            const k = Math.max(0, 1 - CRAWL_SPIN_DAMP * dt);
            wx *= k; wy *= k; wz *= k;
          }
          if (wx !== w2.x || wy !== w2.y || wz !== w2.z)
            b.body.setAngvel({ x: wx, y: wy, z: wz }, true);

          // hard stop below thresholds (kills residual jitter)
          const nw = Math.hypot(wx, wy, wz);
          if (speed2 < STOP_V && nw < STOP_W) {
            b.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
            b.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
          }
        }
      }

      settled = balls.every((b) => {
        if (!b.active) return true;
        if (b.falling) return false; // mid-air inside a cup, not settled yet
        const v = b.body.linvel();
        const w = b.body.angvel();
        return Math.hypot(v.x, v.z) < STOP_V && Math.hypot(w.x, w.y, w.z) < STOP_W;
      });
    },

    stepN(n) {
      for (let i = 0; i < n; i++) sim.step();
    },

    /** Run until all balls stop or timeout (seconds). Returns settle time. */
    runUntilSettled(timeout = 15) {
      const t0 = simTime;
      while (simTime - t0 < timeout) {
        sim.step();
        if (settled) return simTime - t0;
      }
      return -1; // did not settle in time
    },

    isSettled: () => settled,

    /** Snapshot for rendering. */
    state() {
      return balls.map((b) => ({
        id: b.id,
        active: b.active,
        potted: b.potted,
        falling: b.falling,
        rested: b.rested,
        pos: b.body.translation(),
        rot: b.body.rotation(),
      }));
    },

    drainEvents() {
      const e = events;
      events = [];
      return e;
    },
  };

  let settled = true;
  return sim;
}
