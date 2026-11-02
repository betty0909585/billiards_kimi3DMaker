// textures.js — procedural canvas textures. All self-generated, no external
// assets, no licensing surface (contract section 8).

import * as THREE from 'three';

function canvas(n) {
  const c = document.createElement('canvas');
  c.width = c.height = n;
  return [c, c.getContext('2d')];
}

// small deterministic PRNG so textures look identical every load
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function clothTextures() {
  const N = 1024;
  const [c, ctx] = canvas(N);
  const rnd = mulberry32(42);

  ctx.fillStyle = '#033017';
  ctx.fillRect(0, 0, N, N);

  // fine nap speckle
  const img = ctx.getImageData(0, 0, N, N);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rnd() - 0.5) * 26;
    d[i] += n; d[i + 1] += n; d[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);

  // directional nap streaks
  ctx.globalAlpha = 0.05;
  for (let i = 0; i < 900; i++) {
    const y = rnd() * N;
    const w = 30 + rnd() * 120;
    ctx.fillStyle = rnd() > 0.5 ? '#032a14' : '#074a24';
    ctx.fillRect(rnd() * N, y, w, 1);
  }
  ctx.globalAlpha = 1;

  // slight wear darkening near the pockets (texture corners + mid edges)
  for (const [px, py] of [[0, 0], [N, 0], [0, N], [N, N], [N / 2, 0], [N / 2, N]]) {
    const g = ctx.createRadialGradient(px, py, 0, px, py, N * 0.09);
    g.addColorStop(0, 'rgba(0,0,0,0.28)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, N, N);
  }

  const map = new THREE.CanvasTexture(c);
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 8;

  // bump from the same speckle, softened
  const [cb, ctxb] = canvas(512);
  const rndb = mulberry32(43);
  ctxb.fillStyle = '#808080';
  ctxb.fillRect(0, 0, 512, 512);
  const imgB = ctxb.getImageData(0, 0, 512, 512);
  const db = imgB.data;
  for (let i = 0; i < db.length; i += 4) {
    const n = (rndb() - 0.5) * 34;
    db[i] += n; db[i + 1] += n; db[i + 2] += n;
  }
  ctxb.putImageData(imgB, 0, 0);
  const bump = new THREE.CanvasTexture(cb);
  bump.wrapS = bump.wrapT = THREE.RepeatWrapping;

  return { map, bump };
}

export function woodTexture(dark = false) {
  const N = 512;
  const [c, ctx] = canvas(N);
  const rnd = mulberry32(dark ? 7 : 8);
  const base = dark ? [40, 23, 13] : [58, 33, 18];

  ctx.fillStyle = `rgb(${base[0]},${base[1]},${base[2]})`;
  ctx.fillRect(0, 0, N, N);

  // long grain streaks
  for (let i = 0; i < 220; i++) {
    const y = rnd() * N;
    const amp = 2 + rnd() * 6;
    const shade = (rnd() - 0.5) * 40;
    ctx.strokeStyle = `rgba(${base[0] + shade},${base[1] + shade * 0.7},${base[2] + shade * 0.5},0.5)`;
    ctx.lineWidth = 0.6 + rnd() * 1.8;
    ctx.beginPath();
    for (let x = 0; x <= N; x += 8) {
      ctx.lineTo(x, y + Math.sin(x / 60 + i) * amp);
    }
    ctx.stroke();
  }
  // sparse knots
  for (let i = 0; i < 5; i++) {
    const x = rnd() * N, y = rnd() * N;
    const g = ctx.createRadialGradient(x, y, 0, x, y, 8 + rnd() * 14);
    g.addColorStop(0, 'rgba(30,16,8,0.7)');
    g.addColorStop(1, 'rgba(30,16,8,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, N, N);
  }

  const map = new THREE.CanvasTexture(c);
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 8;
  return map;
}

export const BALL_COLORS = {
  1: '#f6c700', 2: '#0b4ea2', 3: '#d42b1e', 4: '#5b2a86',
  5: '#f07d00', 6: '#0d6e3f', 7: '#7c211a', 8: '#191919',
};

/** Face texture for one ball: base color (+stripe for 9-15), white circle, number. */
export function ballTexture(id) {
  if (id === 0) {
    const [c, ctx] = canvas(256);
    ctx.fillStyle = '#f8f6f0';
    ctx.fillRect(0, 0, 256, 256);
    // single red "measles" dot so spin/roll is readable
    const rnd = mulberry32(99);
    {
      const dx = 128, dy = 42;
      ctx.fillStyle = '#d42b1e';
      ctx.beginPath();
      ctx.arc(dx, dy, 13, 0, 7);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.beginPath();
      ctx.arc(dx - 4, dy - 4, 4, 0, 7);
      ctx.fill();
    }
    // faint chalk specks
    ctx.fillStyle = 'rgba(120,140,180,0.22)';
    for (let i = 0; i < 10; i++) {
      ctx.beginPath();
      ctx.arc(rnd() * 256, rnd() * 256, 1.5 + rnd() * 2.5, 0, 7);
      ctx.fill();
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  const N = 512;
  const [c, ctx] = canvas(N);
  const color = BALL_COLORS[id > 8 ? id - 8 : id];
  const stripe = id > 8;

  ctx.fillStyle = '#f8f6f0';
  ctx.fillRect(0, 0, N, N);
  if (stripe) {
    ctx.fillStyle = color;
    ctx.fillRect(0, N * 0.28, N, N * 0.44);
  } else {
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, N, N);
  }

  // number circles on both hemispheres (texture wraps the sphere)
  for (const cx of [N * 0.25, N * 0.75]) {
    ctx.fillStyle = '#f8f6f0';
    ctx.beginPath();
    ctx.arc(cx, N / 2, N * 0.11, 0, 7);
    ctx.fill();
    ctx.fillStyle = '#111';
    ctx.font = `bold ${N * 0.13}px Arial, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(id), cx, N / 2 + N * 0.005);
  }

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

export function floorTexture() {
  const N = 512;
  const [c, ctx] = canvas(N);
  const rnd = mulberry32(21);
  ctx.fillStyle = '#141210';
  ctx.fillRect(0, 0, N, N);
  const img = ctx.getImageData(0, 0, N, N);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rnd() - 0.5) * 14;
    d[i] += n; d[i + 1] += n; d[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(8, 8);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Dark glossy wood planks for the hall floor. */
export function plankFloorTextures() {
  const N = 1024;
  const [c, ctx] = canvas(N);
  const rnd = mulberry32(77);
  const rows = 6;
  const rh = N / rows;
  for (let r = 0; r < rows; r++) {
    let x = -Math.floor(rnd() * 200);
    while (x < N) {
      const w = 180 + rnd() * 220;
      const tone = 26 + rnd() * 22;
      ctx.fillStyle = `rgb(${tone + 10},${tone * 0.72},${tone * 0.5})`;
      ctx.fillRect(x, r * rh, w - 3, rh - 3);
      // grain
      ctx.globalAlpha = 0.12;
      for (let g = 0; g < 14; g++) {
        const gy = r * rh + rnd() * rh;
        ctx.strokeStyle = rnd() > 0.5 ? '#000' : '#5a4028';
        ctx.lineWidth = 0.8 + rnd();
        ctx.beginPath();
        ctx.moveTo(x, gy);
        ctx.bezierCurveTo(x + w * 0.3, gy + 3, x + w * 0.6, gy - 3, x + w, gy + 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      x += w;
    }
  }
  // plank gaps
  ctx.fillStyle = 'rgba(0,0,0,0.85)';
  for (let r = 0; r <= rows; r++) ctx.fillRect(0, r * rh - 1, N, 3);

  const map = new THREE.CanvasTexture(c);
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.repeat.set(2.5, 2.5);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 8;

  // roughness: mostly glossy, grain lines rougher
  const [cr, ctxr] = canvas(512);
  ctxr.fillStyle = '#3c3c3c';
  ctxr.fillRect(0, 0, 512, 512);
  const rr = mulberry32(78);
  for (let i = 0; i < 260; i++) {
    ctxr.fillStyle = `rgba(255,255,255,${0.04 + rr() * 0.1})`;
    ctxr.fillRect(rr() * 512, rr() * 512, 2 + rr() * 40, 1 + rr() * 3);
  }
  const rough = new THREE.CanvasTexture(cr);
  rough.wrapS = rough.wrapT = THREE.RepeatWrapping;
  rough.repeat.copy(map.repeat);
  return { map, rough };
}

/** Warm wall paint: vertical gradient + wall panels + baseboard. */
export function wallTexture() {
  const W = 1024, H = 512;
  const [c, ctx] = canvas(1024);
  c.width = W; c.height = H;
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#160f0a');
  g.addColorStop(0.55, '#241710');
  g.addColorStop(0.85, '#2c1d13');
  g.addColorStop(1, '#1a110b');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // panel rectangles (wainscot style), subtle
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 3;
  for (let i = 0; i < 5; i++) {
    const x = 30 + i * 200;
    ctx.strokeRect(x, H * 0.58, 160, H * 0.32);
    ctx.strokeRect(x + 6, H * 0.58 + 6, 148, H * 0.32 - 12);
  }
  // baseboard
  ctx.fillStyle = '#0d0906';
  ctx.fillRect(0, H * 0.94, W, H * 0.06);
  ctx.fillStyle = 'rgba(255,255,255,0.05)';
  ctx.fillRect(0, H * 0.94, W, 2);

  // faint noise
  const rnd = mulberry32(55);
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rnd() - 0.5) * 7;
    d[i] += n; d[i + 1] += n; d[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);

  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** Radial gradient sprite for dust motes. */
export function glowSprite() {
  const N = 64;
  const [c, ctx] = canvas(N);
  const g = ctx.createRadialGradient(N / 2, N / 2, 0, N / 2, N / 2, N / 2);
  g.addColorStop(0, 'rgba(255,240,210,1)');
  g.addColorStop(0.4, 'rgba(255,240,210,0.35)');
  g.addColorStop(1, 'rgba(255,240,210,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, N, N);
  return new THREE.CanvasTexture(c);
}

/** Hand-painted warm umber planks, matched to the Bar Diorama walls. */export function dioramaWoodTexture() {
  const N = 1024;
  const [c, ctx] = canvas(N);
  const rnd = mulberry32(131);
  ctx.fillStyle = '#50301c';
  ctx.fillRect(0, 0, N, N);

  // vertical planks with hand-painted wobble
  const planks = 7;
  const pw = N / planks;
  for (let p = 0; p < planks; p++) {
    const tone = 0.9 + rnd() * 0.25;
    ctx.fillStyle = `rgb(${Math.round(84 * tone)},${Math.round(50 * tone)},${Math.round(29 * tone)})`;
    ctx.fillRect(p * pw + 2, 0, pw - 4, N);
    // long grain streaks, slightly wavy like the diorama's painted wood
    ctx.globalAlpha = 0.16;
    for (let g = 0; g < 22; g++) {
      const gx = p * pw + 4 + rnd() * (pw - 8);
      ctx.strokeStyle = rnd() > 0.55 ? '#2c1a0e' : '#7c4f30';
      ctx.lineWidth = 1 + rnd() * 2.2;
      ctx.beginPath();
      ctx.moveTo(gx, 0);
      ctx.bezierCurveTo(gx + 6, N * 0.3, gx - 6, N * 0.6, gx + 3, N);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // plank gaps
    ctx.fillStyle = '#221207';
    ctx.fillRect(p * pw - 2, 0, 4, N);
    // occasional knots
    if (rnd() > 0.5) {
      const kx = p * pw + pw / 2, ky = rnd() * N;
      const kg = ctx.createRadialGradient(kx, ky, 1, kx, ky, 9 + rnd() * 8);
      kg.addColorStop(0, 'rgba(30,16,8,0.8)');
      kg.addColorStop(1, 'rgba(30,16,8,0)');
      ctx.fillStyle = kg;
      ctx.fillRect(kx - 20, ky - 20, 40, 40);
    }
  }
  // darker wainscot band at the bottom, like the diorama's base panels
  ctx.fillStyle = 'rgba(30,17,9,0.55)';
  ctx.fillRect(0, N * 0.78, N, N * 0.22);
  ctx.fillStyle = 'rgba(255,220,170,0.08)';
  ctx.fillRect(0, N * 0.78, N, 3);

  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** Woven pocket net: diagonal dark weave on transparent background. */
export function netTexture() {
  const N = 128;
  const [c, ctx] = canvas(N);
  ctx.clearRect(0, 0, N, N);
  ctx.strokeStyle = '#241a10';
  ctx.lineWidth = 2.4;
  ctx.lineCap = 'round';
  const step = 14;
  for (const dir of [1, -1]) {
    for (let i = -N; i < N * 2; i += step) {
      ctx.beginPath();
      // slightly irregular hand-woven feel
      ctx.moveTo(i, dir > 0 ? 0 : N);
      ctx.quadraticCurveTo(i + dir * N * 0.52, N * 0.48, i + dir * N, dir > 0 ? N : 0);
      ctx.stroke();
    }
  }
  // knot dots at intersections
  ctx.fillStyle = '#1a120a';
  for (let x = 0; x < N; x += step) {
    for (let y = 0; y < N; y += step) {
      ctx.beginPath();
      ctx.arc(x + 2, y + 2, 1.6, 0, 7);
      ctx.fill();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(6, 2.5);
  return t;
}
