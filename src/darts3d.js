// darts3d.js — interactive dartboard + dart meshes for the Club No.9 bar wall.
// Visuals and dart flight live here; scoring math lives in darts.js (pure).

import * as THREE from 'three';
import {
  SECTORS, R_BULL_IN, R_BULL_OUT, R_TREBLE0, R_TREBLE1,
  R_DOUBLE0, R_DOUBLE1, scoreAt,
} from './darts.js';

// Board placement: fitted to the BAKED dartboard inside the diorama's cabinet
// (Object_7 rim ring measured from the GLB verts: center (1.731, -2.261),
// rim outer ≈ 0.325, rim front x ≈ -3.159). Our face sits 2.5 cm proud of the
// baked rim, our body shell (r 0.334) clears it radially — no z-fighting.
export const BOARD_C = new THREE.Vector3(-3.155, 1.731, -2.261);

// Face radius covers the baked rim's outer lip (≈ 0.325).
const FACE_R = 0.33;

const CREAM = '#e6d9bd', BLACK = '#191512', RED = '#b5341f', GREEN = '#1d6b3a';

function boardTexture() {
  const N = 1024, C = N / 2;
  const k = N / (2 * FACE_R); // px per meter
  const c = document.createElement('canvas');
  c.width = c.height = N;
  const x = c.getContext('2d');

  // black surround (number ring area)
  x.fillStyle = '#0d0b09';
  x.fillRect(0, 0, N, N);

  const rad = (deg) => deg * Math.PI / 180;
  // sector i: deg from top (canvas -y), clockwise toward canvas right (+x = -z)
  const wedge = (i, r0, r1, color) => {
    const a0 = rad(i * 18 - 9 - 90), a1 = rad(i * 18 + 9 - 90);
    x.beginPath();
    x.arc(C, C, r1 * k, a0, a1);
    x.arc(C, C, r0 * k, a1, a0, true);
    x.closePath();
    x.fillStyle = color;
    x.fill();
  };

  for (let i = 0; i < 20; i++) {
    const single = i % 2 === 0 ? BLACK : CREAM;
    const ring = i % 2 === 0 ? RED : GREEN;
    wedge(i, R_BULL_OUT, R_DOUBLE1, single);
    wedge(i, R_TREBLE0, R_TREBLE1, ring);
    wedge(i, R_DOUBLE0, R_DOUBLE1, ring);
  }

  // wire: ring circles + radial dividers
  x.strokeStyle = 'rgba(210,205,195,0.5)';
  x.lineWidth = 2;
  for (const r of [R_BULL_OUT, R_TREBLE0, R_TREBLE1, R_DOUBLE0, R_DOUBLE1]) {
    x.beginPath(); x.arc(C, C, r * k, 0, Math.PI * 2); x.stroke();
  }
  for (let i = 0; i < 20; i++) {
    const a = rad(i * 18 - 9 - 90);
    x.beginPath();
    x.moveTo(C + Math.cos(a) * R_BULL_OUT * k, C + Math.sin(a) * R_BULL_OUT * k);
    x.lineTo(C + Math.cos(a) * R_DOUBLE1 * k, C + Math.sin(a) * R_DOUBLE1 * k);
    x.stroke();
  }

  // bulls
  x.beginPath(); x.arc(C, C, R_BULL_OUT * k, 0, Math.PI * 2); x.fillStyle = GREEN; x.fill();
  x.beginPath(); x.arc(C, C, R_BULL_IN * k, 0, Math.PI * 2); x.fillStyle = RED; x.fill();

  // numbers on the black ring, upright, facing out
  x.fillStyle = '#d8d2c4';
  x.font = `bold ${Math.round(0.021 * k)}px Georgia, serif`;
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  const rn = (R_DOUBLE1 + FACE_R) / 2;
  for (let i = 0; i < 20; i++) {
    const a = rad(i * 18 - 90); // canvas angle of sector center
    x.save();
    x.translate(C + Math.cos(a) * rn * k, C + Math.sin(a) * rn * k);
    x.rotate(a + Math.PI / 2);
    x.fillText(String(SECTORS[i]), 0, 0);
    x.restore();
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function dartMaterials() {
  return {
    point: new THREE.MeshStandardMaterial({ color: 0x8a8a92, roughness: 0.3, metalness: 0.9 }),
    barrel: new THREE.MeshStandardMaterial({ color: 0xb9b4a8, roughness: 0.35, metalness: 0.85 }),
    shaft: new THREE.MeshStandardMaterial({ color: 0x2a2118, roughness: 0.6 }),
    flight: new THREE.MeshStandardMaterial({
      color: 0xb5341f, roughness: 0.7, side: THREE.DoubleSide,
    }),
  };
}

const TIP_Z = 0.1; // dart-local z of the needle apex (dart points +z)

function makeDart(mats) {
  const g = new THREE.Group();
  const point = new THREE.Mesh(new THREE.ConeGeometry(0.0018, 0.022, 10), mats.point);
  point.geometry.rotateX(Math.PI / 2); // apex toward +z
  point.position.z = TIP_Z - 0.011;
  g.add(point);
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.0032, 0.0038, 0.05, 12), mats.barrel);
  barrel.geometry.rotateX(Math.PI / 2);
  barrel.position.z = TIP_Z - 0.022 - 0.025;
  g.add(barrel);
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.0016, 0.0016, 0.045, 8), mats.shaft);
  shaft.geometry.rotateX(Math.PI / 2);
  shaft.position.z = TIP_Z - 0.072 - 0.0225;
  g.add(shaft);
  // flights: two crossed fins CONTAINING the dart axis (+z); a plane's default
  // normal is +z, which would read as a giant red plus from behind
  for (const rz of [0, Math.PI / 2]) {
    const geo = new THREE.PlaneGeometry(0.013, 0.036);
    geo.rotateX(Math.PI / 2); // span X×Z: fin stands along the dart axis
    geo.rotateZ(rz);          // cross the second fin 90° around the axis
    const fl = new THREE.Mesh(geo, mats.flight);
    fl.position.z = TIP_Z - 0.117 - 0.021;
    g.add(fl);
  }
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return g;
}

export function createDarts(scene) {
  // --- board assembly ---
  const board = new THREE.Group();
  const face = new THREE.Mesh(
    new THREE.CircleGeometry(FACE_R, 72),
    new THREE.MeshStandardMaterial({ map: boardTexture(), roughness: 0.85, envMapIntensity: 0.2 })
  );
  face.position.z = 0.021;
  face.receiveShadow = true;
  board.add(face);
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(FACE_R + 0.004, FACE_R + 0.004, 0.04, 72),
    new THREE.MeshStandardMaterial({ color: 0x14100c, roughness: 0.8 })
  );
  body.geometry.rotateX(Math.PI / 2); // axis toward +z (out of the wall)
  board.add(body);
  const rim = new THREE.Mesh(
    new THREE.TorusGeometry(FACE_R + 0.002, 0.005, 10, 72),
    new THREE.MeshStandardMaterial({ color: 0x4a3b28, roughness: 0.5, metalness: 0.4 })
  );
  rim.position.z = 0.021;
  board.add(rim);
  board.rotation.y = Math.PI / 2; // assembly +z → world +x (faces the room)
  board.position.copy(BOARD_C);
  scene.add(board);
  const FACE_X = BOARD_C.x + 0.021;

  // predicted landing marker for the current aim + charge (aim-guide, tied to
  // the billiards "guides" toggle); parked on the board plane by setAimDot
  const aimDot = new THREE.Mesh(
    new THREE.RingGeometry(0.006, 0.011, 24),
    new THREE.MeshBasicMaterial({
      color: 0xfff6d8, transparent: true, opacity: 0.75,
      side: THREE.DoubleSide, depthWrite: false,
    })
  );
  aimDot.rotation.y = Math.PI / 2; // face the room
  aimDot.visible = false;
  scene.add(aimDot);

  function setAimDot(dy, dz) {
    if (dy == null || dz == null) { aimDot.visible = false; return; }
    aimDot.visible = true;
    aimDot.position.set(FACE_X + 0.002, BOARD_C.y + dy, BOARD_C.z + dz);
  }

  // --- darts ---
  const mats = dartMaterials();
  let handDart = null;

  const flying = []; // { mesh, vel, state: 'fly'|'fall', t }
  const stuck = [];  // { mesh, fade, wobT, q }

  function ensureHandDart() {
    if (handDart) return handDart;
    handDart = makeDart(dartMaterials());
    handDart.scale.setScalar(0.8); // held close to the eye — keep it modest
    handDart.visible = false;
    scene.add(handDart);
    return handDart;
  }
  ensureHandDart();

  function spawnDart(from, vel) {
    const mesh = makeDart(dartMaterials());
    mesh.position.copy(from);
    mesh.lookAt(from.x + vel.x, from.y + vel.y, from.z + vel.z);
    scene.add(mesh);
    flying.push({ mesh, vel: vel.clone(), state: 'fly', t: 0 });
  }

  /** The dart in your hand IS the dart that flies: release continuity comes
   *  from reusing the preview mesh instead of swapping in a fresh one. */
  function throwHandDart(vel) {
    const mesh = handDart || ensureHandDart();
    handDart = null;
    mesh.scale.setScalar(1); // world scale, same as the pool of darts
    mesh.lookAt(
      mesh.position.x + vel.x, mesh.position.y + vel.y, mesh.position.z + vel.z
    );
    flying.push({ mesh, vel: vel.clone(), state: 'fly', t: 0 });
  }

  function stickDart(mesh, hit, vel) {
    const d = vel.clone().normalize();
    // real darts pivot on the embedded tip and sag tail-down; exaggerate the
    // droop so the barrel/flight profile reads from the throw line
    d.y += 0.5;
    d.normalize();
    mesh.position.set(
      hit.x - d.x * (TIP_Z + 0.012),
      hit.y - d.y * (TIP_Z + 0.012),
      hit.z - d.z * (TIP_Z + 0.012)
    );
    mesh.lookAt(hit.x + d.x, hit.y + d.y, hit.z + d.z);
    stuck.push({ mesh, fade: -1, wobT: 0, q: mesh.quaternion.clone() });
  }

  /**
   * Advance flying darts. onLand(result) fires once per dart:
   *   hit board:  { miss:false, dy, dz, score }
   *   missed:     { miss:true }
   * Flight is integrated in CLOSED FORM (constant g): exact at any frame
   * rate — semi-implicit Euler drops ~2 cm under throttled headless frames,
   * which is the difference between a bull and an outer bull.
   */
  /** Slow-motion factor for the flight: the closed-form integration is exact
   *  at any step size, so scaling time stretches playback along the SAME arc
   *  — the dart reads as a continuous throw instead of a 10-frame teleport. */
  const DART_TS = 0.55;

  function updateFlight(dt, onLand) {
    dt *= DART_TS;
    for (let i = flying.length - 1; i >= 0; i--) {
      const f = flying[i];
      f.t += dt;
      const p = f.mesh.position;
      if (f.state === 'fly') {
        // analytic pierce of the board plane (vx is constant)
        if (f.vel.x < 0 && p.x > FACE_X) {
          const tc = (FACE_X - p.x) / f.vel.x;
          if (tc <= dt) {
            const hy = p.y + f.vel.y * tc - 0.5 * 9.81 * tc * tc;
            const hz = p.z + f.vel.z * tc;
            const dy = hy - BOARD_C.y, dz = hz - BOARD_C.z;
            if (Math.hypot(dy, dz) <= FACE_R) {
              flying.splice(i, 1);
              p.set(FACE_X, hy, hz);
              stickDart(f.mesh, { x: FACE_X, y: hy, z: hz }, f.vel);
              onLand({ miss: false, dy, dz, score: scoreAt(dy, dz) });
            } else {
              // off the board: clatter down the wall to the floor
              p.set(FACE_X, hy, hz);
              f.state = 'fall';
              f.vel.set(Math.abs(f.vel.x) * 0.12, -1.2, f.vel.z * 0.3);
            }
            continue;
          }
        }
        p.x += f.vel.x * dt;
        p.y += f.vel.y * dt - 0.5 * 9.81 * dt * dt;
        p.z += f.vel.z * dt;
        f.vel.y -= 9.81 * dt;
        f.mesh.lookAt(p.x + f.vel.x, p.y + f.vel.y, p.z + f.vel.z);
        if (f.t > 1.6) { // lost in flight (thrown past the wall)
          flying.splice(i, 1);
          scene.remove(f.mesh);
          onLand({ miss: true });
        }
      } else { // 'fall': cosmetic tumble to the floor
        f.vel.y -= 9.81 * dt;
        p.x += f.vel.x * dt;
        p.y += f.vel.y * dt;
        p.z += f.vel.z * dt;
        f.mesh.rotation.x += dt * 9;
        if (p.y <= 0.02) {
          flying.splice(i, 1);
          scene.remove(f.mesh);
          onLand({ miss: true });
        }
      }
    }
  }

  /** Fade and remove all stuck darts; fadeSec ≈ how long the fade runs. */
  function clearStuck(fadeSec = 0.5) {
    for (const s of stuck) {
      s.fade = fadeSec;
      s.mesh.traverse((o) => {
        if (o.isMesh) { o.material = o.material.clone(); o.material.transparent = true; }
      });
    }
  }

  function update(dt) {
    for (let i = stuck.length - 1; i >= 0; i--) {
      const s = stuck[i];
      // impact wobble: the board bites the tip, the tail rings briefly
      if (s.wobT !== undefined && s.wobT < 1.2) {
        s.wobT += dt;
        const damp = Math.exp(-6 * s.wobT);
        const ax = 0.16 * damp * Math.sin(34 * s.wobT);
        const ay = 0.10 * damp * Math.sin(27 * s.wobT + 1.1);
        const qx = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), ax);
        const qy = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), ay);
        s.mesh.quaternion.copy(s.q).multiply(qx).multiply(qy);
      }
      if (s.fade < 0) continue;
      s.fade -= dt;
      const a = Math.max(0, s.fade / 0.5);
      s.mesh.traverse((o) => { if (o.isMesh) o.material.opacity = a; });
      if (s.fade <= 0) {
        scene.remove(s.mesh);
        stuck.splice(i, 1);
      }
    }
  }

  function reset() {
    for (const f of flying) scene.remove(f.mesh);
    flying.length = 0;
    for (const s of stuck) scene.remove(s.mesh);
    stuck.length = 0;
    if (handDart) { scene.remove(handDart); handDart = null; }
    setAimDot(null);
  }

  return {
    board: { center: BOARD_C, faceX: FACE_X, radius: FACE_R },
    group: board, // the whole assembly (hidden by alignment tooling)
    get handDart() { return handDart; },
    ensureHandDart,
    throwHandDart,
    spawnDart,
    updateFlight,
    clearStuck,
    update,
    setAimDot,
    flying, stuck, // live refs for headless trajectory tracing
    reset,
    stuckCount: () => stuck.length,
    flyingCount: () => flying.length,
  };
}
