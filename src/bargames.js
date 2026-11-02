// bargames.js — bar-stool mini-games: dice high-low, russian roulette.
// Props (dice/tray/revolver) LIVE in the scene full-time — the games are
// played right where the props lie: entering a game picks the prop up, leaving
// puts it back. A tiny dedicated Rapier world rolls the dice. main.js owns the
// mode state machine and calls enter/exit/primary/look/update.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { diceTopValue, createDiceMatch, rouletteHit } from './barlogic.js';

// Stools stand before the bar; the props lie ON the bar worktop (measured via
// raycasts: counter face z≈-3.03, worktop y≈0.798, z -3.1..-3.9). The games
// are played leaning at the counter, props in reach.
export const STOOLS = {
  dice: new THREE.Vector3(-0.7, 1.62, -2.85),
  roulette: new THREE.Vector3(0.4, 1.62, -2.85),
};
const DICE_TRAY = new THREE.Vector3(-0.7, 0.806, -3.5); // on the bar worktop
const GUN_REST = new THREE.Vector3(0.4, 0.823, -3.5);
// the revolver lies on its left side, barrel pointing at the bar
const GUN_REST_QUAT = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI + 0.35, -Math.PI / 2, 'YXZ'));

// ---------------------------------------------------------------- props
function pipTexture(n) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d');
  x.fillStyle = '#f2eee4';
  x.fillRect(0, 0, 64, 64);
  const P = { 1: [[32, 32]], 2: [[18, 18], [46, 46]], 3: [[16, 16], [32, 32], [48, 48]],
    4: [[18, 18], [46, 18], [18, 46], [46, 46]], 5: [[16, 16], [48, 16], [32, 32], [16, 48], [48, 48]],
    6: [[18, 14], [46, 14], [18, 32], [46, 32], [18, 50], [46, 50]] }[n];
  x.fillStyle = n === 1 ? '#b5281f' : '#1c1a17';
  for (const [px, py] of P) {
    x.beginPath(); x.arc(px, py, n === 1 ? 10 : 6.5, 0, 7); x.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// BoxGeometry face order: [+x, -x, +y, -y, +z, -z] → values [3, 4, 1, 6, 2, 5]
function makeDie() {
  const mats = [3, 4, 1, 6, 2, 5].map((v) => new THREE.MeshStandardMaterial({
    map: pipTexture(v), roughness: 0.35, envMapIntensity: 0.3,
  }));
  const m = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.022, 0.022), mats);
  m.castShadow = m.receiveShadow = true;
  return m;
}

function makeTray() {
  const g = new THREE.Group();
  const wood = new THREE.MeshStandardMaterial({ color: 0x3d2a18, roughness: 0.7 });
  const base = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.014, 0.30), wood);
  base.receiveShadow = true;
  g.add(base);
  for (const [dx, dz, w, d] of [
    [-0.20, 0, 0.02, 0.30], [0.20, 0, 0.02, 0.30],
    [0, -0.14, 0.42, 0.02], [0, 0.14, 0.42, 0.02],
  ]) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(w, 0.045, d), wood);
    wall.position.set(dx, 0.022, dz);
    wall.castShadow = true;
    g.add(wall);
  }
  g.position.copy(DICE_TRAY);
  return g;
}

function makeRevolver() {
  const g = new THREE.Group();
  const steel = new THREE.MeshStandardMaterial({ color: 0x30333a, roughness: 0.32, metalness: 0.9, envMapIntensity: 0.7 });
  const walnut = new THREE.MeshStandardMaterial({ color: 0x4a2e1a, roughness: 0.55 });
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.009, 0.115, 16), steel);
  barrel.geometry.rotateX(Math.PI / 2);
  barrel.position.set(0, 0.012, 0.105);
  g.add(barrel);
  const frame = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.034, 0.06), steel);
  frame.position.set(0, 0.006, 0.035);
  g.add(frame);
  const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.032, 12), steel);
  drum.geometry.rotateX(Math.PI / 2);
  drum.position.set(0, 0.006, 0.032);
  drum.name = 'drum';
  g.add(drum);
  const sight = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.008, 0.05), steel);
  sight.position.set(0, 0.03, 0.09);
  g.add(sight);
  const hammer = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.02, 0.01), steel);
  hammer.position.set(0, 0.026, -0.004);
  hammer.rotation.x = -0.5;
  hammer.name = 'hammer';
  g.add(hammer);
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.05, 0.024), walnut);
  grip.position.set(0, -0.032, -0.005);
  grip.rotation.x = 0.35;
  g.add(grip);
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return g;
}

// ---------------------------------------------------------------- dice physics
// Tiny dedicated Rapier world: tray floor + 4 low walls + 6 dice. Mirrors the
// sim.js contract: fixed step, contact impulses for sound, settled check.
function createDiceSim(RAPIER, { cx, cy, cz, hx = 0.17, hz = 0.11 }) {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = 1 / 240;
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(hx + 0.03, 0.02, hz + 0.03)
      .setTranslation(cx, cy - 0.02, cz).setFriction(0.55).setRestitution(0.2)
  );
  const H = 0.05;
  for (const [dx, dz, whx, whz] of [
    [-hx, 0, 0.012, hz], [hx, 0, 0.012, hz],
    [0, -hz, hx, 0.012], [0, hz, hx, 0.012],
  ]) {
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(whx, H, whz)
        .setTranslation(cx + dx, cy + H, cz + dz).setFriction(0.3).setRestitution(0.45)
    );
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
        .setDensity(650).setFriction(0.45).setRestitution(0.32)
        .setContactForceEventThreshold(0.015)
        .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS),
      body
    );
    dice.push(body);
  }
  const eventQueue = new RAPIER.EventQueue(true);
  let impulses = [];
  return {
    dice,
    roll(idxList, rng = Math.random, spread = 1) {
      for (const i of idxList) {
        const b = dice[i];
        b.setTranslation({
          x: cx + (rng() - 0.5) * hx * 1.1 * spread,
          y: cy + 0.14 + rng() * 0.05,
          z: cz + (rng() - 0.5) * hz * 1.1 * spread,
        }, true);
        b.setLinvel({
          x: (rng() - 0.5) * 1.7,
          y: -0.5 - rng() * 0.7,
          z: (rng() - 0.5) * 1.3,
        }, true);
        b.setAngvel({ x: (rng() - 0.5) * 26, y: (rng() - 0.5) * 26, z: (rng() - 0.5) * 26 }, true);
      }
    },
    park() {
      dice.forEach((b, i) => {
        b.setTranslation({
          x: cx - hx + 0.035 + (i % 3) * 0.055,
          y: cy + DIE + 0.001,
          z: cz + hz - 0.035 - Math.floor(i / 3) * 0.055,
        }, true);
        b.setLinvel({ x: 0, y: 0, z: 0 }, true);
        b.setAngvel({ x: 0, y: 0, z: 0 }, true);
        b.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
      });
    },
    step() {
      world.step(eventQueue);
      eventQueue.drainContactForceEvents((e) => {
        const imp = e.totalForceMagnitude();
        if (imp > 0.02) impulses.push(imp);
      });
      eventQueue.drainCollisionEvents(() => {});
    },
    drainImpulses() { const t = impulses; impulses = []; return t; },
    settled() {
      return dice.every((b) => {
        const v = b.linvel(), w = b.angvel();
        return Math.hypot(v.x, v.y, v.z) < 0.045 && Math.hypot(w.x, w.y, w.z) < 0.4;
      });
    },
    read(idxList) { return idxList.map((i) => diceTopValue(dice[i].rotation())); },
  };
}

// ---------------------------------------------------------------- the games
export function createBarGames(scene, RAPIER, host) {
  // host: { camera, audio, t, toast, badge, rumble, veil }
  const { camera, audio, t, toast } = host;

  // --- shared props: everything lives in the scene full-time ---
  const tray = makeTray();
  scene.add(tray);
  const dieMeshes = [];
  for (let i = 0; i < 6; i++) {
    const d = makeDie();
    scene.add(d);
    dieMeshes.push(d);
  }

  // the revolver: user-provided Sketchfab model (assets/models/zuolun.glb),
  // barrel +z, drum = c_low, hammer = d_low. Procedural fallback if it fails.
  const gun = new THREE.Group();
  gun.position.copy(GUN_REST);
  gun.quaternion.copy(GUN_REST_QUAT);
  scene.add(gun);
  let gunDrum = null, gunHammer = null;
  new GLTFLoader().load('assets/models/zuolun.glb', (g) => {
    const root = g.scene;
    root.traverse((o) => {
      if (o.isMesh) o.castShadow = true;
      if (/bullet/i.test(o.name)) o.visible = false; // oversized display round
    });
    const bb = new THREE.Box3().setFromObject(root);
    const size = bb.getSize(new THREE.Vector3());
    const s = 0.23 / size.z; // revolver length ≈ 23 cm along the barrel
    root.scale.setScalar(s);
    // recentre the group on the drum (c_low center), so poses pivot naturally
    root.position.set(0, -1.17 * s, 0.04 * s);
    gun.add(root);
    gunDrum = root.getObjectByName('c_low');
    gunHammer = root.getObjectByName('d_low');
  }, undefined, (err) => {
    console.warn('zuolun.glb failed, using procedural revolver', err);
    const fallback = makeRevolver();
    gun.add(fallback);
    gunDrum = fallback.getObjectByName('drum');
    gunHammer = fallback.getObjectByName('hammer');
  });

  const diceSim = createDiceSim(RAPIER, { cx: DICE_TRAY.x, cy: DICE_TRAY.y + 0.007, cz: DICE_TRAY.z });
  diceSim.park(); // dice rest in the tray from the first frame

  // --- dice cup (from dice_game.glb): the shake ritual's star ---
  const CUP_REST = new THREE.Vector3(-0.32, 0.855, -3.5);
  const cup = new THREE.Group();
  cup.position.copy(CUP_REST);
  cup.visible = false;
  scene.add(cup);
  let cupReady = false, cupH = 0.1;
  new GLTFLoader().load('assets/models/dice_game.glb', (g) => {
    // parts all named "defaultMaterial" — the cup is the ~36×42×36 one
    let cupMesh = null, biggest = -1;
    g.scene.updateMatrixWorld(true);
    g.scene.traverse((o) => {
      if (!o.isMesh) return;
      const bb = new THREE.Box3().setFromObject(o);
      const size = bb.getSize(new THREE.Vector3());
      const score = Math.min(size.x, size.z) * size.y; // chunky & tall = the cup
      if (score > biggest && size.x < 40) { biggest = score; cupMesh = o; }
    });
    if (!cupMesh) { console.warn('dice_game.glb: cup not found'); return; }
    // keep the authored world transform while reparenting into our group
    const m = cupMesh.matrixWorld.clone();
    cup.add(cupMesh);
    m.decompose(cupMesh.position, cupMesh.quaternion, cupMesh.scale);
    // measure truthfully now, normalize to 0.105 m tall, bottom-center origin
    const bb = new THREE.Box3().setFromObject(cupMesh);
    const size = bb.getSize(new THREE.Vector3());
    const s = 0.105 / size.y;
    cupH = size.y * s;
    cup.scale.setScalar(s);
    const c = bb.getCenter(new THREE.Vector3());
    cupMesh.position.sub(new THREE.Vector3(c.x, bb.min.y, c.z));
    cup.visible = true;
    cupReady = true;
  }, undefined, (e) => console.warn('dice_game.glb failed', e));

  // prop pickup blend: 0 = lying at its rest spot, 1 = in the player's hand
  const lift = { gun: 0 };
  function blendProp(mesh, restPos, restQuat, handPos, handQuat, k) {
    if (k >= 0.999) {
      mesh.position.copy(handPos);
      mesh.quaternion.copy(handQuat);
      return;
    }
    const s = smooth01(k);
    mesh.position.lerpVectors(restPos, handPos, s);
    mesh.quaternion.slerpQuaternions(restQuat, handQuat, s);
  }

  // hand-pose helpers (same pattern as the darts hand)
  function handPose(fwdD, rightD, down, camera) {
    const fwd = new THREE.Vector3();
    camera.getWorldDirection(fwd);
    const right = new THREE.Vector3().crossVectors(fwd, camera.up).normalize();
    return camera.position.clone()
      .addScaledVector(fwd, fwdD)
      .addScaledVector(right, rightD)
      .add(new THREE.Vector3(0, -down, 0));
  }

  const smooth01 = (x) => { const k = THREE.MathUtils.clamp(x, 0, 1); return k * k * (3 - 2 * k); };
  const sway = (t, f, p) => Math.sin(t * f + (p || 0));

  // ================================================================ DICE
  const diceGame = {
    st: 'idle', // idle | pRitual | hRitual | show
    t: 0,
    yaw: 0, pitch: 0,
    match: createDiceMatch(),
    last: null,
    side: 'p',
    rt: 0,
    rolled: false,
    revealed: false,
    holdT: 0,
    enter() {
      this.yaw = 0; this.pitch = 0;
      this.st = 'idle';
      this.match.reset();
      this.last = null;
      diceSim.park(); // scattered dice hop back into the tray
      this.syncMeshes();
      this.syncUI();
    },
    exit() { /* tray & dice stay where they are — that's the point */ },
    look(mx, my) {
      this.yaw = THREE.MathUtils.clamp(this.yaw - mx * 0.0012, -0.14, 0.14);
      this.pitch = THREE.MathUtils.clamp(this.pitch - my * 0.0012, -0.1, 0.1);
    },
    primary() {
      if (this.st === 'idle' || this.st === 'show') {
        if (this.match.over) { this.match.reset(); this.last = null; }
        this.startRitual('p');
      }
    },
    startRitual(side) {
      this.side = side;
      this.rt = 0;
      this.rolled = false;
      this.revealed = false;
      this.holdT = 0;
      this.st = side === 'p' ? 'pRitual' : 'hRitual';
      this.syncUI();
    },
    syncMeshes() {
      diceSim.dice.forEach((b, i) => {
        const p = b.translation(), q = b.rotation();
        dieMeshes[i].position.set(p.x, p.y, p.z);
        dieMeshes[i].quaternion.set(q.x, q.y, q.z, q.w);
      });
    },
    syncUI() {
      const s = this.match.score();
      let line = t('diceScore', s.pw, s.hw);
      if (this.last) line += ` · ${t('diceLast', this.last.p, this.last.h)}`;
      host.showBar(line);
    },
    update(dt, now) {
      // camera leans at the counter, looking into the tray on the worktop
      camera.position.set(STOOLS.dice.x, 1.62, -2.8);
      const trayLook = DICE_TRAY;
      const dx = trayLook.x - camera.position.x, dy = trayLook.y + 0.02 - camera.position.y, dz = trayLook.z - camera.position.z;
      camera.rotation.set(0, 0, 0);
      camera.rotateY(Math.atan2(-dx, -dz) + this.yaw);
      camera.rotateX(Math.atan2(dy, Math.hypot(dx, dz)) + this.pitch);
      // physics: 240 Hz substeps, impulses → ticks
      let n = Math.min(8, Math.max(1, Math.round(dt / (1 / 240))));
      while (n-- > 0) diceSim.step();
      for (const imp of diceSim.drainImpulses()) {
        audio.diceTick(Math.min(1, Math.log10(1 + imp * 30)));
      }
      this.syncMeshes();
      this.t += dt;

      // --- the cup ritual: cover → shake → (physics roll) → reveal ---
      if (this.st === 'pRitual' || this.st === 'hRitual') {
        const idx = this.side === 'p' ? [0, 1, 2] : [3, 4, 5];
        let rtNext = this.rt + dt / 2.6;
        // hold at the reveal point until the dice have actually settled
        if (rtNext > 0.6 && !diceSim.settled() && this.holdT < 4) {
          this.holdT += dt;
          rtNext = 0.6;
        } else if (rtNext > 0.6) this.holdT = 0;
        this.rt = Math.min(1, rtNext);
        const rt = this.rt;
        const coverK = smooth01(rt / 0.18);
        const revealK = smooth01((rt - 0.6) / 0.32);
        const shaking = rt >= 0.18 && rt < 0.6;
        const shakeK = shaking ? 1 : 0;
        const over = new THREE.Vector3(DICE_TRAY.x, DICE_TRAY.y + 0.012, DICE_TRAY.z);
        const pos = CUP_REST.clone().lerp(over, coverK);
        if (shaking) {
          pos.x += Math.sin(now * 43) * 0.009;
          pos.z += Math.cos(now * 37) * 0.008;
          pos.y += Math.abs(Math.sin(now * 31)) * 0.012;
        }
        cup.position.copy(pos.lerp(CUP_REST, revealK));
        cup.rotation.z = shaking ? Math.sin(now * 41) * 0.12 * shakeK : 0;
        cup.rotation.x = shaking ? Math.cos(now * 34) * 0.10 * shakeK : 0;
        if (cupReady && !this.rolled && rt >= 0.18) {
          this.rolled = true;
          diceSim.roll(idx, Math.random, 0.35); // scooped tight under the cup
          audio.diceShake();
          idx.forEach((i) => (dieMeshes[i].visible = false)); // hidden under the cup
        } else if (!cupReady && !this.rolled && rt >= 0.18) {
          this.rolled = true; // no cup model: roll bare, same honesty
          diceSim.roll(idx);
          audio.diceShake();
        }
        if (!this.revealed && rt >= 0.62) {
          this.revealed = true;
          idx.forEach((i) => (dieMeshes[i].visible = true));
          audio.cupThud();
        }
        if (rt >= 1) {
          const vals = diceSim.read(idx);
          if (this.side === 'p') {
            this.pVals = vals;
            this.startRitual('h');
          } else {
            const hVals = vals;
            const p = this.pVals.reduce((a, b) => a + b, 0);
            const h = hVals.reduce((a, b) => a + b, 0);
            const r = this.match.play(p, h);
            this.last = { p, h };
            const sc = this.match.score();
            if (sc.over) {
              const win = sc.pw > sc.hw;
              host.badge(t(win ? 'diceMatchWin' : 'diceMatchLose'), t('diceScore', sc.pw, sc.hw), true);
              if (win) audio.bigSting(); else audio.loseSting();
            } else {
              toast(t('diceLast', p, h) + ' · ' + t(r === 'player' ? 'diceWinRound' : r === 'house' ? 'diceLoseRound' : 'diceDrawRound'));
              if (r === 'player') audio.badgeSting();
            }
            this.st = 'show';
            this.syncUI();
          }
        }
      }
    },
  };

  // ================================================================ ROULETTE
  const _looker = new THREE.Object3D();
  function lookQuat(pos, target) {
    _looker.position.copy(pos);
    _looker.lookAt(target);
    return _looker.quaternion.clone();
  }
  const roulette = {
    st: 'idle', // idle | spin | raise | recover | dead
    t: 0,
    yaw: 0, pitch: -0.35,
    streak: Number(localStorage.getItem('rou-streak') || 0),
    best: Number(localStorage.getItem('rou-best') || 0),
    hit: false,
    liftTarget: 0,
    enter() {
      this.yaw = 0; this.pitch = -0.35;
      this.st = 'idle';
      this.t = 0;
      this.liftTarget = 1; // pick the revolver up off the stool
      this.syncUI();
    },
    exit() {
      this.liftTarget = 0; // set it back down
      host.veil.style.opacity = '0';
    },
    look(mx, my) {
      this.yaw = THREE.MathUtils.clamp(this.yaw - mx * 0.0016, -0.4, 0.4);
      this.pitch = THREE.MathUtils.clamp(this.pitch - my * 0.0015, -0.4, 0.3);
    },
    primary() {
      if (this.st === 'idle' && lift.gun > 0.9) {
        this.st = 'spin';
        this.t = 0;
        audio.ratchet();
      }
    },
    syncUI() {
      host.showBar(t('rouStreak', this.streak) + (this.best > 0 ? ` · ${t('rouBest', this.best)}` : ''));
    },
    gunPose(d, r, dn, aimAtCam, camera) {
      const hp = handPose(d, r, dn, camera);
      let hq;
      if (aimAtCam) {
        hq = lookQuat(hp, new THREE.Vector3(camera.position.x, camera.position.y - 0.02, camera.position.z));
      } else {
        const fwd = new THREE.Vector3();
        camera.getWorldDirection(fwd);
        hq = lookQuat(hp, new THREE.Vector3(hp.x + fwd.x, hp.y + fwd.y * 0.4 + 0.06, hp.z + fwd.z));
      }
      blendProp(gun, GUN_REST, GUN_REST_QUAT, hp, hq, lift.gun);
    },
    update(dt, now) {
      lift.gun += (this.liftTarget - lift.gun) * (1 - Math.exp(-dt * 4.5));
      const stand = STOOLS.roulette;
      camera.position.copy(stand);
      camera.rotation.set(0, 0, 0);
      camera.rotateY(this.yaw);
      camera.rotateX(this.pitch);
      this.t += dt;
      if (this.st === 'idle') {
        this.gunPose(0.40, 0.15, 0.19, false, camera);
      } else if (this.st === 'spin') {
        this.gunPose(0.36, 0.16, 0.18, false, camera);
        if (gunDrum) gunDrum.rotation.z -= dt * 28;
        if (this.t >= 1.0) {
          this.hit = rouletteHit();
          this.st = 'raise';
          this.t = 0;
          audio.hammerCock();
        }
      } else if (this.st === 'raise') {
        const k = smooth01(this.t / 0.6);
        this.gunPose(
          0.36 - 0.07 * k, 0.16 - 0.07 * k, 0.18 - 0.06 * k, k > 0.55, camera
        );
        if (this.t >= 0.65) {
          // pull the trigger
          if (gunHammer) gunHammer.rotation.x = 0.2;
          if (this.hit) {
            audio.gunshot();
            host.rumble(1, 200);
            host.veil.style.background = '#fff';
            host.veil.style.opacity = '1';
            setTimeout(() => { host.veil.style.background = '#000'; }, 90);
            audio.tinnitus();
            this.st = 'dead';
            this.t = 0;
          } else {
            audio.hammerDry();
            this.streak++;
            if (this.streak > this.best) {
              this.best = this.streak;
              try { localStorage.setItem('rou-best', String(this.best)); } catch (_) {}
            }
            try { localStorage.setItem('rou-streak', String(this.streak)); } catch (_) {}
            toast(t('rouSurvive', this.streak));
            if (this.streak === 3 || this.streak === 5 || this.streak === 10) {
              host.badge(t('rouSurvive', this.streak), t('rouBest', this.best), false);
              audio.badgeSting();
            }
            this.st = 'recover';
            this.t = 0;
          }
          this.syncUI();
        }
      } else if (this.st === 'recover') {
        this.gunPose(0.40, 0.15, 0.19, false, camera);
        if (this.t > 0.5) this.st = 'idle';
      } else if (this.st === 'dead') {
        // white flash already shown; sink into black, then wake at the stool
        if (this.t > 1.6) {
          host.veil.style.opacity = '0';
          this.streak = 0;
          try { localStorage.setItem('rou-streak', '0'); } catch (_) {}
          toast(t('rouWake'), 3000);
          this.st = 'idle';
          this.t = 0;
          this.syncUI();
        }
      }
    },
  };

  // ================================================================ shared
  return {
    dice: diceGame, roulette,
    lift, // prop pickup blends (0 = at rest, 1 = in hand) — test hooks read it
  };
}
