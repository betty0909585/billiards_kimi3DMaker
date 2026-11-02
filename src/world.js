// world.js — three.js scene construction. Rendering reads sim state; it never
// writes back into physics (contract section 9).
//
// External assets (all CC0, see assets/LICENSES.md):
//   assets/env/fireplace_1k.hdr      — environment reflections (Poly Haven)
//   assets/tex/american_walnut_*     — rail / cue wood (Poly Haven)
// Everything else is procedural.

import * as THREE from 'three';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import {
  BALL_R, TABLE_HX, TABLE_HZ, CUSHION_HEIGHT, CUSHION_THICK,
  cushionSegments, pocketLayout,
} from './sim.js';
import { clothTextures, woodTexture, ballTexture, plankFloorTextures, wallTexture, glowSprite, dioramaWoodTexture, netTexture } from './textures.js';

export const TABLE_Y = 0.78; // regulation-ish playing surface height

const FRAME_W = 0.11;      // wooden rail width
const FRAME_H = 0.13;      // wooden rail height
const FRAME_TOP = 0.055;   // rail top above playing surface

const ROOM = { hx: 4.2, hz: 3.4, h: 3.1 };

function loadTex(url, { srgb = false, repeat = 1 } = {}) {
  const t = new THREE.TextureLoader().load(url);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function walnutMats() {
  const base = 'assets/tex/american_walnut_';
  const map = loadTex(base + 'diff_1k.jpg', { srgb: true });
  const normalMap = loadTex(base + 'nor_gl_1k.jpg');
  const roughnessMap = loadTex(base + 'rough_1k.jpg');
  const aoMap = loadTex(base + 'ao_1k.jpg');
  const rail = new THREE.MeshStandardMaterial({
    map, normalMap, roughnessMap, aoMap, roughness: 1, metalness: 0.06,
    normalScale: new THREE.Vector2(0.6, 0.6),
    color: 0x554c42,        // tint down: raw veneer reads too pale under the lamp
    envMapIntensity: 0.35,
  });
  const dark = rail.clone();
  dark.color = new THREE.Color(0x4a4038); // tinted down for legs/apron
  return { rail, dark };
}

export function createWorld(renderer) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x070605);
  scene.fog = new THREE.Fog(0x070605, 5, 11);

  // --- CC0 HDRI: reflections only (background stays dark) ---
  new RGBELoader().load('assets/env/fireplace_1k.hdr', (tex) => {
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromEquirectangular(tex).texture;
    tex.dispose();
    pmrem.dispose();
  });

  const table = new THREE.Group();
  table.position.y = TABLE_Y;
  scene.add(table);

  // --- Bar Diorama (CC-BY, Ethica) — full room, replaces procedural set ---
  const diorama = new THREE.Group();
  scene.add(diorama);
  // --- fizyman Pool Table Traditional (CC-BY): regulation model replaces
  // the procedural table visuals. Physics is untouched; alignment is tuned
  // so its cloth plane sits exactly at the physics surface.
  const trad = new THREE.Group();
  scene.add(trad);
  new GLTFLoader().load('assets/models/pool_table_traditional.glb', (g) => {
    // hide its own balls/cues/lamp — ours are better/fit the loop
    g.scene.traverse((o) => {
      if (/billiard_ball|pool_cue|ceiling_light/i.test(o.name)) { o.visible = false; return; }
      if (o.isMesh) {
        o.castShadow = o.receiveShadow = true;
        // the model's material is authored alphaMode:BLEND — that renders the
        // whole table depthless and see-through. Force opaque + alphaTest so
        // the cloth is solid and only the net weave cuts out.
        const m = o.material;
        if (m && m.transparent) {
          m.transparent = false;
          m.depthWrite = true;
          m.alphaTest = 0.5;
          m.needsUpdate = true;
        }
      }
    });
    // alignment, measured live: baked mm->m scale inside the GLB, one y-90°
    // puts the length along x; non-uniform plan scale lands its pocket
    // mouths exactly on the physics pockets (±1.27, ±0.635)
    trad.quaternion.set(0, 0.7071, 0, 0.7071);
    trad.scale.set(1.173, 1.0, 1.120);
    trad.position.set(-0.035, 0.019, 0);
    trad.add(g.scene);
    window.__trad = { root: g.scene, group: trad };
  });
  new GLTFLoader().load('assets/models/bar_diorama.glb', (gltf) => {
    // hide the diorama's own pool table (Object_3) and ball rack (Object_9):
    // ours is the playable one. Identified via world-space bboxes.
    gltf.scene.traverse((o) => {
      if (o.isMesh && (o.name === 'Object_3' || o.name === 'Object_9')) o.visible = false;
      if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
    });
    const bb = new THREE.Box3().setFromObject(gltf.scene);
    const ctr = bb.getCenter(new THREE.Vector3());
    const S = 0.125; // roomier: walls & poster sit well clear of the table
    diorama.scale.setScalar(S);
    // shifted -x by 1m: the picture/dartboard wall (Object_7) was crowding the
    // aim & broadcast cameras on the table's left side
    diorama.position.set(-ctr.x * S - 1.0, -bb.min.y * S, -1.3);
    diorama.add(gltf.scene);
    // strip the decorative dart the artist stuck in the baked dartboard (its
    // geometry is merged into Object_7): our playable board covers the board
    // itself, and the baked dart would poke through it. Filter triangles in
    // world space (diorama transform applied).
    diorama.updateMatrixWorld(true);
    {
      const C = { x: -3.155, y: 1.731, z: -2.261 }; // baked board center (world)
      const v = new THREE.Vector3();
      gltf.scene.traverse((o) => {
        if (!o.isMesh || o.name !== 'Object_7') return;
        const pos = o.geometry.attributes.position;
        const idx = o.geometry.index;
        const keep = [];
        for (let i = 0; i < idx.count; i += 3) {
          let baked = true;
          for (let j = 0; j < 3; j++) {
            v.fromBufferAttribute(pos, idx.getX(i + j)).applyMatrix4(o.matrixWorld);
            const r = Math.hypot(v.y - C.y, v.z - C.z);
            if (!(v.x > C.x - 0.04 && r < 0.10)) { baked = false; break; }
          }
          if (!baked) keep.push(idx.getX(i), idx.getX(i + 1), idx.getX(i + 2));
        }
        o.geometry.setIndex(keep);
      });
    }
    window.__diorama = { root: gltf.scene, group: diorama, bbox: bb };
  });

  // The diorama replaces the procedural set: hide walls/floor/props that
  // would double up. Lamp, lights, neon, dust and light cone stay.
  const SHOW_SET = false;

  // --- enclosure walls in the diorama's own painted-wood style ---
  // Close the open right side and the viewer side so the room reads fully
  // enclosed. The left wall sits 1m further out (diorama shifted -x).
  {
    const tex = dioramaWoodTexture();
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.92, envMapIntensity: 0.2 });
    const floorTex = tex.clone();
    floorTex.repeat.set(3, 3);
    const floorMat = new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.95, envMapIntensity: 0.15 });
    const H = 3.05, X = 2.77, X_LEFT = 3.77, Z_BACK = -5.4, Z_FRONT = 3.8, Z_DIO_END = 0.99;
    const X_MID = (X - X_LEFT) / 2, X_SPAN = X + X_LEFT;
    function addWall(w, h, px, py, pz, ry) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
      m.position.set(px, py, pz);
      m.rotation.y = ry;
      m.receiveShadow = true;
      scene.add(m);
      return m;
    }
    // right wall (full depth), neon hangs on it
    addWall(Z_FRONT - Z_BACK, H, X, H / 2, (Z_FRONT + Z_BACK) / 2, -Math.PI / 2);
    // south wall behind the player area
    addWall(X_SPAN, H, X_MID, H / 2, Z_FRONT, Math.PI);
    // left extension from the diorama's end to the south wall
    addWall(Z_FRONT - Z_DIO_END, H, -X_LEFT, H / 2, (Z_FRONT + Z_DIO_END) / 2, Math.PI / 2);
    // floor extension to the south wall
    const ext = new THREE.Mesh(new THREE.PlaneGeometry(X_SPAN, Z_FRONT - Z_DIO_END), floorMat);
    ext.rotation.x = -Math.PI / 2;
    ext.position.set(X_MID, 0.001, (Z_FRONT + Z_DIO_END) / 2);
    ext.receiveShadow = true;
    scene.add(ext);
    // dark acoustic ceiling + wood beams: real pool halls keep the lid dark
    // so the eye stays on the table
    const CEIL_Y = 3.05;
    const ceilMat2 = new THREE.MeshStandardMaterial({ color: 0x120b07, roughness: 1 });
    const ceilM = new THREE.Mesh(new THREE.PlaneGeometry(X_SPAN, Z_FRONT - Z_BACK), ceilMat2);
    ceilM.rotation.x = Math.PI / 2;
    ceilM.position.set(X_MID, CEIL_Y, (Z_FRONT + Z_BACK) / 2);
    scene.add(ceilM);
    const beamMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9, envMapIntensity: 0.15 });
    for (const bz of [-3.2, -1.0, 1.2]) {
      const beam = new THREE.Mesh(new THREE.BoxGeometry(X_SPAN, 0.09, 0.14), beamMat);
      beam.position.set(X_MID, CEIL_Y - 0.045, bz);
      beam.castShadow = true;
      scene.add(beam);
    }
  }

  // --- playing surface (cloth): one face with six ROUND pocket holes,
  // trimmed to the frame footprint (no green spilling past the table) ---
  const cloth = clothTextures();
  const CW = TABLE_HX + CUSHION_THICK + 0.115; // x extent ≈ frame footprint
  const CH = TABLE_HZ + CUSHION_THICK + 0.115; // z extent
  cloth.map.wrapS = cloth.map.wrapT = THREE.ClampToEdgeWrapping;
  cloth.map.repeat.set(1 / (2 * CW), 1 / (2 * CH));
  cloth.map.offset.set(0.5, 0.5);
  cloth.bump.wrapS = cloth.bump.wrapT = THREE.ClampToEdgeWrapping;
  cloth.bump.repeat.copy(cloth.map.repeat);
  cloth.bump.offset.copy(cloth.map.offset);
  const clothMat = new THREE.MeshStandardMaterial({
    map: cloth.map,
    bumpMap: cloth.bump,
    bumpScale: 0.6,
    roughness: 0.96,
    metalness: 0,
    envMapIntensity: 0.12,
  });
  {
    const shape = new THREE.Shape();
    shape.moveTo(-CW, -CH);
    shape.lineTo(CW, -CH);
    shape.lineTo(CW, CH);
    shape.lineTo(-CW, CH);
    shape.closePath();
    for (const p of pocketLayout()) {
      const hole = new THREE.Path();
      hole.absarc(p.x, p.z, p.r * 0.92, 0, Math.PI * 2, true);
      shape.holes.push(hole);
    }
    const geo = new THREE.ShapeGeometry(shape, 24);
    geo.rotateX(-Math.PI / 2); // shape (x,y) → table (x,z); pockets are z-symmetric
    const clothMesh = new THREE.Mesh(geo, clothMat);
    clothMesh.receiveShadow = true;
    table.add(clothMesh);
  }

  // --- cushions (cloth covered) ---
  const cushionTex = cloth.map.clone();
  cushionTex.wrapS = cushionTex.wrapT = THREE.RepeatWrapping;
  cushionTex.repeat.set(1, 1);
  cushionTex.offset.set(0, 0);
  cushionTex.needsUpdate = true;
  const cushionBump = cloth.bump.clone();
  cushionBump.wrapS = cushionBump.wrapT = THREE.RepeatWrapping;
  cushionBump.repeat.set(1, 1);
  cushionBump.offset.set(0, 0);
  cushionBump.needsUpdate = true;
  const cushionMat = new THREE.MeshStandardMaterial({
    map: cushionTex, roughness: 0.94, bumpMap: cushionBump, bumpScale: 0.4,
    envMapIntensity: 0.1,
  });
  // cushions: body + tapered "nose" wedges pointing into each pocket jaw.
  // (physics colliders stay boxes — collision feel is untouched)
  const NOSE_L = 0.055;
  function noseGeo(len, w0, w1, h) {
    const sh = new THREE.Shape();
    sh.moveTo(0, -w0 / 2);
    sh.lineTo(len, -w1 / 2);
    sh.lineTo(len, w1 / 2);
    sh.lineTo(0, w0 / 2);
    sh.closePath();
    const g = new THREE.ExtrudeGeometry(sh, {
      depth: h, bevelEnabled: true, bevelThickness: 0.004, bevelSize: 0.004, bevelSegments: 2,
    });
    g.rotateX(-Math.PI / 2); // plan XY -> table XZ, extrusion -> +y
    return g;
  }
  const T2 = CUSHION_THICK;
  for (const s of cushionSegments()) {
    const alongX = s.hx >= s.hz;
    const L = (alongX ? s.hx : s.hz) * 2;
    const mainL = L - NOSE_L * 2;
    const g = new THREE.Group();
    if (mainL > 0) {
      const main = new THREE.Mesh(
        new THREE.BoxGeometry(alongX ? mainL : T2, CUSHION_HEIGHT, alongX ? T2 : mainL),
        cushionMat
      );
      main.castShadow = main.receiveShadow = true;
      g.add(main);
    }
    for (const dir of [-1, 1]) {
      const nose = new THREE.Mesh(noseGeo(NOSE_L, T2, T2 * 0.42, CUSHION_HEIGHT), cushionMat);
      nose.position.x = dir * (L / 2 - NOSE_L);
      if (dir < 0) nose.rotation.y = Math.PI;
      if (!alongX) nose.rotation.y += dir > 0 ? -Math.PI / 2 : Math.PI / 2;
      nose.castShadow = nose.receiveShadow = true;
      g.add(nose);
    }
    g.position.set(s.cx, 0, s.cz);
    table.add(g);
  }

  // --- wooden rails: American walnut veneer (CC0) ---
  const walnut = walnutMats();
  const outX = TABLE_HX + CUSHION_THICK;
  const outZ = TABLE_HZ + CUSHION_THICK;
  const railY = FRAME_TOP - FRAME_H / 2;
  for (const sz of [-1, 1]) {
    const rail = new THREE.Mesh(
      new THREE.BoxGeometry((outX + FRAME_W) * 2, FRAME_H, FRAME_W), walnut.rail);
    rail.position.set(0, railY, sz * (outZ + FRAME_W / 2));
    rail.castShadow = rail.receiveShadow = true;
    table.add(rail);
  }
  for (const sx of [-1, 1]) {
    const rail = new THREE.Mesh(
      new THREE.BoxGeometry(FRAME_W, FRAME_H, outZ * 2), walnut.rail);
    rail.position.set(sx * (outX + FRAME_W / 2), railY, 0);
    rail.castShadow = rail.receiveShadow = true;
    table.add(rail);
  }

  // --- pockets: dark throat + chrome jaw caps ---
  const throatMat = new THREE.MeshStandardMaterial({ color: 0x030303, roughness: 1 });
  const chromeMat = new THREE.MeshStandardMaterial({
    color: 0x8f8f96, roughness: 0.32, metalness: 1, envMapIntensity: 1.1,
  });
  const netMat = new THREE.MeshStandardMaterial({
    map: netTexture(), transparent: true, alphaTest: 0.42,
    side: THREE.DoubleSide, roughness: 0.95, color: 0x9a7a50,
  });
  // dark padded liner around the mouth (real pockets have leather/plastic
  // sleeves, not bare cloth holes)
  const linerMat = new THREE.MeshStandardMaterial({ color: 0x120d0a, roughness: 0.55, envMapIntensity: 0.5 });
  for (const p of pocketLayout()) {
    const liner = new THREE.Mesh(new THREE.TorusGeometry(p.r * 0.95, 0.008, 10, 28), linerMat);
    liner.rotation.x = Math.PI / 2;
    liner.position.set(p.x, 0.003, p.z);
    liner.castShadow = true;
    table.add(liner);
    // woven net bag hanging below the frame — visible from the side,
    // ball nests into the mesh when it lands
    const net = new THREE.Mesh(new THREE.CylinderGeometry(p.r * 0.92, p.r * 0.5, 0.30, 20, 3, true), netMat);
    net.position.set(p.x, -0.155, p.z);
    table.add(net);
    const bottom = new THREE.Mesh(new THREE.CircleGeometry(p.r * 0.5, 20), throatMat);
    bottom.rotation.x = -Math.PI / 2;
    bottom.position.set(p.x, -0.308, p.z);
    table.add(bottom);
    // curved pocket iron wrapping the outer jaw (brass casting look)
    {
      const arcLen = p.kind === 'corner' ? 1.9 : 2.1;
      const geo = new THREE.TorusGeometry(p.r * 0.99, 0.0085, 10, 24, arcLen);
      geo.rotateX(Math.PI / 2);
      const iron = new THREE.Mesh(geo, chromeMat);
      iron.rotation.y = -(Math.atan2(p.z, p.x) - arcLen / 2);
      iron.position.set(p.x, 0.012, p.z);
      iron.castShadow = true;
      table.add(iron);
    }
  }

  // --- legs + apron (dark walnut) ---
  const apron = new THREE.Mesh(
    new THREE.BoxGeometry((outX + FRAME_W) * 2 - 0.06, 0.14, (outZ + FRAME_W) * 2 - 0.06), walnut.dark);
  apron.position.y = railY - FRAME_H / 2 - 0.07;
  table.add(apron);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.14, TABLE_Y - 0.2, 0.14), walnut.dark);
    leg.position.set(sx * (outX + FRAME_W / 2), -(TABLE_Y - 0.2) / 2 - railY - FRAME_H / 2 + 0.02, sz * (outZ + FRAME_W / 2));
    leg.castShadow = true;
    table.add(leg);
  }

  // ================= the pool hall =================
  const wallMat = new THREE.MeshStandardMaterial({
    map: wallTexture(), roughness: 0.92, envMapIntensity: 0.25,
  });
  const ceilMat = new THREE.MeshStandardMaterial({ color: 0x100c09, roughness: 1 });
  function wall(w, h, px, py, pz, ry) {
    if (!SHOW_SET) return null;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), wallMat);
    m.position.set(px, py, pz);
    m.rotation.y = ry;
    m.receiveShadow = true;
    scene.add(m);
    return m;
  }
  wall(ROOM.hx * 2, ROOM.h, 0, ROOM.h / 2, -ROOM.hz, 0);
  wall(ROOM.hx * 2, ROOM.h, 0, ROOM.h / 2, ROOM.hz, Math.PI);
  wall(ROOM.hz * 2, ROOM.h, -ROOM.hx, ROOM.h / 2, 0, Math.PI / 2);
  wall(ROOM.hz * 2, ROOM.h, ROOM.hx, ROOM.h / 2, 0, -Math.PI / 2);
  if (SHOW_SET) {
    const ceil = new THREE.Mesh(new THREE.PlaneGeometry(ROOM.hx * 2, ROOM.hz * 2), ceilMat);
    ceil.rotation.x = Math.PI / 2;
    ceil.position.y = ROOM.h;
    scene.add(ceil);
  }

  // floor: dark glossy planks — reflections are half the "光影感"
  const plank = plankFloorTextures();
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(ROOM.hx * 2, ROOM.hz * 2),
    new THREE.MeshStandardMaterial({
      map: plank.map, roughnessMap: plank.rough, roughness: 1,
      metalness: 0.08, envMapIntensity: 0.9,
    })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  floor.visible = SHOW_SET;
  scene.add(floor);

  // hanging lamp over the table (the money detail)
  const lamp = new THREE.Group();
  const shade = new THREE.Mesh(
    new THREE.CylinderGeometry(0.34, 0.62, 0.4, 32, 1, true),
    new THREE.MeshStandardMaterial({ color: 0x111313, roughness: 0.4, metalness: 0.6, side: THREE.DoubleSide })
  );
  lamp.add(shade);
  // emissive bulb + inner glow — bloom turns these into a real light source
  const bulb = new THREE.Mesh(
    new THREE.SphereGeometry(0.07, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0xfff3d0 })
  );
  bulb.position.y = -0.08;
  bulb.layers.enable(1); // bloom layer
  lamp.add(bulb);
  const lampGlow = new THREE.Mesh(
    new THREE.RingGeometry(0.06, 0.2, 32),
    new THREE.MeshBasicMaterial({ color: 0x7a5c28, side: THREE.DoubleSide, transparent: true, opacity: 0.7 })
  );
  lampGlow.rotation.x = Math.PI / 2;
  lampGlow.position.y = -0.19;
  lampGlow.layers.enable(1);
  lamp.add(lampGlow);
  const rod = new THREE.Mesh(
    new THREE.CylinderGeometry(0.015, 0.015, 0.42, 8),
    new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.5, metalness: 0.8 })
  );
  rod.position.y = 0.2 + 0.21;
  lamp.add(rod);
  lamp.position.set(0, 2.45, 0);
  scene.add(lamp);

  // fake volumetric cone under the lamp (additive, depthWrite off)
  const coneTex = (() => {
    const c = document.createElement('canvas');
    c.width = 64; c.height = 256;
    const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0, 'rgba(255,230,180,0.55)');
    g.addColorStop(0.6, 'rgba(255,230,180,0.12)');
    g.addColorStop(1, 'rgba(255,230,180,0)');
    x.fillStyle = g;
    x.fillRect(0, 0, 64, 256);
    return new THREE.CanvasTexture(c);
  })();
  const lightCone = new THREE.Mesh(
    new THREE.CylinderGeometry(0.42, 1.35, 1.62, 32, 1, true),
    new THREE.MeshBasicMaterial({
      map: coneTex, transparent: true, opacity: 0.06,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      fog: false,
    })
  );
  lightCone.position.set(0, 1.44, 0);
  lightCone.renderOrder = 8;
  scene.add(lightCone);

  // dust motes drifting in the beam
  const DUST_N = 220;
  const dustPos = new Float32Array(DUST_N * 3);
  for (let i = 0; i < DUST_N; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * 1.25;
    dustPos[i * 3] = Math.cos(a) * r;
    dustPos[i * 3 + 1] = 0.8 + Math.random() * 1.5;
    dustPos[i * 3 + 2] = Math.sin(a) * r;
  }
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
  const dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({
    map: glowSprite(), size: 0.012, transparent: true, opacity: 0.5,
    blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
  }));
  dust.renderOrder = 9;
  scene.add(dust);

  // wall sconces: emissive panel + small point light
  const sconcePanel = new THREE.MeshStandardMaterial({
    color: 0x332211, emissive: 0xffb45e, emissiveIntensity: 1.6, roughness: 0.6,
  });
  const sconceBody = new THREE.MeshStandardMaterial({ color: 0x1a1512, roughness: 0.5, metalness: 0.5 });
  for (const [px, pz, ry] of [
    [-2.2, -ROOM.hz + 0.02, 0], [2.2, -ROOM.hz + 0.02, 0],
    [-2.2, ROOM.hz - 0.02, Math.PI], [2.2, ROOM.hz - 0.02, Math.PI],
  ]) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.3, 0.05), sconceBody);
    g.add(body);
    const panel = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.22, 0.02), sconcePanel);
    panel.position.z = 0.03;
    panel.layers.enable(1);
    g.add(panel);
    const pl = new THREE.PointLight(0xffb45e, 2.2, 3.2, 2);
    pl.position.z = 0.15;
    g.add(pl);
    g.position.set(px, 1.9, pz);
    g.rotation.y = ry;
    g.visible = SHOW_SET;
    scene.add(g);
  }

  // neon sign: procedural canvas, no font assets needed
  const neonC = document.createElement('canvas');
  neonC.width = 512; neonC.height = 160;
  const nctx = neonC.getContext('2d');
  nctx.fillStyle = '#000';
  nctx.fillRect(0, 0, 512, 160);
  nctx.font = 'italic bold 92px "Snell Roundhand", cursive';
  nctx.textAlign = 'center';
  nctx.textBaseline = 'middle';
  nctx.lineJoin = 'round';
  // tube-style neon: layered strokes — wide soft halo, mid glow, hot core
  for (const [blur, w, alpha] of [[42, 10, .35], [22, 6, .7], [10, 3, 1]]) {
    nctx.shadowColor = '#ffb02e';
    nctx.shadowBlur = blur;
    nctx.strokeStyle = `rgba(255, 224, 160, ${alpha})`;
    nctx.lineWidth = w;
    nctx.strokeText('Club No.9', 256, 84);
  }
  const neonTex = new THREE.CanvasTexture(neonC);
  neonTex.colorSpace = THREE.SRGBColorSpace;
  const neon = new THREE.Mesh(
    new THREE.PlaneGeometry(1.7, 0.53),
    new THREE.MeshStandardMaterial({
      map: neonTex, emissive: 0xffffff, emissiveMap: neonTex, emissiveIntensity: 1.0,
      transparent: true, roughness: 0.7,
    })
  );
  neon.layers.enable(1);
  neon.position.set(2.75, 2.0, -0.7); // flush on the enclosure right wall
  neon.rotation.y = -Math.PI / 2;
  neon.scale.setScalar(1.35);
  scene.add(neon);
  const neonLight = new THREE.PointLight(0xffb02e, 1.6, 2.6, 2);
  neonLight.position.set(2.48, 2.0, -0.7);
  scene.add(neonLight);

  // window with blinds (emissive slats) on the left wall
  const blindC = document.createElement('canvas');
  blindC.width = 64; blindC.height = 128;
  const bctx = blindC.getContext('2d');
  bctx.fillStyle = '#000'; bctx.fillRect(0, 0, 64, 128);
  bctx.fillStyle = '#ffe3b0';
  for (let y = 6; y < 128; y += 12) bctx.fillRect(4, y, 56, 5);
  const blindTex = new THREE.CanvasTexture(blindC);
  blindTex.colorSpace = THREE.SRGBColorSpace;
  const blinds = new THREE.Mesh(
    new THREE.PlaneGeometry(0.8, 1.5),
    new THREE.MeshStandardMaterial({
      map: blindTex, emissive: 0xffffff, emissiveMap: blindTex, emissiveIntensity: 0.85, roughness: 0.8,
    })
  );
  blinds.layers.enable(1);
  blinds.position.set(-ROOM.hx + 0.02, 1.8, -1.1);
  blinds.rotation.y = Math.PI / 2;
  blinds.visible = SHOW_SET;
  scene.add(blinds);

  // bar stools in a corner for depth
  const stoolMat = new THREE.MeshStandardMaterial({ color: 0x1c1410, roughness: 0.6 });
  for (const [sx, sz] of [[-3.4, 2.6], [-2.8, 2.75]]) {
    const legM = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.75, 10), stoolMat);
    legM.position.set(sx, 0.375, sz);
    const seat = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.19, 0.07, 20), stoolMat);
    seat.position.set(sx, 0.78, sz);
    seat.castShadow = true;
    legM.visible = seat.visible = SHOW_SET;
    scene.add(legM, seat);
  }

  // cue rack on the right wall: walnut base + a row of house cues
  const rack = new THREE.Group();
  const rackBase = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.05, 0.09), walnut.dark);
  rackBase.position.y = 0.62;
  rack.add(rackBase);
  const rackTop = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.05, 0.09), walnut.dark);
  rackTop.position.y = 1.66;
  rack.add(rackTop);
  for (let i = 0; i < 5; i++) {
    const c = new THREE.Mesh(
      new THREE.CylinderGeometry(0.007, 0.012, 1.1, 10),
      walnut.rail
    );
    c.position.set(-0.2 + i * 0.1, 1.14, 0);
    rack.add(c);
  }
  rack.position.set(ROOM.hx - 0.06, 0, 1.15);
  rack.rotation.y = -Math.PI / 2;
  rack.traverse((o) => { o.castShadow = true; });
  rack.visible = SHOW_SET;
  scene.add(rack);

  // framed posters: procedural canvas art (triangle of balls / big 8 ball)
  function poster(draw) {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 340;
    const x = c.getContext('2d');
    x.fillStyle = '#12100d';
    x.fillRect(0, 0, 256, 340);
    draw(x);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    const g = new THREE.Group();
    const frame = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.82, 0.03), walnut.dark);
    g.add(frame);
    const art = new THREE.Mesh(
      new THREE.PlaneGeometry(0.54, 0.74),
      new THREE.MeshStandardMaterial({ map: t, roughness: 0.7 })
    );
    art.position.z = 0.02;
    g.add(art);
    return g;
  }
  const p1 = poster((x) => {
    // triangle of balls
    const cols = ['#f6c700', '#0b4ea2', '#d42b1e', '#5b2a86', '#f07d00', '#0d6e3f'];
    let k = 0;
    for (let r = 0; r < 3; r++)
      for (let j = 0; j <= r; j++) {
        x.fillStyle = cols[k++ % cols.length];
        x.beginPath();
        x.arc(128 + (j - r / 2) * 52, 120 + r * 46, 23, 0, 7);
        x.fill();
      }
    x.fillStyle = 'rgba(232,226,213,.85)';
    x.font = '20px Georgia';
    x.textAlign = 'center';
    x.fillText('ONE CUE CLUB', 128, 290);
  });
  p1.position.set(-1.35, 1.85, -ROOM.hz + 0.03);
  p1.visible = SHOW_SET;
  scene.add(p1);
  const p2 = poster((x) => {
    // big 8 ball
    x.fillStyle = '#191919';
    x.beginPath(); x.arc(128, 150, 82, 0, 7); x.fill();
    x.fillStyle = '#f8f6f0';
    x.beginPath(); x.arc(128, 150, 38, 0, 7); x.fill();
    x.fillStyle = '#111';
    x.font = 'bold 44px Arial';
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText('8', 128, 152);
    x.fillStyle = 'rgba(232,226,213,.7)';
    x.font = '16px Georgia';
    x.fillText('LUCKY BREAK', 128, 290);
  });
  p2.position.set(-ROOM.hx + 0.03, 1.8, 1.5);
  p2.rotation.y = Math.PI / 2;
  p2.visible = SHOW_SET;
  scene.add(p2);

  // --- lights ---
  scene.add(new THREE.HemisphereLight(0xfff4e0, 0x1a140e, 0.25));

  const key = new THREE.SpotLight(0xfff2dd, 78, 0, 0.62, 0.45, 1.6);
  key.position.set(0, 2.38, 0); // from the lamp shade
  key.target = table;
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.bias = -0.0004;
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 6;
  scene.add(key);

  for (const [x, z, i] of [[-2.2, 1.6, 24], [2.2, -1.6, 24], [2.2, 1.6, 14], [-2.2, -1.6, 14]]) {
    const fill = new THREE.SpotLight(0xffe8cc, i, 0, 0.9, 0.7, 1.8);
    fill.position.set(x, 2.6, z);
    fill.target = table;
    scene.add(fill);
  }

  // cool rim accent: warm/cool contrast is what makes it read "cinematic"
  const rim = new THREE.SpotLight(0x9fb8ff, 9, 0, 0.8, 0.6, 1.8);
  rim.position.set(-3.4, 2.2, -2.4);
  rim.target = table;
  scene.add(rim);

  // --- balls ---
  const ballGeo = new THREE.SphereGeometry(BALL_R, 48, 32);
  const ballMeshes = new Map();
  for (let id = 0; id <= 15; id++) {
    const mat = new THREE.MeshPhysicalMaterial({
      map: ballTexture(id),
      roughness: 0.14,
      clearcoat: 0.85,
      clearcoatRoughness: 0.12,
      envMapIntensity: 0.5,
    });
    const m = new THREE.Mesh(ballGeo, mat);
    m.castShadow = m.receiveShadow = true;
    m.visible = false;
    table.add(m); // child of table: sim coordinates map directly (surface y=0)
    ballMeshes.set(id, m);
  }

  // --- cue stick (walnut shaft) ---
  const cue = new THREE.Group();
  const shaft = new THREE.Mesh(
    new THREE.CylinderGeometry(0.0065, 0.0135, 1.45, 20),
    walnut.rail.clone()
  );
  shaft.rotation.x = Math.PI / 2; // along +z, tip at +z end
  shaft.position.z = -1.45 / 2;
  cue.add(shaft);
  const tip = new THREE.Mesh(
    new THREE.CylinderGeometry(0.0068, 0.0065, 0.012, 16),
    new THREE.MeshStandardMaterial({ color: 0x3a66b0, roughness: 0.8 })
  );
  tip.rotation.x = Math.PI / 2;
  tip.position.z = 0.006;
  cue.add(tip);
  const butt = new THREE.Mesh(
    new THREE.CylinderGeometry(0.0145, 0.0155, 0.06, 20),
    new THREE.MeshStandardMaterial({ color: 0x1c0f08, roughness: 0.4 })
  );
  butt.rotation.x = Math.PI / 2;
  butt.position.z = -1.45 - 0.03;
  cue.add(butt);
  cue.traverse((o) => { o.castShadow = true; });
  cue.visible = false;
  scene.add(cue); // in world space (not table space) for easier aiming math

  // --- aim graphics: center line, corridor, object path, cue path preview ---
  // Ribbons (thin boxes) instead of GL lines: 1 px lines vanish against the
  // pale cloth; ribbons have real world-space width.
  function makeRibbon(color, opacity) {
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(1, 0.0012, 1),
      new THREE.MeshBasicMaterial({
        color, transparent: true, opacity, depthWrite: false,
      })
    );
    m.renderOrder = 5;
    m.visible = false;
    table.add(m);
    return m;
  }
  // The main aim line needs to stay legible on both pale cloth and dark rails.
  // A slim dark underlay gives the warm-gold core a crisp, high-contrast edge.
  function makeAimRibbon() {
    const group = new THREE.Group();
    const underlay = new THREE.Mesh(
      new THREE.BoxGeometry(1, 0.0012, 1.8),
      new THREE.MeshBasicMaterial({
        color: 0x17352d, transparent: true, opacity: 0.82,
        depthWrite: false, toneMapped: false,
      })
    );
    const core = new THREE.Mesh(
      new THREE.BoxGeometry(1, 0.0014, 1),
      new THREE.MeshBasicMaterial({
        color: 0xffd58a, transparent: true, opacity: 0.98,
        depthWrite: false, toneMapped: false,
      })
    );
    core.position.y = 0.0012;
    underlay.renderOrder = 5;
    core.renderOrder = 6;
    group.add(underlay, core);
    group.visible = false;
    table.add(group);
    return group;
  }
  const aimLine = makeAimRibbon();
  const corridorA = makeRibbon(0xfff6d8, 0.35);
  const corridorB = makeRibbon(0xfff6d8, 0.35);
  const corridor = {
    visible: false,
    a: corridorA,
    b: corridorB,
  };
  const objPath = makeRibbon(0x9fe08a, 0.9);
  const cuePath = makeRibbon(0x8ab8ff, 0.95);

  const ghost = new THREE.Mesh(
    new THREE.RingGeometry(BALL_R * 0.8, BALL_R * 1.1, 32),
    new THREE.MeshBasicMaterial({ color: 0xfff6d8, transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false })
  );
  ghost.rotation.x = -Math.PI / 2;
  ghost.renderOrder = 5;
  ghost.visible = false;
  table.add(ghost);

  // the traditional model replaces all procedural table visuals; our balls
  // (SphereGeometry) and aim graphics (plain transparent, no alphaTest) stay
  table.traverse((o) => {
    if (!o.isMesh || o.geometry.type === 'SphereGeometry') return;
    if (o.material && o.material.transparent && !(o.material.alphaTest > 0)) return;
    o.visible = false;
  });

  return {
    scene, table, ballMeshes, cue,
    aimLine, corridor, objPath, cuePath, ghost,
    dust, lightCone, key,
  };
}

/** Copy sim state into meshes. Balls falling into pockets are rendered by
 * physics; only rested (landed) balls are hidden. */
export function syncBalls(world, state) {
  for (const s of state) {
    const mesh = world.ballMeshes.get(s.id);
    if (!mesh) continue;
    if (s.rested) { mesh.visible = false; continue; }
    mesh.visible = true;
    mesh.scale.setScalar(1);
    mesh.position.set(s.pos.x, s.pos.y, s.pos.z);
    mesh.quaternion.set(s.rot.x, s.rot.y, s.rot.z, s.rot.w);
  }
}
