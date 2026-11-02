// darts.js — pure darts logic: board scoring geometry, ballistic launch solver,
// 3-dart round state. No DOM, no three.js — runs in browser and Node.

// Standard board: 20 on top, clockwise as the player sees it. The player
// looks toward -x, so screen-right is -z; angles below are measured in the
// board plane from +y (top) toward -z (player's right).
export const SECTORS = [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5];

// Ring radii (m), scaled ×1.375 from regulation to match the diorama cabinet's
// oversized baked dartboard (rim outer ≈ 0.31 m) — visual = physical.
export const R_BULL_IN = 0.0165;  // inner bull  = 50
export const R_BULL_OUT = 0.044;  // outer bull  = 25
export const R_TREBLE0 = 0.136;   // treble ring inner edge
export const R_TREBLE1 = 0.147;   // treble ring outer edge
export const R_DOUBLE0 = 0.223;   // double ring inner edge
export const R_DOUBLE1 = 0.234;   // double ring outer edge (= scoring radius)
export const R_BOARD = 0.31;      // baked rim outer radius

export const SECTOR_DEG = 360 / 20;

/**
 * Score a hit at board-plane offset (dy up, dz lateral, relative to board
 * center). Returns { score, mult, sector, ring } with ring one of
 * 'inner-bull' | 'outer-bull' | 'treble' | 'double' | 'single' | 'miss'.
 */
export function scoreAt(dy, dz) {
  const r = Math.hypot(dy, dz);
  if (r <= R_BULL_IN) return { score: 50, mult: 0, sector: 25, ring: 'inner-bull' };
  if (r <= R_BULL_OUT) return { score: 25, mult: 0, sector: 25, ring: 'outer-bull' };
  if (r > R_DOUBLE1) return { score: 0, mult: 0, sector: 0, ring: 'miss' };

  // angle from the top (+y), positive toward the player's right (-z)
  let deg = Math.atan2(-dz, dy) * 180 / Math.PI;
  if (deg < 0) deg += 360;
  const sector = SECTORS[Math.round(deg / SECTOR_DEG) % 20];

  if (r >= R_DOUBLE0) return { score: sector * 2, mult: 2, sector, ring: 'double' };
  if (r >= R_TREBLE0 && r <= R_TREBLE1) return { score: sector * 3, mult: 3, sector, ring: 'treble' };
  return { score: sector, mult: 1, sector, ring: 'single' };
}

/**
 * Ballistic launch: initial velocity that carries a projectile from `from`
 * straight through `to` at the given speed (low-arc solution), so the
 * crosshair is honest and skill lives in the sway, not in drop guessing.
 * Falls back to a direct aim direction when the speed can't reach `to`.
 * from/to: {x,y,z}; returns {x,y,z} velocity.
 */
export function solveLaunch(from, to, speed, g = 9.81) {
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
  const dh = Math.hypot(dx, dz); // horizontal distance
  const s2 = speed * speed;
  const disc = s2 * s2 - g * (g * dh * dh + 2 * dy * s2);
  if (disc <= 0 || dh < 1e-6) {
    const L = Math.hypot(dx, dy, dz) || 1;
    return { x: dx / L * speed, y: dy / L * speed, z: dz / L * speed };
  }
  const tanA = (s2 - Math.sqrt(disc)) / (g * dh); // low arc
  const vh = speed / Math.sqrt(1 + tanA * tanA);
  const vy = vh * tanA;
  return { x: dx / dh * vh, y: vy, z: dz / dh * vh };
}

/**
 * Predict where an honest (uncompensated) ballistic throw crosses the board
 * plane x = planeX. dir need not be normalized. Returns { dy, dz, t } relative
 * to `center`, or null when the dart never travels toward the plane.
 */
export function predictHit(from, dir, speed, planeX, center, g = 9.81) {
  const L = Math.hypot(dir.x, dir.y, dir.z) || 1;
  const vx = dir.x / L * speed, vy = dir.y / L * speed, vz = dir.z / L * speed;
  if (vx >= -1e-9) return null;
  const t = (planeX - from.x) / vx;
  if (t < 0) return null;
  return {
    dy: from.y + vy * t - 0.5 * g * t * t - center.y,
    dz: from.z + vz * t - center.z,
    t,
  };
}

/** Gaussian-ish spread (sum of two uniforms ≈ normal) applied at the board. */
export function spread(sigma, rng = Math.random) {
  const g = () => (rng() + rng() + rng() - 1.5) / 1.5; // ~[-1,1], bell-ish
  return { dy: g() * sigma, dz: g() * sigma };
}

/** One 3-dart round. */
export function createRound() {
  const darts = [];
  return {
    darts,
    add(hit) {
      if (darts.length >= 3) return false;
      darts.push(hit);
      return true;
    },
    isDone: () => darts.length >= 3,
    total: () => darts.reduce((s, h) => s + h.score, 0),
    reset: () => { darts.length = 0; },
  };
}
