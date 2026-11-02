// main.js — boot, fixed-timestep loop, first-person state machine, HUD.
// State machine: walk -> aim -> (charge) -> rolling -> aim.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import {
  initRapier, createSim, RAPIER, BALL_R, TABLE_HX, TABLE_HZ, MAX_V, DT,
} from './sim.js';
import { createWorld, syncBalls, TABLE_Y } from './world.js';
import { createAudio } from './audio.js';
import { BALL_COLORS } from './textures.js';
import { createDarts, BOARD_C } from './darts3d.js';
import { solveLaunch, spread, createRound, predictHit } from './darts.js';
import { createBarGames, STOOLS } from './bargames.js';

await initRapier();

// ---------------------------------------------------------------- setup
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setSize(innerWidth, innerHeight);
const DPR_STEPS = [Math.min(devicePixelRatio, 2), 1.5, 1.25, 1];
let dprIdx = 0;
renderer.setPixelRatio(DPR_STEPS[0]);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.98;
document.getElementById('app').appendChild(renderer.domElement);

const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.02, 30);

// --- post-processing: SELECTIVE bloom (only emissives: neon/lamp/sconces) ---
// Recipe from three.js selective bloom: render bloom layer with everything
// else darkened, then additively mix over the base render.
const BLOOM_LAYER = 1;
camera.layers.enable(BLOOM_LAYER);

const bloomComposer = new EffectComposer(renderer);
bloomComposer.renderToScreen = false;
bloomComposer.addPass(new RenderPass(null, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.9, 0.5, 0.55);
bloomComposer.addPass(bloom);

const finalComposer = new EffectComposer(renderer);
finalComposer.addPass(new RenderPass(null, camera));
const mixPass = new ShaderPass({
  uniforms: {
    tDiffuse: { value: null },
    bloomTexture: { value: bloomComposer.renderTarget2.texture },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform sampler2D bloomTexture;
    varying vec2 vUv;
    void main() {
      gl_FragColor = texture2D(tDiffuse, vUv) + texture2D(bloomTexture, vUv);
    }`,
});
finalComposer.addPass(mixPass);
const vignette = new ShaderPass({
  uniforms: { tDiffuse: { value: null }, strength: { value: 0.38 } },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float strength;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      float d = distance(vUv, vec2(0.5, 0.46));
      c.rgb *= 1.0 - strength * smoothstep(0.42, 0.86, d);
      gl_FragColor = c;
    }`,
});
finalComposer.addPass(vignette);
finalComposer.addPass(new OutputPass());

const bloomLayerTest = new THREE.Layers();
bloomLayerTest.set(BLOOM_LAYER);
const darkMaterial = new THREE.MeshBasicMaterial({ color: 0x000000 });
const darkened = {};
function darkenNonBloomed(obj) {
  if (obj.material && !bloomLayerTest.test(obj.layers)) {
    darkened[obj.uuid] = obj.material;
    obj.material = darkMaterial;
  }
}
function restoreMaterial(obj) {
  if (darkened[obj.uuid]) {
    obj.material = darkened[obj.uuid];
    delete darkened[obj.uuid];
  }
}
function renderFrame() {
  world.scene.traverse(darkenNonBloomed);
  bloomComposer.render();
  world.scene.traverse(restoreMaterial);
  finalComposer.render();
}

const world = createWorld(renderer);
bloomComposer.passes[0].scene = world.scene;
finalComposer.passes[0].scene = world.scene;
const audio = createAudio();
const darts3d = createDarts(world.scene);
const barGames = createBarGames(world.scene, RAPIER, {
  camera, audio,
  t: (k, ...a) => t(k, ...a),
  toast: (msg, ms) => toast(msg, ms),
  badge: (title, metric, big) => showBadge(title, metric, big),
  rumble,
  showBar: (text) => { el('bar-ui').textContent = text; },
  veil: document.getElementById('veil'),
});

let sim = createSim();
let shots = 0;

// ---------------------------------------------------------------- HUD
const el = (id) => document.getElementById(id);
const ui = {
  mode: el('mode'), hint: el('hint'), shots: el('shots'), potted: el('potted'),
  fps: el('fps'), crosshair: el('crosshair'), aimUI: el('aim-ui'),
  power: el('power'), spinpad: el('spinpad'), toast: el('toast'), overlay: el('overlay'),
  scoreboard: el('scoreboard'), pcards: [el('p1'), el('p2')],
};
const spinCtx = ui.spinpad.getContext('2d');

// ---------------------------------------------------------------- i18n
const I18N = {
  zh: {
    docTitle: '九号俱乐部 · 第一人称物理台球',
    ovTitle: '九号俱乐部', ovSub: 'CLUB No.9 · 第一人称物理台球',
    ovFlavor: '灯已点上,球已摆好——今晚谁开球?',
    start: '开始游戏', resume: '继续游戏', settings: '设置', back: '返回',
    langLabel: '语言', potcamLabel: '进球特写', guidesLabel: '辅助瞄准线', on: '开', off: '关',
    gear: '设置', controlsLink: '操作指南', mute: '静音', mutedState: '已静音',
    aboutSub: '开源材质与许可', backText: '返回', backToSettings: '返回设置',
    onState: '开启', offState: '关闭',
    about: '关于',
    credits: [
      ['场景', 'Bar Diorama — Ethica (CC-BY 4.0)'],
      ['球桌', 'Pool Table Traditional — fizyman (CC-BY 4.0)'],
      ['左轮', 'Revolver - Kaliber .357 Magnum — the_table (CC-BY 4.0)'],
      ['骰盅', 'Dice Game — max_imum (CC-BY 4.0)'],
      ['音效', 'Freesound 社区 (CC0)'],
      ['音乐', 'Retro Jazz - Midnight Lounge — vellumlounge (Pixabay)'],
      ['材质', 'Poly Haven (CC0)'],
      ['图标', 'Tabler Icons (MIT)'],
      ['字体', 'ZCOOL 青扣黄油 (OFL)'],
    ],
    touchNote: '触屏设备:已进入观战模式(桌面端可完整游玩)',
    keysL: [['WASD', '移动'], ['E', '俯身瞄准'], ['左键', '蓄力击球'], ['滚轮', '调力度'], ['空格', '出杆'], ['A/D', '加塞'], ['W/S', '高低杆']],
    keysR: [['R', '复位杆法'], ['F', '摆自由球'], ['V', '回放'], ['T', '重新摆球'], ['G', '比赛/练习'], ['M', '静音']],
    keysDarts: [['走近飞镖盘 E', '玩飞镖'], ['鼠标', '瞄准'], ['左键', '按住蓄力 松开出镖'], ['E', '起身离开']],
    modeDarts: '飞镖模式', hintDarts: '鼠标瞄准 · 按住左键蓄力 松开出镖 · 力度越足抛物线越平 · E 起身',
    hintDartsNear: '按 E 玩飞镖',
    dartMiss: '脱靶', dartNewBest: '新纪录',
    dartsRound: (n) => `本轮 ${n}`, dartsBest: (n) => `最佳轮 ${n}`,
    dartsRoundScore: (n) => `本轮得分 ${n}`,
    dartLabel: ({ ring, sector, score }) =>
      ring === 'miss' ? '脱靶'
      : ring === 'inner-bull' ? '内牛眼 · 50'
      : ring === 'outer-bull' ? '外牛眼 · 25'
      : ring === 'treble' ? `三倍 ${sector} · ${score}`
      : ring === 'double' ? `双倍 ${sector} · ${score}`
      : `${sector} 分`,
    b180T: 'ONE EIGHTY!', b180M: '三镖满环 180 分', bTonT: '单轮破百',
    hintDiceNear: '按 E 玩骰子', hintRouNear: '按 E 俄罗斯转盘',
    modeDice: '骰子 · 比大小', hintDice: '左键 / 空格 摇骰 · 三局两胜 · E 起身',
    diceIdle: '左键开摇 · 三局两胜',
    diceScore: (pw, hw) => `局分 ${pw} - ${hw}`, diceLast: (p, h) => `你 ${p} : ${h} 庄家`,
    diceWinRound: '拿下本局', diceLoseRound: '丢掉本局', diceDrawRound: '本局打平',
    diceMatchWin: '比大小 · 你赢了', diceMatchLose: '比大小 · 庄家赢',
    modeRoulette: '俄罗斯转盘', hintRoulette: '左键 转轮并扣动扳机 · E 起身',
    rouStreak: (n) => `连生 ×${n}`, rouBest: (n) => `最佳 ${n}`,
    rouSurvive: (n) => `空枪 · 连生 ×${n}`,
    rouWake: '……你在吧台边醒来,仿佛做了个梦',
    spinLabel: '杆法',
    keysTitle: '操作指南',
    modeWalk: '行走模式', modeAim: '瞄准模式', modeRolling: '球运动中',
    modeReplay: '回放模式', modePlace: '摆放母球', modeSpectator: '观战模式',
    hintWalk: 'WASD 移动 · E 俯身瞄准 · T 重新摆球',
    hintAim: '鼠标瞄准 · 按住左键蓄力松开击球 / 滚轮调力度空格出杆 · A/D 加塞 W/S 高低杆 · E 起身',
    hintPlace: 'WASD 移动母球 · F / E / 左键 确认落位',
    hintSpectator: '桌面浏览器打开可完整游玩',
    hintReplay: '拖拽旋转 · 滚轮缩放 · V/ESC 退出',
    hintReplaySuffix: ' · 按 V 回放上一杆',
    notSettled: '球未停稳', respot: '母球洗袋,重新置球',
    rerack: '重新摆球', rerackMatch: '重新摆球 · 玩家1 开球',
    matchMode: '比赛模式 · 玩家1 开球', practice: '自由练习模式',
    potcamOn: '进球特写:开', potcamOff: '进球特写:关',
    muted: '静音', soundOn: '声音开启',
    potcamToast: '进球特写 · 任意键跳过', clickContinue: '点击画面继续',
    noFreeBall: '现在没有自由球可摆',
    player1: '玩家1', player2: '玩家2',
    undecided: '未分色', solid: '全色', stripe: '花色', onEight: '目标黑8',
    win: (n) => `${n} 获胜`, winLegal: '合法打进黑8', winScratch8: '打黑8时母球洗袋', winEarly8: '黑8提前落袋',
    assign: (n, g) => `${n} 选定${g}球`, switchTo: (n) => `换 ${n}`, continuePlay: '继续击球',
    foul: (r, n) => `犯规:${r} · ${n} 自由球(F 摆放)`,
    foulScratch: '母球洗袋', foulNoContact: '空杆未碰球', foulEightFirst: '先碰黑8', foulWrongFirst: '先碰对方球',
    break8: '开球进黑8 · 黑8重置回置球点',
    streakN: (n) => `连击 ×${n}`,
    shots: (n) => `击球 ${n}`, potted: (n) => `进球 ${n}`,
    bClearT: '清台!', bClearM: '十五颗球全部落袋',
    bEscapePotT: '解球有下', bEscapePotM: '翻库解球并进球',
    bTripleT: '一杆三连星', bDoubleT: '一杆双响', bShotsInOne: (n) => `单杆 ${n} 球`,
    bBreakRunT: '开球连下', bBreakPots: (n) => `开球进 ${n} 球`,
    bExtremeCutT: '极限薄球', bFineCutT: '大角度薄球', bCutAngle: (a) => `切球角 ${a}°`,
    bBankT: '翻袋进球', bBankM: '目标球吃库后落袋',
    bComboT: '组合传球', bComboM: '借力完成进球',
    bBreakPotT: '开球有下',
    bLongT: '长台命中', bLongDist: (d) => `距离 ${d}m`,
    bDrawT: '拉杆回位', bDrawDist: (d) => `回拉 ${d}m`,
    bFollowT: '高杆跟进', bFollowDist: (d) => `跟进 ${d}m`,
    bCenterT: '中心进袋', bCenterM: '正中袋心',
    bEdgeT: '擦边入袋', bEdgeM: '袋口边缘擦进',
    bRailT: '翻库解球', bRailM: '母球吃库后命中',
    bGodlikeT: '神仙打球', bOnFireT: '火力全开',
  },
  en: {
    docTitle: 'CLUB No.9 · First-Person Physics Billiards',
    ovTitle: 'CLUB No.9', ovSub: 'First-Person Physics Billiards',
    ovFlavor: 'The lamp is lit, the rack is set — who breaks tonight?',
    start: 'START', resume: 'RESUME', settings: 'SETTINGS', back: 'BACK',
    langLabel: 'Language', potcamLabel: 'Pot close-up', guidesLabel: 'Aim guides', on: 'ON', off: 'OFF',
    gear: 'SETTINGS', controlsLink: 'CONTROLS', mute: 'Mute', mutedState: 'Muted',
    aboutSub: 'Open-source assets & licenses', backText: 'Back', backToSettings: 'Back to settings',
    onState: 'ON', offState: 'OFF',
    about: 'ABOUT',
    credits: [
      ['Scene', 'Bar Diorama — Ethica (CC-BY 4.0)'],
      ['Pool table', 'Pool Table Traditional — fizyman (CC-BY 4.0)'],
      ['Revolver', 'Revolver - Kaliber .357 Magnum — the_table (CC-BY 4.0)'],
      ['Dice cup', 'Dice Game — max_imum (CC-BY 4.0)'],
      ['Sound effects', 'Freesound community (CC0)'],
      ['Music', 'Retro Jazz - Midnight Lounge — vellumlounge (Pixabay Content License)'],
      ['Materials', 'Poly Haven (CC0)'],
      ['Icons', 'Tabler Icons (MIT)'],
      ['Typeface', 'ZCOOL QingKe HuangYou (OFL)'],
    ],
    touchNote: 'Touch device: spectating mode (play on desktop for full control)',
    keysL: [['WASD', 'Move'], ['E', 'Aim'], ['LMB', 'Charge/shoot'], ['Wheel', 'Power'], ['Space', 'Shoot'], ['A/D', 'English'], ['W/S', 'Follow/Draw']],
    keysR: [['R', 'Reset spin'], ['F', 'Ball in hand'], ['V', 'Replay'], ['T', 'Re-rack'], ['G', 'Match/Practice'], ['M', 'Mute']],
    keysDarts: [['Walk to board · E', 'Play darts'], ['Mouse', 'Aim'], ['LMB', 'Hold to charge, release to throw'], ['E', 'Step away']],
    modeDarts: 'DARTS', hintDarts: 'Mouse aim · hold LMB to charge, release to throw · more power = flatter arc · E step away',
    hintDartsNear: 'E — play darts',
    dartMiss: 'Off the board', dartNewBest: 'new best',
    dartsRound: (n) => `Round ${n}`, dartsBest: (n) => `Best ${n}`,
    dartsRoundScore: (n) => `Round score ${n}`,
    dartLabel: ({ ring, sector, score }) =>
      ring === 'miss' ? 'Off the board'
      : ring === 'inner-bull' ? 'Bullseye · 50'
      : ring === 'outer-bull' ? 'Outer bull · 25'
      : ring === 'treble' ? `Treble ${sector} · ${score}`
      : ring === 'double' ? `Double ${sector} · ${score}`
      : `${sector}`,
    b180T: 'ONE EIGHTY!', b180M: 'Maximum 180', bTonT: 'TON-PLUS ROUND',
    hintDiceNear: 'E — play dice', hintRouNear: 'E — russian roulette',
    modeDice: 'DICE · HIGH-LOW', hintDice: 'LMB / Space to roll · best of 3 · E step away',
    diceIdle: 'LMB to roll · best of 3',
    diceScore: (pw, hw) => `Match ${pw} - ${hw}`, diceLast: (p, h) => `you ${p} : ${h} house`,
    diceWinRound: 'round yours', diceLoseRound: 'round lost', diceDrawRound: 'round tied',
    diceMatchWin: 'High-low · you win', diceMatchLose: 'High-low · house wins',
    modeRoulette: 'RUSSIAN ROULETTE', hintRoulette: 'LMB spin & pull the trigger · E step away',
    rouStreak: (n) => `Lucky ×${n}`, rouBest: (n) => `best ${n}`,
    rouSurvive: (n) => `Click — lucky ×${n}`,
    rouWake: '…you wake up at the bar, as if it was a dream',
    spinLabel: 'SPIN',
    keysTitle: 'CONTROLS',
    modeWalk: 'WALK', modeAim: 'AIM', modeRolling: 'BALLS ROLLING',
    modeReplay: 'REPLAY', modePlace: 'PLACE CUE BALL', modeSpectator: 'SPECTATING',
    hintWalk: 'WASD move · E aim · T re-rack',
    hintAim: 'Mouse aim · hold LMB, release to shoot / wheel power, Space to shoot · A/D english · W/S follow-draw · E stand up',
    hintPlace: 'WASD move cue ball · F / E / LMB to confirm',
    hintSpectator: 'Open on a desktop browser for full play',
    hintReplay: 'Drag to orbit · wheel to zoom · V/ESC exit',
    hintReplaySuffix: ' · V to replay last shot',
    notSettled: 'Balls still rolling', respot: 'Scratch — cue ball re-spotted',
    rerack: 'Re-racked', rerackMatch: 'Re-racked · Player 1 breaks',
    matchMode: 'Match mode · Player 1 breaks', practice: 'Free practice',
    potcamOn: 'Pot close-up: ON', potcamOff: 'Pot close-up: OFF',
    muted: 'Muted', soundOn: 'Sound on',
    potcamToast: 'Pot close-up · any key to skip', clickContinue: 'Click to continue',
    noFreeBall: 'No ball in hand right now',
    player1: 'Player 1', player2: 'Player 2',
    undecided: 'open', solid: 'solids', stripe: 'stripes', onEight: 'on the 8',
    win: (n) => `${n} wins!`, winLegal: 'Clean 8-ball finish', winScratch8: 'Scratch on the 8', winEarly8: '8-ball down too early',
    assign: (n, g) => `${n} takes ${g}`, switchTo: (n) => `${n}'s turn`, continuePlay: 'plays on',
    foul: (r, n) => `Foul: ${r} · ball in hand for ${n} (F to place)`,
    foulScratch: 'scratch', foulNoContact: 'no contact', foulEightFirst: '8-ball first', foulWrongFirst: 'wrong ball first',
    break8: '8 off the break — re-spotted',
    streakN: (n) => `Streak ×${n}`,
    shots: (n) => `Shots ${n}`, potted: (n) => `Pots ${n}`,
    bClearT: 'TABLE CLEARED!', bClearM: 'All fifteen balls down',
    bEscapePotT: 'ESCAPE & POT', bEscapePotM: 'Rail escape, then a pot',
    bTripleT: 'TRIPLE!', bDoubleT: 'DOUBLE!', bShotsInOne: (n) => `${n} balls in one shot`,
    bBreakRunT: 'BREAK & RUN', bBreakPots: (n) => `${n} off the break`,
    bExtremeCutT: 'EXTREME CUT', bFineCutT: 'FINE CUT', bCutAngle: (a) => `${a}° cut`,
    bBankT: 'BANK SHOT', bBankM: 'Object ball banked in',
    bComboT: 'COMBO', bComboM: 'Potted off another ball',
    bBreakPotT: 'BREAK POT',
    bLongT: 'LONG POT', bLongDist: (d) => `${d}m out`,
    bDrawT: 'DRAW', bDrawDist: (d) => `${d}m draw back`,
    bFollowT: 'FOLLOW', bFollowDist: (d) => `${d}m follow through`,
    bCenterT: 'DEAD CENTER', bCenterM: 'Straight down the middle',
    bEdgeT: 'OFF THE JAW', bEdgeM: 'In off the pocket jaw',
    bRailT: 'RAIL ESCAPE', bRailM: 'Cue ball off a rail to hit',
    bGodlikeT: 'GODLIKE', bOnFireT: 'ON FIRE',
  },
};
const savedLang = localStorage.getItem('lang');
let lang = savedLang || (((navigator.language || '').toLowerCase().startsWith('zh')) ? 'zh' : 'en');
const t = (k, ...a) => {
  const v = I18N[lang][k];
  return typeof v === 'function' ? v(...a) : (v ?? k);
};
const playerName = (i) => t('player' + (i + 1));

function modeText(mode) {
  if (mode === 'aim') return [t('modeAim'), t('hintAim')];
  if (mode === 'place') return [t('modePlace'), t('hintPlace')];
  if (mode === 'darts') return [t('modeDarts'), t('hintDarts')];
  if (mode === 'dice') return [t('modeDice'), t('hintDice')];
  if (mode === 'roulette') return [t('modeRoulette'), t('hintRoulette')];
  return [t('modeWalk'), t('hintWalk')];
}

function applyLang() {
  document.title = t('docTitle');
  el('ov-title').textContent = t('ovTitle');
  el('ov-sub').textContent = t('ovSub');
  el('ov-flavor').innerHTML = t('ovFlavor');
  el('btn-start').textContent = menu.started ? t('resume') : t('start');
  el('controls-link-text').textContent = t('controlsLink');
  el('gear-text').textContent = t('gear');
  el('panel-title').textContent = t('settings');
  el('controls-title').textContent = t('keysTitle');
  el('about-list').innerHTML = t('credits')
    .map(([label, val]) => `<div class="about-row"><span class="set-label">${label}</span><span class="about-val">${val}</span></div>`)
    .join('');
  el('set-lang-label').textContent = t('langLabel');
  el('set-potcam-label').textContent = t('potcamLabel');
  el('set-guides-label').textContent = t('guidesLabel');
  el('lang-select').value = lang;
  el('about-label').textContent = t('about');
  el('about-sub').textContent = t('aboutSub');
  el('about-title').textContent = t('about');
  document.querySelectorAll('.back-text').forEach((b) => { b.textContent = t('backText'); });
  el('about-back-text').textContent = t('backToSettings');
  el('touch-note').textContent = t('touchNote');
  document.querySelector('.spin-label').textContent = t('spinLabel');
  syncPotcamUI();
  syncGuidesUI();
  syncMuteUI();
  ui.shots.textContent = t('shots', shots);
  ui.potted.textContent = t('potted', sim.balls.filter((b) => b.potted && b.id !== 0).length);
  const keyChips = (pairs) => pairs
    .map(([k, a]) => `<span class="key-chip"><em>${k}</em> ${a}</span>`)
    .join('');
  el('keys-1').innerHTML = keyChips(t('keysL'));
  el('keys-2').innerHTML = keyChips(t('keysR'));
  el('keys-3').innerHTML = keyChips(t('keysDarts'));
  match.players.forEach((p, i) => { p.name = playerName(i); });
  if (player.mode === 'walk' || player.mode === 'aim' || player.mode === 'place' || player.mode === 'darts'
    || player.mode === 'dice' || player.mode === 'roulette') {
    const [m, h] = modeText(player.mode);
    ui.mode.textContent = m;
    ui.hint.textContent = h;
  }
  syncDartsUI();
  updateScoreboard();
}

function syncPotcamUI() {
  el('potcam-toggle').classList.toggle('off', !reward.autoPotCam);
  el('potcam-state').textContent = reward.autoPotCam ? t('onState') : t('offState');
}

function syncMuteUI() {
  el('mute-text').textContent = audio.isMuted() ? t('mutedState') : t('mute');
  el('ov-mute').classList.toggle('muted', audio.isMuted());
}

function setLang(l) {
  lang = l;
  localStorage.setItem('lang', l);
  applyLang();
}
let toastTimer = 0;
function toast(text, ms = 1800) {
  ui.toast.textContent = text;
  ui.toast.style.opacity = 1;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (ui.toast.style.opacity = 0), ms);
}

// ---------------------------------------------------------------- player state
const isTouch = matchMedia('(pointer: coarse)').matches && !matchMedia('(pointer: fine)').matches;
const player = {
  mode: 'walk',            // walk | aim | rolling | spectator
  pos: new THREE.Vector3(0, 1.62, 2.05),
  yaw: Math.PI,            // facing -z... adjusted below to face the table
  pitch: -0.28,
  aimYaw: 0,               // direction of the shot on the xz plane
  aimHeight: 0.30,
  ox: 0, oy: 0,            // cue tip offsets (english / top-back)
  charge: 0,
  charging: false,
  power: 0.45,             // wheel-set power, used by Space and shown when not charging
};
player.yaw = Math.atan2(player.pos.x, player.pos.z); // face table center

const keys = new Set();
const EYE = 1.62;

// cue ball helpers
const cuePos = () => {
  const p = sim.ball(0).body.translation();
  return new THREE.Vector3(p.x, p.y + TABLE_Y, p.z);
};
const aimDir = () => new THREE.Vector3(Math.cos(player.aimYaw), 0, Math.sin(player.aimYaw));

// ---------------------------------------------------------------- input
const canvas = renderer.domElement;

const menu = { idle: true, started: false, t: 0 };

// aim guide lines (aim line / corridor / ghost / path previews), persisted
const guides = { on: localStorage.getItem('guides') !== 'off' };

function setGuides(on) {
  guides.on = on;
  localStorage.setItem('guides', on ? 'on' : 'off');
  syncGuidesUI();
  if (!on) {
    world.aimLine.visible = world.ghost.visible = false;
    world.corridor.a.visible = world.corridor.b.visible = false;
    world.objPath.visible = world.cuePath.visible = false;
  }
}
function syncGuidesUI() {
  el('guides-toggle').classList.toggle('off', !guides.on);
  el('guides-state').textContent = guides.on ? t('onState') : t('offState');
}

function startGame() {
  audio.unlock();
  menu.idle = false;
  intro.on = false;
  world.key.intensity = 78;
  el('veil').style.opacity = '0';
  document.querySelectorAll('.pre').forEach((n) => n.classList.remove('pre'));
  menu.started = true;
  el('btn-start').textContent = t('resume');
  ui.overlay.classList.add('hidden');
  el('hud').style.display = '';
  if (isTouch) {
    player.mode = 'spectator';
    el('touch-note').hidden = false;
    ui.mode.textContent = t('modeSpectator');
    ui.hint.textContent = t('hintSpectator');
    return;
  }
  canvas.requestPointerLock();
}

el('btn-start').addEventListener('click', (e) => { e.stopPropagation(); startGame(); });

function setPotcam(on) {
  reward.autoPotCam = on;
  localStorage.setItem('potcam', on ? 'on' : 'off');
  syncPotcamUI();
}
function togglePanel(name) {
  const sp = el('side-panel'), cp = el('controls-panel');
  const showSp = name === 'settings' && sp.hidden;
  const showCp = name === 'controls' && cp.hidden;
  sp.hidden = !showSp;
  cp.hidden = !showCp;
  if (showSp) { el('panel-settings').hidden = false; el('panel-about').hidden = true; }
}
function closePanels() {
  el('side-panel').hidden = true;
  el('controls-panel').hidden = true;
}
el('ov-gear').addEventListener('click', (e) => { e.stopPropagation(); togglePanel('settings'); });
el('ov-controls-link').addEventListener('click', (e) => { e.stopPropagation(); togglePanel('controls'); });
el('about-open').addEventListener('click', (e) => {
  e.stopPropagation();
  el('panel-settings').hidden = true;
  el('panel-about').hidden = false;
});
el('about-back').addEventListener('click', (e) => {
  e.stopPropagation();
  el('panel-about').hidden = true;
  el('panel-settings').hidden = false;
});
el('lang-select').addEventListener('change', (e) => setLang(e.target.value));
el('potcam-toggle').addEventListener('click', (e) => { e.stopPropagation(); setPotcam(!reward.autoPotCam); });
el('guides-toggle').addEventListener('click', (e) => { e.stopPropagation(); setGuides(!guides.on); });
el('ov-mute').addEventListener('click', (e) => {
  e.stopPropagation();
  audio.toggleMute();
  syncMuteUI();
});

// audio needs one user gesture (autoplay policy) — grab the first interaction
// anywhere, so the BGM is already playing before START is clicked
for (const ev of ['pointerdown', 'keydown']) {
  addEventListener(ev, () => audio.unlock(), { once: true, capture: true });
}

document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === canvas;
  if (!locked && player.mode !== 'spectator' && !replay.on && !potCam.on) {
    player.charging = false;
    if (player.mode === 'darts') exitDarts();
    else if (inBarMode()) exitBar();
    else if (player.mode !== 'rolling') setMode('walk');
    menu.idle = true;
    el('hud').style.display = 'none';
    ui.overlay.classList.remove('hidden');
  }
});

document.addEventListener('mousemove', (e) => {
  if (replay.on) {
    if (replay.dragging) {
      replay.orbitYaw -= e.movementX * 0.005;
      replay.orbitPitch = THREE.MathUtils.clamp(replay.orbitPitch + e.movementY * 0.004, 0.08, 1.35);
    }
    return;
  }
  if (document.pointerLockElement !== canvas) return;
  if (player.mode === 'walk') {
    player.yaw -= e.movementX * 0.0023;
    player.pitch = THREE.MathUtils.clamp(player.pitch - e.movementY * 0.0021, -1.25, 1.1);
  } else if (player.mode === 'aim') {
    player.aimYaw += e.movementX * 0.0016; // mouse right = aim right
    player.aimHeight = THREE.MathUtils.clamp(player.aimHeight - e.movementY * 0.0011, 0.16, 0.55);
  } else if (player.mode === 'darts') {
    // small look cone: the whole board stays reachable, the room stays out
    darts.yaw = THREE.MathUtils.clamp(darts.yaw - e.movementX * 0.0016, -0.21, 0.21);
    darts.pitch = THREE.MathUtils.clamp(darts.pitch - e.movementY * 0.0014, -0.15, 0.30);
  } else if (player.mode === 'dice') {
    barGames.dice.look(e.movementX, e.movementY);
  } else if (player.mode === 'roulette') {
    barGames.roulette.look(e.movementX, e.movementY);
  }
});

canvas.addEventListener('mousedown', (e) => {
  if (replay.on) { replay.dragging = true; return; }
  if (potCam.on) return;
  if (document.pointerLockElement !== canvas) {
    // re-acquire pointer lock (e.g. after pot cam / replay auto-exit)
    canvas.requestPointerLock?.();
    return;
  }
  if (e.button === 0 && player.mode === 'aim') {
    player.charging = true;
    player.charge = 0;
  } else if (e.button === 0 && player.mode === 'place') {
    confirmPlace();
  } else if (e.button === 0 && player.mode === 'darts') {
    if (!darts.busy) { darts.charging = true; darts.charge = 0; } // hold to charge
  } else if (e.button === 0 && inBarMode()) {
    if (player.mode === 'dice') barGames.dice.primary();
    else if (player.mode === 'roulette') barGames.roulette.primary();
  } else if (e.button === 2) {
    if (player.mode === 'walk') tryEnterAim();
    else if (player.mode === 'aim') setMode('walk');
    else if (player.mode === 'darts') exitDarts();
    else if (inBarMode()) exitBar();
  }
});
addEventListener('mouseup', (e) => {
  if (replay.dragging) { replay.dragging = false; return; }
  if (e.button === 0 && player.charging) {
    player.charging = false;
    strike(player.charge);
  } else if (e.button === 0 && player.mode === 'darts' && darts.charging) {
    darts.charging = false;
    throwDart(Math.max(darts.charge, 0.08));
  }
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// mouse wheel: fine power in aim mode, zoom in replay mode
addEventListener('wheel', (e) => {
  if (replay.on) {
    replay.orbitDist = THREE.MathUtils.clamp(replay.orbitDist + e.deltaY * 0.0022, 0.8, 4.5);
  } else if (player.mode === 'aim') {
    player.power = THREE.MathUtils.clamp(player.power + (e.deltaY < 0 ? 0.04 : -0.04), 0.05, 1);
  }
}, { passive: true });

addEventListener('keydown', (e) => {
  if (menu.idle && e.code === 'Escape') { closePanels(); return; }
  keys.add(e.code);
  if (potCam.on) { exitPotCam(); return; }
  if (e.code === 'KeyV' && isPoolMode(player.mode)) { replay.on ? exitReplay() : enterReplay(); return; }
  if (replay.on) { if (e.code === 'Escape') exitReplay(); return; }
  if (player.mode === 'aim') {
    const step = 0.09;
    if (e.code === 'KeyA') player.ox = THREE.MathUtils.clamp(player.ox - step, -1, 1);
    if (e.code === 'KeyD') player.ox = THREE.MathUtils.clamp(player.ox + step, -1, 1);
    if (e.code === 'KeyW') player.oy = THREE.MathUtils.clamp(player.oy + step, -1, 1);
    if (e.code === 'KeyS') player.oy = THREE.MathUtils.clamp(player.oy - step, -1, 1);
    if (e.code === 'KeyR') { player.ox = 0; player.oy = 0; }
    if (e.code === 'KeyE' || e.code === 'KeyQ') setMode('walk');
    if (e.code === 'Space') { e.preventDefault(); strike(player.power); }
  } else if (player.mode === 'walk' && e.code === 'KeyE') {
    tryEnterAim();
  } else if (player.mode === 'darts' && (e.code === 'KeyE' || e.code === 'KeyQ')) {
    exitDarts();
  } else if (inBarMode() && (e.code === 'KeyE' || e.code === 'KeyQ')) {
    exitBar();
  }
  if (player.mode === 'dice' && e.code === 'Space') { e.preventDefault(); barGames.dice.primary(); }
  if (isPoolMode(player.mode)) {
    if (e.code === 'KeyT') rerack();
    if (e.code === 'KeyG') {
      match.on = !match.on;
      if (match.on) { resetMatch(); toast(t('matchMode')); }
      else { toast(t('practice')); updateScoreboard(); }
    }
    if (e.code === 'KeyF') {
      if (player.mode === 'place') confirmPlace();
      else if ((player.mode === 'walk' || player.mode === 'aim') && sim.isSettled()) {
        if (!match.on || (match.ballInHand && !match.over)) enterPlaceMode();
        else toast(t('noFreeBall'));
      }
    }
  }
  if (e.code === 'KeyE' && player.mode === 'place') confirmPlace();
  if (e.code === 'KeyO') {
    setPotcam(!reward.autoPotCam);
    toast(reward.autoPotCam ? t('potcamOn') : t('potcamOff'));
  }
  if (e.code === 'KeyM') {
    const muted = audio.toggleMute();
    toast(muted ? t('muted') : t('soundOn'));
    syncMuteUI();
  }
});
addEventListener('keyup', (e) => keys.delete(e.code));

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  bloomComposer.setSize(innerWidth, innerHeight);
  finalComposer.setSize(innerWidth, innerHeight);
});

// ---------------------------------------------------------------- modes
function setMode(mode) {
  player.mode = mode;
  player.charging = false;
  const aiming = mode === 'aim';
  ui.aimUI.style.display = aiming ? 'block' : 'none';
  el('power-wrap').style.display = (aiming || mode === 'darts') ? 'block' : 'none';
  ui.crosshair.style.display = (mode === 'walk' || mode === 'darts' || mode === 'dice' || mode === 'roulette') ? 'block' : 'none';
  el('darts-ui').style.display = mode === 'darts' ? 'flex' : 'none';
  el('bar-ui').style.display = (mode === 'dice' || mode === 'roulette') ? 'block' : 'none';
  if (mode !== 'darts' && darts3d.handDart) darts3d.handDart.visible = false;
  world.cue.visible = aiming;
  world.aimLine.visible = aiming && guides.on;
  world.ghost.visible = aiming && guides.on;
  world.corridor.a.visible = world.corridor.b.visible = false;
  world.objPath.visible = false;
  world.cuePath.visible = false;
  if (aiming) {
    // start behind the cue ball, facing the rack
    const c = cuePos();
    player.aimYaw = Math.atan2(-c.z, 0.4 - c.x);
    player.aimHeight = 0.34;
  }
  if (mode === 'aim' || mode === 'walk' || mode === 'place' || mode === 'darts'
    || mode === 'dice' || mode === 'roulette') {
    const [m, h] = modeText(mode);
    ui.mode.textContent = m;
    ui.hint.textContent = h;
  }
}

function tryEnterAim() {
  if (!sim.isSettled()) { toast(t('notSettled')); return; }
  const s = nearestStation(); // at a bar station, not the table
  if (s) { s.enter(); return; }
  const cue = sim.ball(0);
  if (!cue.active) { respotCue(); }
  setMode('aim');
}

function respotCue() {
  const s = findCueSpot();
  sim.placeBall(0, s.x, s.z);
  toast(t('respot'));
}

/** Free spot near the head string (scratch respots / ball-in-hand start). */
function findCueSpot() {
  for (const dx of [0, 0.09, -0.09, 0.18, -0.18, 0.3]) {
    const x = -TABLE_HX / 2 + dx;
    const blocked = sim.balls.some((b) => {
      if (!b.active) return false;
      const p = b.body.translation();
      return Math.hypot(p.x - x, p.z) < BALL_R * 2.2;
    });
    if (!blocked) return { x, z: 0 };
  }
  return { x: -TABLE_HX / 2, z: 0.2 };
}

// --- ball-in-hand placement: F toggles the mode, WASD moves the cue ball ---
function enterPlaceMode() {
  if (replay.on) exitReplay();
  if (potCam.on) exitPotCam();
  if (!sim.ball(0).active) {
    const s = findCueSpot();
    sim.placeBall(0, s.x, s.z);
  }
  setMode('place');
}

function confirmPlace() {
  match.ballInHand = false;
  setMode('aim');
}

/** A legal drop: on the cloth, clear of pocket mouths and other balls. */
function placeSpotOK(x, z) {
  if (Math.abs(x) > TABLE_HX - BALL_R || Math.abs(z) > TABLE_HZ - BALL_R) return false;
  for (const pk of sim.pockets) {
    if (Math.hypot(x - pk.x, z - pk.z) < pk.r + 0.004) return false;
  }
  for (const b of sim.balls) {
    if (!b.active || b.id === 0) continue;
    const p = b.body.translation();
    if (Math.hypot(p.x - x, p.z - z) < BALL_R * 2 + 0.002) return false;
  }
  return true;
}

function updatePlace(dt) {
  const cue = sim.ball(0);
  const c = cue.body.translation();
  const step = 0.55 * dt;
  const nx = c.x + (keys.has('KeyD') ? step : 0) - (keys.has('KeyA') ? step : 0);
  const nz = c.z + (keys.has('KeyS') ? step : 0) - (keys.has('KeyW') ? step : 0);
  // axis-separated moves slide along obstacles instead of sticking
  if (nx !== c.x && placeSpotOK(nx, c.z)) sim.placeBall(0, nx, c.z);
  const cx = cue.body.translation().x;
  if (nz !== c.z && placeSpotOK(cx, nz)) sim.placeBall(0, cx, nz);
  // broadcast overview of the table while placing
  camera.position.set(0, TABLE_Y + 1.55, 1.85);
  camera.lookAt(0, TABLE_Y - 0.2, 0);
}

function strike(power) {
  power = Math.max(power ?? player.charge, 0.06);
  player.power = power;
  match.ballInHand = false; // unused ball-in-hand lapses once you shoot
  const speed = 0.35 + (MAX_V - 0.35) * Math.pow(power, 1.3);
  const d = aimDir();
  // reward-system shot capture (before sim state changes)
  {
    const cs = sim.ball(0).body.translation();
    shot = {
      speed, ox: player.ox, oy: player.oy,
      isBreak: shots === 0,
      cueStart: { x: cs.x, z: cs.z },
      dir: { x: d.x, z: d.z },
      contacts: [], objBanks: new Set(), combos: new Set(),
      firstContact: null, contactInfo: null, cueBank: 0,
      pots: [], prevPos: new Map(), scratch: false,
    };
    for (const b of sim.balls) {
      const p = b.body.translation();
      shot.prevPos.set(b.id, { x: p.x, z: p.z });
    }
  }
  poke = { t: 0.09, dir: d.clone() };
  rollCamT = 0;
  rollCamPos = null;
  rumble(0.3 + 0.5 * power, 40);
  sim.strike({ x: d.x, z: d.z }, speed, player.ox, player.oy);
  shots++;
  audio.cueStrike(power, shots === 0);
  startRecording();
  setMode('rolling');
  ui.mode.textContent = t('modeRolling');
  ui.hint.textContent = '';
}

function rerack() {
  if (replay.on) exitReplay();
  if (potCam.on) exitPotCam();
  sim = createSim();
  rec = [];
  recTimes = [];
  recWall = [];
  recOn = false;
  shots = 0;
  reward.streak = 0;
  streakEl.classList.remove('show');
  resetMatch();
  audio.rerack();
  toast(match.on ? t('rerackMatch') : t('rerack'));
  if (player.mode === 'rolling') setMode('walk');
}

const smooth01 = (x) => { const k = THREE.MathUtils.clamp(x, 0, 1); return k * k * (3 - 2 * k); };

// intro: black veil fades, lamp comes up, camera pushes in on the cue ball,
// cue tip slides in from the frame edge, then the menu fades in (~3.4s total)
const intro = { on: true, t: 0, revealed: false };
const INTRO_T = 3.4;
const INTRO_CAM_END = 3.0;
const INTRO_REVEAL = 1.2; // menu UI fades in early; the scene keeps playing behind

function updateIntro(dt) {
  intro.t += dt;
  const t = intro.t;
  el('veil').style.opacity = t < 0.3 ? '1' : String(Math.max(0, 1 - (t - 0.3) / 1.1));
  if (!intro.revealed && t >= INTRO_REVEAL) {
    intro.revealed = true;
    document.querySelectorAll('.pre').forEach((n) => n.classList.remove('pre'));
  }
  // table lamp warms up
  world.key.intensity = 78 * smooth01((t - 0.4) / 1.8);
  // push-in on the orbit circle toward the menu-idle start pose
  const yawE = INTRO_CAM_END * 0.07;
  const rE = 2.55 + Math.sin(INTRO_CAM_END * 0.045) * 0.3;
  const yE = 1.32 + Math.sin(INTRO_CAM_END * 0.1) * 0.14;
  const k = smooth01(t / INTRO_CAM_END);
  const yaw = yawE - 0.3 * (1 - k);
  const r = 4.6 + (rE - 4.6) * k;
  const y = 2.3 + (yE - 2.3) * k;
  camera.position.set(Math.cos(yaw) * r, y, Math.sin(yaw) * r);
  const cb = cuePos();
  camera.lookAt(
    cb.x * (1 - k),
    (cb.y - 0.02) * (1 - k) + (TABLE_Y - 0.06) * k,
    cb.z * (1 - k)
  );
  // cue tip slides in from the edge and settles on the cue ball
  const kc = smooth01((t - 1.9) / 1.1);
  if (kc > 0) {
    world.cue.visible = true;
    world.cue.position.set(
      cb.x - (0.09 + BALL_R) - 0.5 * (1 - kc),
      cb.y + 0.004 + 0.3 * (1 - kc),
      cb.z + 0.35 * (1 - kc)
    );
    world.cue.lookAt(cb.x, cb.y, cb.z);
  }
  if (t >= INTRO_T) {
    intro.on = false;
    world.key.intensity = 78;
    world.cue.visible = false;
    el('veil').style.opacity = '0';
    menu.t = INTRO_CAM_END; // hand the drift orbit over seamlessly
  }
}

// slow cinematic drift around the table while the start menu is up
function updateMenuCam(dt) {
  menu.t += dt;
  const yaw = menu.t * 0.07;
  const r = 2.55 + Math.sin(menu.t * 0.045) * 0.3;
  camera.position.set(
    Math.cos(yaw) * r,
    1.32 + Math.sin(menu.t * 0.1) * 0.14,
    Math.sin(yaw) * r
  );
  camera.lookAt(0, TABLE_Y - 0.06, 0);
}

// ---------------------------------------------------------------- walk movement
function updateWalk(dt) {
  const speed = keys.has('ShiftLeft') ? 2.6 : 1.5;
  const f = new THREE.Vector3(-Math.sin(player.yaw), 0, -Math.cos(player.yaw));
  const r = new THREE.Vector3(-f.z, 0, f.x);
  const move = new THREE.Vector3();
  if (keys.has('KeyW')) move.add(f);
  if (keys.has('KeyS')) move.sub(f);
  if (keys.has('KeyD')) move.add(r);
  if (keys.has('KeyA')) move.sub(r);
  if (move.lengthSq() > 0) {
    move.normalize().multiplyScalar(speed * dt);
    player.pos.add(move);
  }
  // room bounds + keep out of the table body
  player.pos.x = THREE.MathUtils.clamp(player.pos.x, -2.6, 2.6);
  player.pos.z = THREE.MathUtils.clamp(player.pos.z, -2.9, 2.9);
  const bx = TABLE_HX + 0.42, bz = TABLE_HZ + 0.42;
  if (Math.abs(player.pos.x) < bx && Math.abs(player.pos.z) < bz) {
    const px = bx - Math.abs(player.pos.x), pz = bz - Math.abs(player.pos.z);
    if (px < pz) player.pos.x = Math.sign(player.pos.x || 1) * bx;
    else player.pos.z = Math.sign(player.pos.z || 1) * bz;
  }
  // station proximity: swap the walk hint for the station invite (and back)
  const st = nearestStation();
  const stId = st ? st.id : null;
  if (stId !== darts.nearWas) {
    darts.nearWas = stId;
    ui.hint.textContent = st ? t(st.hint) : t('hintWalk');
  }
  camera.position.copy(player.pos);
  camera.rotation.set(0, 0, 0);
  camera.rotateY(player.yaw);
  camera.rotateX(player.pitch);
}

// ---------------------------------------------------------------- aim camera + cue + aim line
function updateAim() {
  const c = cuePos();
  const d = aimDir();
  const dist = 0.72;
  // keep the aim camera over the table (never behind the rail legs);
  // same aim view everywhere, even when the ball hugs a rail
  const camX = THREE.MathUtils.clamp(c.x - d.x * dist, -1.24, 1.24);
  const camZ = THREE.MathUtils.clamp(c.z - d.z * dist, -0.72, 0.72);
  const back = Math.hypot(c.x - camX, c.z - camZ);
  camera.position.set(camX, c.y + player.aimHeight, camZ);
  const ahead = Math.min(1.1, back + 0.45);
  camera.lookAt(c.x + d.x * ahead, c.y - 0.12, c.z + d.z * ahead);

  // cue stick: pulled back along the shot direction, tip offset shows spin
  const pull = 0.09 + (player.charging ? player.charge * 0.3 : 0.02);
  const side = new THREE.Vector3(-d.z, 0, d.x);
  world.cue.position.set(
    c.x - d.x * (pull + BALL_R) + side.x * player.ox * BALL_R * 0.5,
    c.y + player.oy * BALL_R * 0.5 + 0.004,
    c.z - d.z * (pull + BALL_R) + side.z * player.ox * BALL_R * 0.5
  );
  world.cue.lookAt(c.x + side.x * player.ox * BALL_R * 0.5, c.y + player.oy * BALL_R * 0.5, c.z + side.z * player.ox * BALL_R * 0.5);

  // aim graphics: center line, error corridor, object path, spin-aware cue path
  world.aimLine.visible = player.mode === 'aim' && guides.on;
  if (player.mode === 'aim' && guides.on) {
    const cs = sim.ball(0).body.translation();
    const hit = rayContact(cs.x, cs.z, d.x, d.z);
    const t = Math.min(hit.t, 2.6);
    const ex = cs.x + d.x * t, ez = cs.z + d.z * t;
    setRibbon(world.aimLine, cs.x, cs.z, ex, ez, 0.0075);

    // corridor: tangent lines from cue edges to the contact point (error margin)
    const px = -d.z, pz = d.x;
    world.corridor.a.visible = world.corridor.b.visible = true;
    setRibbon(world.corridor.a, cs.x + px * BALL_R, cs.z + pz * BALL_R, ex + px * BALL_R, ez + pz * BALL_R, 0.003);
    setRibbon(world.corridor.b, cs.x - px * BALL_R, cs.z - pz * BALL_R, ex - px * BALL_R, ez - pz * BALL_R, 0.003);

    if (hit.isBall) {
      world.ghost.visible = true;
      world.ghost.position.set(ex, 0.004, ez);

      // impact normal: from the cue's contact position to the object ball center
      let nx = hit.hitPos.x - ex, nz = hit.hitPos.z - ez;
      const nl = Math.hypot(nx, nz) || 1;
      nx /= nl; nz /= nl;

      // object ball path (solid green)
      world.objPath.visible = true;
      setRibbon(world.objPath, hit.hitPos.x, hit.hitPos.z,
        hit.hitPos.x + nx * 0.42, hit.hitPos.z + nz * 0.42, 0.008);

      // cue path preview — VISUAL AID, approximation; the shot itself runs real physics.
      // stun follows the tangent; follow bends toward the object, draw bends back;
      // side spin adds a small lateral drift.
      let tx = d.x - nx * (d.x * nx + d.z * nz);
      let tz = d.z - nz * (d.x * nx + d.z * nz);
      let tl = Math.hypot(tx, tz);
      if (tl < 1e-4) { tx = d.x; tz = d.z; tl = 1; } // head-on: follow/draw along aim dir
      tx /= tl; tz /= tl;
      const eff = player.charging ? player.charge : player.power;
      let vx = tx * 0.55 + nx * 0.9 * player.oy + px * 0.15 * player.ox;
      let vz = tz * 0.55 + nz * 0.9 * player.oy + pz * 0.15 * player.ox;
      const vl = Math.hypot(vx, vz) || 1;
      const plen = 0.18 + eff * 0.5;
      world.cuePath.visible = true;
      setRibbon(world.cuePath, ex, ez, ex + (vx / vl) * plen, ez + (vz / vl) * plen, 0.006);
    } else {
      world.ghost.visible = false;
      world.objPath.visible = false;
      world.cuePath.visible = false;
    }
  }
}

function setRibbon(mesh, sx, sz, ex, ez, width) {
  const dx = ex - sx, dz = ez - sz;
  const len = Math.hypot(dx, dz) || 1e-4;
  mesh.scale.set(len, 1, width);
  mesh.position.set((sx + ex) / 2, 0.004, (sz + ez) / 2);
  mesh.rotation.y = -Math.atan2(dz, dx);
}

function rayContact(cx, cz, dx, dz) {
  let tRail = Infinity;
  if (dx > 1e-9) tRail = (TABLE_HX - BALL_R - cx) / dx;
  else if (dx < -1e-9) tRail = (-TABLE_HX + BALL_R - cx) / dx;
  if (dz > 1e-9) tRail = Math.min(tRail, (TABLE_HZ - BALL_R - cz) / dz);
  else if (dz < -1e-9) tRail = Math.min(tRail, (-TABLE_HZ + BALL_R - cz) / dz);

  let tBall = Infinity, hitPos = null;
  for (const b of sim.balls) {
    if (!b.active || b.id === 0) continue;
    const p = b.body.translation();
    const rx = p.x - cx, rz = p.z - cz;
    const proj = rx * dx + rz * dz;
    if (proj <= 0) continue;
    const perp2 = rx * rx + rz * rz - proj * proj;
    const R2 = (2 * BALL_R) * (2 * BALL_R);
    if (perp2 >= R2) continue;
    const t = proj - Math.sqrt(R2 - perp2);
    if (t < tBall) { tBall = t; hitPos = { x: p.x, z: p.z }; }
  }
  return { t: Math.min(tRail, tBall), isBall: tBall <= tRail, hitPos };
}

// ---------------------------------------------------------------- rolling camera
// After the strike the camera eases up into a broadcast overhead view instead
// of staying glued to the cue ball. Position is clamped continuously inside
// the room (no discrete steps) and temporally smoothed — no flicker.
let rollCamT = 0;
let rollCamPos = null;
function updateRollingCam(dt) {
  rollCamT = Math.min(rollCamT + dt / 0.7, 1);
  const k = rollCamT * rollCamT * (3 - 2 * rollCamT); // smoothstep
  const c = cuePos();
  const d = aimDir();
  const ax = c.x - d.x * 0.68, ay = c.y + player.aimHeight, az = c.z - d.z * 0.68;
  // continuous clamp: x stays off the side walls, z stays out of the bar
  const bx = THREE.MathUtils.clamp(c.x - d.x * 1.5, -2.3, 2.3);
  const bz = THREE.MathUtils.clamp(c.z - d.z * 1.5, -1.3, 3.2);
  const by = Math.min(TABLE_Y + 1.22, 2.05);
  const tx = ax + (bx - ax) * k;
  const ty = ay + (by - ay) * k;
  const tz = az + (bz - az) * k;
  if (!rollCamPos) rollCamPos = new THREE.Vector3(tx, ty, tz);
  const lp = 1 - Math.exp(-dt * 7);
  rollCamPos.x += (tx - rollCamPos.x) * lp;
  rollCamPos.y += (ty - rollCamPos.y) * lp;
  rollCamPos.z += (tz - rollCamPos.z) * lp;
  camera.position.copy(rollCamPos);
  camera.lookAt(c.x + d.x * 0.6 * k, c.y - 0.02 * k, c.z + d.z * 0.6 * k);
}

// ---------------------------------------------------------------- spectator (touch devices)
let orbitT = 0;
function updateSpectator(dt) {
  orbitT += dt * 0.18;
  camera.position.set(Math.cos(orbitT) * 2.6, 1.7 + Math.sin(orbitT * 0.6) * 0.25, Math.sin(orbitT) * 2.6);
  camera.lookAt(0, TABLE_Y, 0);
}

// ---------------------------------------------------------------- darts mini-game
// Walk up to the bar's dartboard (left wall) and press E. Mouse aims with a
// breathing sway; hold LMB to charge power, release to throw — the dart flies
// an honest parabola: soft throws arc and drop, full power flattens out but
// jitters. 3-dart rounds, standard board scoring; best round in localStorage.
const OCHE = new THREE.Vector3(-0.67, 1.62, -2.20); // throw line, eye height — 2.46 m, regulation-ish oche
const darts = {
  round: createRound(),
  best: Number(localStorage.getItem('darts-best') || 0),
  yaw: 0, pitch: 0,       // look offset inside a small cone around the board
  swayT: Math.random() * 20,
  busy: false,            // dart in flight / round settling
  nearWas: false,
  push: 0, pushTarget: 0, // round-end push-in toward the board (0=oche, 1=close)
  landed: 0,              // total landings this session (test hooks key off it)
  power: 0.55,            // last released power (remembered between throws)
  charging: false, charge: 0,
};

// ---------------------------------------------------------------- bar stations
// Walk-up interaction points: the dartboard and the two bar stools.
const STATIONS = [
  { id: 'darts', pos: OCHE, r: 0.55, hint: 'hintDartsNear', enter: () => enterDarts() },
  { id: 'dice', pos: STOOLS.dice, r: 0.55, hint: 'hintDiceNear', enter: () => enterDice() },
  { id: 'roulette', pos: STOOLS.roulette, r: 0.55, hint: 'hintRouNear', enter: () => enterRoulette() },
];

function nearestStation() {
  let best = null, bd = Infinity;
  for (const s of STATIONS) {
    const d = Math.hypot(player.pos.x - s.pos.x, player.pos.z - s.pos.z);
    if (d < s.r && d < bd) { bd = d; best = s; }
  }
  return best;
}

function enterDice() { setMode('dice'); barGames.dice.enter(); }
function enterRoulette() { setMode('roulette'); barGames.roulette.enter(); }

function exitBar() {
  if (player.mode === 'dice') barGames.dice.exit();
  else if (player.mode === 'roulette') barGames.roulette.exit();
  else return;
  setMode('walk');
}

const inBarMode = () =>
  player.mode === 'dice' || player.mode === 'roulette';
const isPoolMode = (m) =>
  m === 'walk' || m === 'aim' || m === 'place' || m === 'rolling';

function enterDarts() {
  darts.yaw = 0; darts.pitch = 0;
  darts.busy = false; darts.charging = false;
  darts.push = 0; darts.pushTarget = 0;
  darts.landed = 0;
  darts.round.reset();
  setMode('darts');
  darts3d.ensureHandDart().visible = true;
  syncDartsUI();
}

function exitDarts() {
  darts3d.reset();
  darts.round.reset();
  darts.busy = false;
  darts.charging = false;
  darts.pushTarget = 0;
  setMode('walk');
}

/** camera-forward ray ∩ the board plane (world x = faceX) */
function dartAimPoint() {
  const fwd = new THREE.Vector3();
  camera.getWorldDirection(fwd);
  if (fwd.x >= -1e-6) return null;
  const s = (darts3d.board.faceX - camera.position.x) / fwd.x;
  return camera.position.clone().addScaledVector(fwd, s);
}

// throw feel: speed maps power → 5.5..13 m/s; harder throws fly flatter but
// land wilder (angular jitter at release). Low power arcs and drops — under-
// charged darts clatter down the wall, which is half the lesson of darts.
const DART_V0 = 5.5, DART_V1 = 13;
const dartSpeed = (p) => DART_V0 + (DART_V1 - DART_V0) * p;

function throwDart(power) {
  if (darts.busy || darts.round.isDone()) return;
  darts.busy = true;
  darts.power = power;
  // honest launch: from the hand THROUGH the crosshair's aim point, then full
  // gravity takes over — the dart always drops below the aim, power sets how much.
  // The mesh in your hand is the one that flies (no release pop).
  const hand = darts3d.ensureHandDart();
  const from = hand.position.clone();
  const aim = dartAimPoint();
  const dir = aim
    ? aim.clone().sub(from).normalize()
    : (() => { const f = new THREE.Vector3(); camera.getWorldDirection(f); return f; })();
  // release jitter grows with power: σ ≈ 2mm (soft) .. 11mm (full) at the board
  const sp = spread(0.0008 + power * 0.0042);
  const right = new THREE.Vector3().crossVectors(dir, camera.up).normalize();
  const up2 = new THREE.Vector3().crossVectors(right, dir);
  dir.addScaledVector(up2, sp.dy).addScaledVector(right, sp.dz).normalize();
  darts3d.throwHandDart(dir.multiplyScalar(dartSpeed(power)));
  audio.dartThrow();
}

function onDartLand(res) {
  if (player.mode !== 'darts') return;
  darts.landed++;
  if (res.miss) {
    darts.round.add({ score: 0, ring: 'miss', sector: 0, mult: 0 });
    audio.dartMiss();
    toast(t('dartMiss'));
  } else {
    darts.round.add(res.score);
    const h = res.score;
    audio.dartHit(
      h.ring === 'inner-bull' ? 1 : h.ring === 'outer-bull' ? 0.85 : Math.min(1, 0.45 + h.score / 130)
    );
    shake = Math.min(0.3, shake + 0.1);
    toast(t('dartLabel', h));
  }
  syncDartsUI();
  if (darts.round.isDone()) {
    finishRound();
  } else {
    darts.busy = false;
    darts3d.ensureHandDart().visible = true;
  }
}

function finishRound() {
  const total = darts.round.total();
  const isBest = total > darts.best;
  if (isBest) {
    darts.best = total;
    try { localStorage.setItem('darts-best', String(total)); } catch (_) {}
  }
  if (total === 180) { showBadge(t('b180T'), t('b180M'), true); audio.bigSting(); }
  else if (total >= 100) { showBadge(t('bTonT'), t('dartsRoundScore', total)); audio.badgeSting(); }
  else toast(t('dartsRoundScore', total) + (isBest ? ` · ${t('dartNewBest')}` : ''), 2600);
  syncDartsUI();
  darts.pushTarget = 1; // push in and admire the round before the board clears
  setTimeout(() => {
    if (player.mode !== 'darts') return;
    darts.pushTarget = 0;
    darts3d.clearStuck();
    darts.round.reset();
    darts.busy = false;
    darts3d.ensureHandDart().visible = true;
    syncDartsUI();
  }, 2200);
}

function ringTag(h) {
  if (h.ring === 'miss') return t('dartMiss');
  if (h.ring === 'inner-bull') return 'BULL';
  if (h.ring === 'outer-bull') return '25';
  return (h.ring === 'treble' ? 'T' : h.ring === 'double' ? 'D' : 'S') + h.sector;
}

function syncDartsUI() {
  for (let i = 0; i < 3; i++) {
    const slot = el('ds' + i);
    const h = darts.round.darts[i];
    slot.classList.toggle('done', !!h);
    slot.classList.toggle('cur', !h && i === darts.round.darts.length && player.mode === 'darts');
    slot.querySelector('i').textContent = h ? ringTag(h) : String(i + 1);
    slot.querySelector('b').textContent = h && h.ring !== 'miss' ? String(h.score) : '';
  }
  el('darts-total').textContent = t('dartsRound', darts.round.total());
  el('darts-best').textContent = t('dartsBest', darts.best);
}

function updateDarts(dt) {
  darts.swayT += dt;
  // round-end push-in: ease the eye from the oche toward the board
  darts.push += (darts.pushTarget - darts.push) * (1 - Math.exp(-dt * 3.2));
  const k = smooth01(darts.push);
  const closeX = darts3d.board.faceX + 0.52;
  const eye = new THREE.Vector3(
    OCHE.x + (closeX - OCHE.x) * k,
    OCHE.y + (BOARD_C.y - OCHE.y) * k,
    OCHE.z + (BOARD_C.z - OCHE.z) * k
  );
  const bdx = BOARD_C.x - eye.x, bdy = BOARD_C.y - eye.y, bdz = BOARD_C.z - eye.z;
  const baseYaw = Math.atan2(-bdx, -bdz);
  const basePitch = Math.atan2(bdy, Math.hypot(bdx, bdz));
  const st = darts.swayT;
  const amp = 1 - k; // sway & mouse fade on push-in
  // breathing sway: two incommensurate frequencies per axis ≈ 14mm at the board
  const swY = (Math.sin(st * 1.7) * 0.6 + Math.sin(st * 0.53 + 1.3) * 0.4) * 0.006 * amp;
  const swP = (Math.sin(st * 1.3 + 0.7) * 0.6 + Math.sin(st * 0.41 + 2.1) * 0.4) * 0.006 * amp;
  camera.position.copy(eye);
  camera.rotation.set(0, 0, 0);
  camera.rotateY(baseYaw + darts.yaw * (1 - k) + swY);
  camera.rotateX(basePitch + darts.pitch * (1 - k) + swP);
  // power charge (ping-back at full, same feel as the cue charge)
  if (darts.charging) {
    darts.charge += dt / 1.15;
    if (darts.charge > 1) darts.charge = 0.12;
  }
  const hd = darts3d.ensureHandDart();
  if (hd.visible) {
    const fwd = new THREE.Vector3();
    camera.getWorldDirection(fwd);
    const right = new THREE.Vector3().crossVectors(fwd, camera.up).normalize();
    const hp = hd.position;
    hp.copy(camera.position).addScaledVector(fwd, 0.5).addScaledVector(right, 0.16);
    hp.y -= 0.13;
    // drawback while charging: the hand pulls the dart back before release
    const db = darts.charging ? darts.charge : 0;
    hp.addScaledVector(fwd, -0.15 * db);
    hp.y += 0.05 * db;
    const target = dartAimPoint();
    if (target) hd.lookAt(target);
  }
  // predicted landing marker: follows the aim ray and the CURRENT charge —
  // low power arcs and drops, full power flattens out (aim-guide, like the
  // billiards guides; hidden while a dart is up or the board is pushed in)
  if (guides.on && !darts.busy && darts.pushTarget === 0) {
    const from = hd.visible ? hd.position : camera.position;
    const aim = dartAimPoint();
    let hit = null;
    if (aim) {
      const dir = aim.clone().sub(from).normalize();
      hit = predictHit(
        { x: from.x, y: from.y, z: from.z },
        { x: dir.x, y: dir.y, z: dir.z },
        dartSpeed(darts.charging ? darts.charge : darts.power),
        darts3d.board.faceX, BOARD_C
      );
    }
    darts3d.setAimDot(hit ? hit.dy : null, hit && hit.dz);
  } else {
    darts3d.setAimDot(null);
  }
}

// ---------------------------------------------------------------- spin pad HUD
function drawSpinPad() {
  const c = spinCtx, R = 36;
  c.clearRect(0, 0, 72, 72);
  c.strokeStyle = 'rgba(232,226,213,.7)';
  c.lineWidth = 1.5;
  c.beginPath(); c.arc(R, R, 28, 0, 7); c.stroke();
  c.globalAlpha = 0.35;
  c.beginPath(); c.moveTo(R - 28, R); c.lineTo(R + 28, R); c.moveTo(R, R - 28); c.lineTo(R, R + 28); c.stroke();
  c.globalAlpha = 1;
  c.fillStyle = '#e8e2d5';
  c.beginPath(); c.arc(R + player.ox * 24, R - player.oy * 24, 4.5, 0, 7); c.fill();
}

// ---------------------------------------------------------------- audio events
function playEvents(events) {
  let hits = 0, cushions = 0;
  // sort a copy by impulse to cap the loudest sounds; the event list itself
  // stays chronological — trackShot relies on drain order for first contact
  events.slice().sort((a, b) => (b.impulse || 0) - (a.impulse || 0)).forEach((e) => {
    if (e.type === 'hit' && hits < 4) { audio.ballHit(e.impulse); hits++; }
    else if (e.type === 'cushion' && cushions < 2) { audio.cushion(e.impulse); cushions++; }
    else if (e.type === 'pocket') audio.pocket();
    else if (e.type === 'escape') console.warn('ball escaped table!', e);
  });
}

// ---------------------------------------------------------------- performance + degradation
let fpsEMA = 60, lowT = 0;
window.__perf = { fps: 60, dpr: DPR_STEPS[0] };
function trackPerf(dt) {
  const fps = 1 / Math.max(dt, 1e-4);
  fpsEMA += (fps - fpsEMA) * 0.05;
  window.__perf.fps = Math.round(fpsEMA);
  if (fpsEMA < 52) {
    lowT += dt;
    if (lowT > 3 && dprIdx < DPR_STEPS.length - 1) {
      dprIdx++;
      renderer.setPixelRatio(DPR_STEPS[dprIdx]);
      bloomComposer.setPixelRatio(DPR_STEPS[dprIdx]);
      finalComposer.setPixelRatio(DPR_STEPS[dprIdx]);
      window.__perf.dpr = DPR_STEPS[dprIdx];
      console.info(`fps ${fpsEMA.toFixed(0)} < 52: lowering DPR to ${DPR_STEPS[dprIdx]}`);
      lowT = 0;
    }
  } else lowT = 0;
  ui.fps.textContent = `${window.__perf.fps} fps`;
}

// ---------------------------------------------------------------- replay system
// Records every rendered frame while balls roll (ring buffer, 16 balls × 8 floats).
// V toggles: scrub timeline, 0.1–1× speed, free orbit camera (drag/wheel).
const REPLAY_MAX = 60 * 90; // 90 s at 60 fps
let rec = [];
let recOn = false;
const replay = {
  on: false, sec: 0, playing: true, speed: 1, dragging: false,
  orbitYaw: 0.7, orbitPitch: 0.55, orbitDist: 2.6,
};
let recTimes = [];
let recWall = [];
const rpUI = {
  bar: el('replay-bar'), play: el('rp-play'), time: el('rp-time'),
  speed: el('rp-speed'), label: el('rp-label'), close: el('rp-close'),
};

function setPlayIcon(playing) {
  rpUI.play.querySelector('.ic-pause').hidden = !playing;
  rpUI.play.querySelector('.ic-play').hidden = playing;
}

function startRecording() {
  rec = [];
  recTimes = [];
  recWall = [];
  recOn = true;
}

function snapshot() {
  const a = new Float32Array(16 * 8);
  sim.balls.forEach((b) => {
    const p = b.body.translation(), q = b.body.rotation();
    // index by ball id — the rack layout is NOT id-ordered ([1],[9,2],[10,8,3]...)
    a.set([p.x, p.y, p.z, q.x, q.y, q.z, q.w, b.active ? 1 : 0], b.id * 8);
  });
  rec.push(a);
  recTimes.push(sim.time());
  recWall.push(performance.now() / 1000);
  if (rec.length > REPLAY_MAX) { rec.shift(); recTimes.shift(); recWall.shift(); }
}

/** fractional frame index for a wall-second offset into the recording */
function frameAtSec(sec) {
  if (!recWall.length) return 0;
  const target = recWall[0] + sec;
  if (target <= recWall[0]) return 0;
  for (let i = 1; i < recWall.length; i++) {
    if (recWall[i] >= target) {
      const f = (target - recWall[i - 1]) / Math.max(1e-6, recWall[i] - recWall[i - 1]);
      return i - 1 + Math.min(1, f);
    }
  }
  return recWall.length - 1;
}

function applyReplayFrame(t) {
  const i0 = Math.min(Math.floor(t), rec.length - 1);
  const i1 = Math.min(i0 + 1, rec.length - 1);
  const f = t - i0;
  const A = rec[i0], B = rec[i1];
  for (let i = 0; i < 16; i++) {
    const mesh = world.ballMeshes.get(i);
    if (!mesh) continue;
    const o = i * 8;
    const active = A[o + 7] > 0.5;
    mesh.visible = active;
    if (!active) continue;
    mesh.position.set(
      A[o] + (B[o] - A[o]) * f,
      A[o + 1] + (B[o + 1] - A[o + 1]) * f,
      A[o + 2] + (B[o + 2] - A[o + 2]) * f
    );
    mesh.quaternion.set(
      A[o + 3] + (B[o + 3] - A[o + 3]) * f,
      A[o + 4] + (B[o + 4] - A[o + 4]) * f,
      A[o + 5] + (B[o + 5] - A[o + 5]) * f,
      A[o + 6] + (B[o + 6] - A[o + 6]) * f
    ).normalize();
  }
}

function enterReplay() {
  if (replay.on || rec.length < 10) return;
  replay.on = true;
  replay.sec = 0;
  replay.playing = true;
  if (document.pointerLockElement) document.exitPointerLock();
  ui.overlay.classList.add('hidden');
  ui.aimUI.style.display = 'none';
  ui.crosshair.style.display = 'none';
  world.cue.visible = false;
  world.aimLine.visible = false;
  world.corridor.a.visible = world.corridor.b.visible = false;
  world.ghost.visible = false;
  world.objPath.visible = false;
  world.cuePath.visible = false;
  rpUI.bar.style.display = 'flex';
  rpUI.time.max = String(rec.length - 1);
  rpUI.time.value = '0';
  setPlayIcon(true);
  ui.mode.textContent = t('modeReplay');
  ui.hint.textContent = t('hintReplay');
  // start the orbit from the current camera direction, but frame the whole table
  const rel = camera.position.clone().sub(new THREE.Vector3(0, TABLE_Y, 0));
  replay.orbitYaw = Math.atan2(rel.z, rel.x);
  replay.orbitPitch = 0.62;
  replay.orbitDist = 3.0;
}

function exitReplay() {
  if (!replay.on) return;
  replay.on = false;
  rpUI.bar.style.display = 'none';
  syncBalls(world, sim.state());
  setMode(player.mode === 'rolling' ? 'walk' : player.mode);
  resumeControl();
}

function updateReplay(dt) {
  const dur = recWall.length ? recWall[recWall.length - 1] - recWall[0] : 0;
  if (replay.playing) {
    replay.sec += dt * replay.speed;
    if (replay.sec >= dur) {
      replay.sec = dur;
      replay.playing = false;
      setPlayIcon(false);
      if (autoOrbit) { autoOrbit = false; exitReplay(); return; }
    }
  }
  if (autoOrbit) replay.orbitYaw += dt * 0.12;
  const f = frameAtSec(replay.sec);
  applyReplayFrame(f);
  rpUI.time.value = String(Math.round(f));
  rpUI.label.textContent = `${replay.sec.toFixed(1)}s / ${dur.toFixed(1)}s`;
  const cp = replay.orbitPitch, cy = replay.orbitYaw, R = replay.orbitDist;
  camera.position.set(
    Math.cos(cp) * Math.cos(cy) * R,
    TABLE_Y + Math.sin(cp) * R,
    Math.cos(cp) * Math.sin(cy) * R
  );
  camera.lookAt(0, TABLE_Y, 0);
}

rpUI.play.addEventListener('click', () => {
  const dur = recWall.length ? recWall[recWall.length - 1] - recWall[0] : 0;
  if (replay.sec >= dur) replay.sec = 0;
  replay.playing = !replay.playing;
  setPlayIcon(replay.playing);
});
rpUI.time.addEventListener('input', () => {
  replay.sec = Math.max(0, (recWall[Number(rpUI.time.value)] ?? recWall[0]) - (recWall[0] ?? 0));
  replay.playing = false;
  setPlayIcon(false);
});
rpUI.speed.addEventListener('change', () => {
  replay.speed = Number(rpUI.speed.value);
});
rpUI.close.addEventListener('click', exitReplay);

// ---------------------------------------------------------------- reward system
// L1 pot close-up · L2 technique badge · L3 streak show.
// Every displayed number is measured from real physics — nothing staged.
const reward = { streak: 0, fired: new Set(), autoPotCam: true };
const badgeEl = el('badge');
const bigBadgeEl = el('big-badge');
const streakEl = el('streak');
let shot = null;
let shake = 0;
let poke = null;
let autoOrbit = false;
const potCam = { on: false, sec: 0, to: 0, pocket: 0, pending: 0 };

function rumble(strength, ms = 30) {
  try {
    const gp = navigator.getGamepads?.()[0];
    gp?.vibrationActuator?.playEffect('dual-rumble', {
      duration: ms, strongMagnitude: strength, weakMagnitude: strength * 0.6,
    });
  } catch (_) { /* no gamepad */ }
}

function showBadge(title, metric, big = false) {
  const e = big ? bigBadgeEl : badgeEl;
  e.querySelector('.b-title').textContent = title;
  e.querySelector('.b-metric').textContent = metric || '';
  e.classList.add('show');
  clearTimeout(e._t);
  e._t = setTimeout(() => e.classList.remove('show'), big ? 3200 : 2200);
}

function trackShot(events) {
  if (!shot) return;
  let maxImp = 0;
  for (const e of events) {
    if (e.type === 'hit') {
      maxImp = Math.max(maxImp, e.impulse || 0);
      if (!shot.firstContact) {
        shot.firstContact = e;
        const objId = e.a === 0 ? e.b : e.a;
        shot.contactInfo = {
          cuePos: shot.prevPos.get(0),
          objPos: shot.prevPos.get(objId),
          objId,
        };
      } else if (e.a !== 0 && e.b !== 0) {
        shot.combos.add(e.a).add(e.b);
      }
    } else if (e.type === 'cushion') {
      const id = e.a === -1 ? e.b : e.a;
      if (!shot.firstContact && id === 0) shot.cueBank++;
      else if (shot.firstContact && id !== 0) shot.objBanks.add(id);
    } else if (e.type === 'pocket') {
      shot.pots.push(e);
    }
  }
  if (maxImp > 0.25) {
    shake = Math.min(0.8, Math.max(shake, Math.log10(1 + maxImp) * 0.5));
    if (maxImp > 1.2) rumble(Math.min(1, maxImp / 6), 35);
  }
}

function evaluateShot() {
  if (!shot) return;
  const s = shot;
  shot = null;
  // game already decided: rulesAfterShot showed the win badge — no rewards on top
  if (match.on && match.over) return;
  const pots = s.pots.filter((p) => p.id !== 0);
  s.scratch = s.pots.some((p) => p.id === 0);
  const nPot = pots.length;

  // streak counter
  reward.streak = nPot > 0 ? reward.streak + 1 : 0;
  streakEl.querySelector('.streak-text').textContent = t('streakN', reward.streak);
  streakEl.classList.toggle('show', reward.streak >= 2);

  // measured geometry
  let cut = 0, distCue = 0, follow = 0;
  if (s.contactInfo && s.contactInfo.cuePos && s.contactInfo.objPos) {
    const nx = s.contactInfo.objPos.x - s.contactInfo.cuePos.x;
    const nz = s.contactInfo.objPos.z - s.contactInfo.cuePos.z;
    const nl = Math.hypot(nx, nz) || 1;
    cut = Math.abs(Math.acos(Math.max(-1, Math.min(1, (s.dir.x * nx + s.dir.z * nz) / nl)))) * 180 / Math.PI;
    distCue = Math.hypot(s.contactInfo.cuePos.x - s.cueStart.x, s.contactInfo.cuePos.z - s.cueStart.z);
    const cf = sim.ball(0).body.translation();
    follow = (cf.x - s.contactInfo.cuePos.x) * s.dir.x + (cf.z - s.contactInfo.cuePos.z) * s.dir.z;
  }
  const potDetails = pots.map((p) => {
    const pk = sim.pockets[p.pocket];
    const e = s.prevPos.get(p.id) || { x: pk.x, z: pk.z, px: pk.x, pz: pk.z };
    // entry accuracy = angle between approach velocity and direction to pocket center
    let ax = e.x - e.px, az = e.z - e.pz;
    const al = Math.hypot(ax, az);
    let cosA = 1;
    if (al > 1e-6) {
      const tx = pk.x - e.x, tz = pk.z - e.z;
      const tl = Math.hypot(tx, tz) || 1;
      cosA = (ax * tx + az * tz) / (al * tl);
    }
    return {
      id: p.id,
      pocket: p.pocket,
      t: p.t,
      cosA,
      dPocket: s.contactInfo && p.id === s.contactInfo.objId
        ? Math.hypot(s.contactInfo.objPos.x - pk.x, s.contactInfo.objPos.z - pk.z)
        : 0,
    };
  });
  const bankPot = pots.some((p) => s.objBanks.has(p.id));
  const comboPot = pots.some((p) => s.combos.has(p.id));
  const clearTable = sim.balls.filter((b) => !b.potted && b.id !== 0).length === 0;
  const longPot = potDetails.some((p) => p.dPocket > 1.5) || (nPot > 0 && distCue > 1.2);
  const central = nPot === 1 && potDetails[0].cosA > 0.94;
  const edgePot = nPot === 1 && potDetails[0].cosA < 0.78;

  // tier decisions — highest priority wins
  let badge = null, big = null;
  if (clearTable) big = [t('bClearT'), t('bClearM')];
  else if (s.cueBank > 0 && nPot > 0) badge = [t('bEscapePotT'), t('bEscapePotM')];
  else if (!s.isBreak && nPot >= 2) badge = [nPot >= 3 ? t('bTripleT') : t('bDoubleT'), t('bShotsInOne', nPot)];
  else if (s.isBreak && nPot >= 2) badge = [t('bBreakRunT'), t('bBreakPots', nPot)];
  else if (cut > 60 && nPot > 0) badge = [t('bExtremeCutT'), t('bCutAngle', cut.toFixed(0))];
  else if (cut > 45 && nPot > 0) badge = [t('bFineCutT'), t('bCutAngle', cut.toFixed(0))];
  else if (bankPot) badge = [t('bBankT'), t('bBankM')];
  else if (comboPot) badge = [t('bComboT'), t('bComboM')];
  else if (s.isBreak && nPot > 0 && !s.scratch) badge = [t('bBreakPotT'), nPot > 1 ? t('bBreakPots', nPot) : ''];
  else if (longPot) badge = [t('bLongT'), distCue > 1.2 ? t('bLongDist', distCue.toFixed(1)) : ''];
  else if (follow < -0.3 && nPot > 0) badge = [t('bDrawT'), t('bDrawDist', (-follow).toFixed(1))];
  else if (follow > 0.4 && nPot > 0) badge = [t('bFollowT'), t('bFollowDist', follow.toFixed(1))];
  else if (central) badge = [t('bCenterT'), t('bCenterM')];
  else if (edgePot) badge = [t('bEdgeT'), t('bEdgeM')];
  else if (s.cueBank > 0) badge = [t('bRailT'), t('bRailM')];

  const streakFire = (reward.streak === 3 || reward.streak === 5) && !reward.fired.has(reward.streak);
  reward.lastFirstPot = potDetails[0] || null;

  if (big || streakFire) {
    const title = big ? big[0] : reward.streak >= 5 ? t('bGodlikeT') : t('bOnFireT');
    const metric = big ? big[1] : t('streakN', reward.streak);
    showBadge(title, metric, true);
    audio.bigSting();
    if (streakFire) reward.fired.add(reward.streak);
    if (rec.length > 30) {
      autoOrbit = true;
      setTimeout(() => {
        if (!replay.on) {
          enterReplay();
          replay.speed = 1;
          rpUI.speed.value = '1';
          replay.playing = true;
        }
      }, 900);
    }
  } else {
    if (badge) {
      showBadge(badge[0], badge[1]);
      audio.badgeSting();
    }
    if (nPot > 0 && reward.autoPotCam) potCam.pending = performance.now() + (badge ? 800 : 500);
  }
}

// ---------------------------------------------------------------- rules: local 2-player 8-ball
// Simplified Chinese 8-ball. The table stays open until the first post-break
// pot assigns solids/stripes; potting your own group keeps the turn; fouls
// (scratch, no contact, wrong first ball) hand the opponent ball-in-hand
// behind the head string; clear your group, then sink the 8 to win.
const SOLID = '全色';
const STRIPE = '花色';
const match = {
  on: true,          // G toggles between match and free practice
  over: false,
  open: true,        // groups unassigned
  turn: 0,           // index into players
  ballInHand: false, // opponent fouled: current player may place the cue (F)
  players: [{ name: playerName(0), group: null }, { name: playerName(1), group: null }],
};
const groupOf = (id) => (id === 8 ? '8' : id < 8 ? SOLID : STRIPE);
const activeGroupBalls = (g) => sim.balls.filter((b) => b.active && b.id !== 0 && groupOf(b.id) === g);

function resetMatch() {
  match.over = false;
  match.open = true;
  match.turn = 0;
  match.ballInHand = false;
  for (const p of match.players) p.group = null;
  updateScoreboard();
}

const groupName = (g) => (g === SOLID ? t('solid') : t('stripe'));

function groupLabel(p) {
  if (!p.group) return t('undecided');
  return activeGroupBalls(p.group).length === 0 ? t('onEight') : groupName(p.group);
}

// mini ball icons for the scoreboard cards — same palette as the 3D balls
const ballIconCache = new Map();
function ballIcon(id) {
  if (ballIconCache.has(id)) return ballIconCache.get(id);
  const S = 44; // 2× for retina
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const x = c.getContext('2d');
  const R = S / 2;
  const col = BALL_COLORS[id > 8 ? id - 8 : id];
  x.beginPath(); x.arc(R, R, R - 1, 0, 7);
  x.fillStyle = id > 8 ? '#f8f6f0' : col;
  x.fill();
  if (id > 8) { // stripe band
    x.save();
    x.beginPath(); x.arc(R, R, R - 1, 0, 7); x.clip();
    x.fillStyle = col;
    x.fillRect(0, S * 0.27, S, S * 0.46);
    x.restore();
  }
  x.beginPath(); x.arc(R, R, S * 0.24, 0, 7); x.fillStyle = '#f8f6f0'; x.fill();
  x.fillStyle = '#141210';
  x.font = `bold ${S * 0.3}px Arial`;
  x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText(id, R, R + 1);
  const g = x.createRadialGradient(R * 0.72, R * 0.55, 1, R, R, R);
  g.addColorStop(0, 'rgba(255,255,255,.55)');
  g.addColorStop(0.4, 'rgba(255,255,255,0)');
  x.fillStyle = g;
  x.beginPath(); x.arc(R, R, R - 1, 0, 7); x.fill();
  const url = c.toDataURL();
  ballIconCache.set(id, url);
  return url;
}

function updateScoreboard() {
  ui.scoreboard.style.display = match.on ? 'flex' : 'none';
  if (!match.on) return;
  match.players.forEach((p, i) => {
    const card = ui.pcards[i];
    card.classList.toggle('cur', !match.over && match.turn === i);
    card.querySelector('.pc-name').textContent = p.name;
    card.querySelector('.pc-group').textContent = groupLabel(p);
    const row = card.querySelector('.pc-balls');
    row.innerHTML = '';
    if (!p.group) return;
    const ids = p.group === SOLID ? [1, 2, 3, 4, 5, 6, 7] : [9, 10, 11, 12, 13, 14, 15];
    const cleared = activeGroupBalls(p.group).length === 0;
    for (const id of ids) {
      const img = document.createElement('img');
      img.src = ballIcon(id);
      img.className = 'pc-ball' + (sim.ball(id).active ? '' : ' down');
      row.appendChild(img);
    }
    if (cleared) {
      const img = document.createElement('img');
      img.src = ballIcon(8);
      img.className = 'pc-ball target8';
      row.appendChild(img);
    }
  });
}

function respotEight() {
  for (const dx of [0, 0.07, -0.07, 0.14, -0.14]) {
    const x = TABLE_HX / 2 + dx;
    const blocked = sim.balls.some((b) => {
      if (!b.active) return false;
      const p = b.body.translation();
      return Math.hypot(p.x - x, p.z) < BALL_R * 2.2;
    });
    if (!blocked) { sim.placeBall(8, x, 0); return; }
  }
  sim.placeBall(8, TABLE_HX / 2, 0.1);
}

/** Runs once per shot when all balls have settled (before evaluateShot consumes `shot`). */
function rulesAfterShot() {
  if (!match.on || match.over || !shot) return;
  const s = shot;
  const me = match.turn, opp = 1 - me;
  const P = match.players;
  const wasOpen = match.open;
  const myGroup = P[me].group;
  const pots = s.pots.filter((p) => p.id !== 0).map((p) => p.id);
  const scratch = s.pots.some((p) => p.id === 0);
  const firstObj = s.firstContact ? (s.firstContact.a === 0 ? s.firstContact.b : s.firstContact.a) : null;
  const anyObjActive = sim.balls.some((b) => b.active && b.id !== 0);
  const myPots = myGroup ? pots.filter((id) => groupOf(id) === myGroup) : [];
  // "on the 8" = own group was already cleared BEFORE this shot
  const onEight = !wasOpen && !!myGroup && activeGroupBalls(myGroup).length + myPots.length === 0;
  let msg = null;
  window.__rulesProbe = { wasOpen, myGroup, myPots, activeOfMyGroup: activeGroupBalls(myGroup).length, onEight, pots, scratch, firstObj, isBreak: s.isBreak };

  // 8-ball down decides the game (on the break it just respots)
  if (pots.includes(8) && !s.isBreak) {
    match.over = true;
    const legal = onEight && !scratch && firstObj === 8;
    const win = legal ? me : opp;
    const why = legal ? t('winLegal') : scratch ? t('winScratch8') : t('winEarly8');
    showBadge(t('win', P[win].name), why, true);
    audio.bigSting();
    updateScoreboard();
    return;
  }

  let foul = null;
  if (scratch) foul = t('foulScratch');
  else if (firstObj == null) foul = anyObjActive ? t('foulNoContact') : null;
  else if (firstObj === 8) foul = onEight ? null : t('foulEightFirst');
  else if (!wasOpen && myGroup && groupOf(firstObj) !== myGroup) foul = t('foulWrongFirst');

  if (pots.includes(8)) { respotEight(); msg = t('break8'); }

  if (wasOpen && !s.isBreak && !foul && pots.length > 0 && groupOf(pots[0]) !== '8') {
    const g = groupOf(pots[0]);
    P[me].group = g;
    P[opp].group = g === SOLID ? STRIPE : SOLID;
    match.open = false;
    msg = t('assign', P[me].name, groupName(g));
  }

  const kept = !foul && (wasOpen ? pots.length > 0 : myPots.length > 0);
  if (!kept) match.turn = opp;
  if (foul) { match.ballInHand = true; msg = t('foul', foul, P[opp].name); }
  else if (!kept) msg = msg ? `${msg} · ${t('switchTo', P[match.turn].name)}` : t('switchTo', P[match.turn].name);
  else if (msg) msg += ` · ${t('continuePlay')}`;
  if (msg) toast(msg, 2400);
  updateScoreboard();
}

updateScoreboard();

function startPotCam(pot) {
  if (rec.length < 30) return;
  let f0 = recTimes.findIndex((t) => t >= pot.t);
  if (f0 < 10) f0 = Math.max(10, rec.length - 20);
  potCam.on = true;
  potCam.sec = Math.max(0, (recWall[Math.max(0, f0 - 54)] ?? recWall[0]) - (recWall[0] ?? 0));
  potCam.to = ((recWall[Math.min(rec.length - 1, f0 + 15)] ?? recWall[recWall.length - 1]) ?? 0) - (recWall[0] ?? 0);
  potCam.pocket = pot.pocket;
  potCam.pending = 0;
  if (document.pointerLockElement) document.exitPointerLock();
  ui.overlay.classList.add('hidden');
  ui.aimUI.style.display = 'none';
  world.cue.visible = false;
  world.aimLine.visible = false;
  world.corridor.a.visible = world.corridor.b.visible = false;
  world.ghost.visible = false;
  world.objPath.visible = false;
  world.cuePath.visible = false;
  toast(t('potcamToast'), 1500);
}

function exitPotCam() {
  if (!potCam.on) return;
  potCam.on = false;
  syncBalls(world, sim.state());
  setMode('aim');
  resumeControl();
}

/** Re-acquire pointer lock after an auto-played sequence. The browser only
 *  grants it inside a (recent) user-gesture window, so fall back to a hint. */
function resumeControl() {
  if (document.pointerLockElement === canvas) return;
  try { canvas.requestPointerLock?.()?.catch?.(() => {}); } catch (_) {}
  setTimeout(() => {
    if (document.pointerLockElement !== canvas && !replay.on && !potCam.on) {
      toast(t('clickContinue'), 2000);
    }
  }, 150);
}

/** Settle bookkeeping: one place for the frame loop and the debug driver. */
function onSettled() {
  recOn = false;
  const scratched = !sim.ball(0).active;
  rulesAfterShot();
  if (scratched) {
    // match + foul → the incoming player places the cue by hand (WASD);
    // practice mode keeps the old auto spot behind the head string
    if (match.on && match.ballInHand && !match.over) enterPlaceMode();
    else respotCue();
  }
  evaluateShot();
  if (player.mode !== 'place') setMode('aim');
  if (rec.length > 30) ui.hint.textContent += t('hintReplaySuffix');
}

// ---------------------------------------------------------------- main loop
let last = performance.now();
let acc = 0;
const MAX_STEPS = 24; // 12.5 ms of physics per frame at most; below ~40 fps sim time dilates

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  trackPerf(dt);

  // dust motes drift slowly in the lamp beam
  world.dust.rotation.y += dt * 0.018;
  world.dust.position.y = Math.sin(now / 4200) * 0.03;

  if (potCam.on) {
    potCam.sec += dt; // real-time (1×) close-up replay
    if (potCam.sec >= potCam.to) {
      exitPotCam();
    } else {
      applyReplayFrame(frameAtSec(potCam.sec));
      const pk = sim.pockets[potCam.pocket];
      const il = Math.hypot(pk.x, pk.z) || 1;
      const nx = -pk.x / il, nz = -pk.z / il;
      camera.position.set(pk.x + nx * 0.55, TABLE_Y + 0.42, pk.z + nz * 0.55);
      camera.lookAt(pk.x, TABLE_Y, pk.z);
      renderFrame();
    }
    return;
  }

  if (replay.on) {
    updateReplay(dt);
    renderFrame();
    return;
  }

  acc += dt;
  let steps = 0;
  while (acc >= DT && steps < MAX_STEPS) {
    sim.step();
    acc -= DT;
    steps++;
  }
  if (steps === MAX_STEPS) acc = 0;

  {
    const events = sim.drainEvents();
    playEvents(events);
    trackShot(events);
  }
  if (shot) {
    for (const b of sim.balls) {
      if (!b.active) continue;
      const p = b.body.translation();
      const old = shot.prevPos.get(b.id);
      shot.prevPos.set(b.id, { x: p.x, z: p.z, px: old ? old.x : p.x, pz: old ? old.z : p.z });
    }
  }

  // rolling rumble follows the fastest ball on the table
  {
    let maxV = 0;
    for (const b of sim.balls) {
      if (!b.active) continue;
      const v = b.body.linvel();
      const s = Math.hypot(v.x, v.z);
      if (s > maxV) maxV = s;
    }
    audio.setRoll(maxV / MAX_V);
  }

  syncBalls(world, sim.state());

  if (recOn) snapshot();

  // darts: projectile flight + stuck-dart fades run in every mode
  darts3d.updateFlight(dt, onDartLand);
  darts3d.update(dt);

  if (player.charging) {
    player.charge += dt / 1.15;
    if (player.charge > 1) player.charge = 0.12; // ping back, feels like a backswing reset
  }
  const powerNow = player.mode === 'darts'
    ? (darts.charging ? darts.charge : darts.power)
    : (player.charging ? player.charge : player.power);
  ui.power.style.height = `${Math.round(powerNow * 100)}%`;

  if (player.mode === 'rolling' && sim.isSettled()) onSettled();

  // pot close-up trigger (deferred a beat so the badge lands first)
  if (potCam.pending && now >= potCam.pending && !replay.on && player.mode === 'aim') {
    if (reward.lastFirstPot) startPotCam(reward.lastFirstPot);
    potCam.pending = 0;
  }

  if (menu.idle && intro.on) updateIntro(dt);
  else if (menu.idle && player.mode === 'walk') updateMenuCam(dt);
  else if (player.mode === 'walk') updateWalk(dt);
  else if (player.mode === 'aim') updateAim();
  else if (player.mode === 'place') updatePlace(dt);
  else if (player.mode === 'rolling') updateRollingCam(dt);
  else if (player.mode === 'darts') updateDarts(dt);
  else if (player.mode === 'dice') barGames.dice.update(dt, now / 1000);
  else if (player.mode === 'roulette') barGames.roulette.update(dt, now / 1000);
  else updateSpectator(dt);

  // L0: cue poke-through + camera micro-kick
  if (poke) {
    poke.t -= dt;
    if (poke.t <= 0) { world.cue.visible = false; poke = null; }
    else {
      world.cue.visible = true;
      world.cue.position.addScaledVector(poke.dir, dt * 2.4);
    }
  }
  if (shake > 0.004 && !replay.on) {
    camera.rotateX((Math.random() - 0.5) * 0.006 * shake);
    camera.rotateY((Math.random() - 0.5) * 0.006 * shake);
    shake *= Math.exp(-9 * dt);
  }

  if (player.mode === 'aim' || player.mode === 'rolling') drawSpinPad();
  ui.shots.textContent = t('shots', shots);
  ui.potted.textContent = t('potted', sim.balls.filter((b) => b.potted && b.id !== 0).length);

  renderFrame();
}

// boot state
ui.mode.textContent = t('modeWalk');
ui.hint.textContent = t('hintWalk');
window.__game = { sim: () => sim, player, rerack, match };
window.__world = world;
window.__cam = camera;
window.__renderer = renderer;
window.__composer = finalComposer;
window.__bloom = bloom;
window.__audio = audio;
window.__debug = { setMode, tryEnterAim, strike, respotCue, enterReplay, exitReplay, replay, reward, potCam, evaluateShot, rulesAfterShot, onSettled, enterPlaceMode, confirmPlace, updatePlace: (dt) => updatePlace(dt ?? 1 / 60), introStep: (dt) => updateIntro(dt ?? 1 / 60), render: () => renderFrame(), shotInfo: () => (shot ? { pots: shot.pots.map((p) => p.id), firstContact: shot.firstContact ? [shot.firstContact.a, shot.firstContact.b] : null, isBreak: shot.isBreak } : null), flush: () => { const ev = sim.drainEvents(); playEvents(ev); trackShot(ev); }, snapshot: () => { if (recOn) snapshot(); }, enterDarts, exitDarts, throwDart, darts, updateDarts: (dt) => updateDarts(dt ?? 0), barGames, enterDice, enterRoulette, exitBar, throwDartAt: (dy, dz) => {
  const from = new THREE.Vector3(OCHE.x, OCHE.y - 0.07, OCHE.z);
  const target = { x: darts3d.board.faceX, y: BOARD_C.y + dy, z: BOARD_C.z + dz };
  const v = solveLaunch({ x: from.x, y: from.y, z: from.z }, target, 8.5);
  darts3d.spawnDart(from, new THREE.Vector3(v.x, v.y, v.z));
} };
window.__darts = darts3d;
window.__renderOnce = () => {
  syncBalls(world, sim.state());
  if (player.mode === 'aim' || player.mode === 'rolling') updateAim();
  else if (player.mode === 'place') updatePlace(0);
  else if (player.mode === 'walk') updateWalk(0);
  renderFrame();
};
reward.autoPotCam = localStorage.getItem('potcam') !== 'off';
el('hud').style.display = 'none'; // hidden until the menu's start button
applyLang();
setMode('walk');
requestAnimationFrame(frame);
