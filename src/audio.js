// audio.js — real billiards samples (CC0, see assets/LICENSES.md) + procedural
// room reverb / compressor / rolling rumble. No external IR files: the reverb
// impulse response is generated from decaying noise.
//
// Master chain: source → masterGain → compressor → dry → destination
//                                              └→ convolver → wet → destination

const FILES = {
  clack: 'assets/sfx/clack.mp3',     // ball-ball clack (Za-Games, CC0)
  clack2: 'assets/sfx/clack2.mp3',   // clack variant (PeterGozz, CC0)
  clack3: 'assets/sfx/clack3.mp3',   // clack variant (PeterGozz, CC0)
  cue: 'assets/sfx/cue.mp3',         // cue strike (13FPanska_Marval_Lukas, CC0)
  cushion: 'assets/sfx/cushion.mp3', // rail bounce (mccarthy@bedmas.com, CC0)
  pocket: 'assets/sfx/pocket.mp3',   // pocket drop + rattle (AmberdeMeillon, CC0)
  crowd: 'assets/sfx/crowd.mp3',     // crowd cheer (BerlinGameScene, CC0)
  break: 'assets/sfx/break.mp3',     // break crack (Freesound 204187, CC0)
  rack: 'assets/sfx/rack.mp3',       // rack rattle (Freesound 274566, CC0)
  bgm: 'assets/sfx/bgm-lounge.mp3',  // lounge jazz loop (user-provided)
};
const CLACKS = ['clack', 'clack2', 'clack3'];

export function createAudio() {
  let ctx = null;
  let master, comp, convolver, rollGain;
  const buffers = new Map();
  let muted = false;
  try { muted = localStorage.getItem('billiards-muted') === '1'; } catch (_) {}

  function makeIR(c, dur = 1.6, decay = 3.2) {
    const len = Math.floor(c.sampleRate * dur);
    const ir = c.createBuffer(2, len, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return ir;
  }

  function ensure() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();

      master = ctx.createGain();
      master.gain.value = muted ? 0 : 0.7;

      comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -10;
      comp.knee.value = 8;
      comp.ratio.value = 8;
      comp.attack.value = 0.002;

      const dry = ctx.createGain();
      dry.gain.value = 0.85;
      convolver = ctx.createConvolver();
      convolver.buffer = makeIR(ctx);
      const wet = ctx.createGain();
      wet.gain.value = 0.25;

      master.connect(comp);
      comp.connect(dry).connect(ctx.destination);
      comp.connect(convolver).connect(wet).connect(ctx.destination);

      // rolling rumble: brown-noise loop through a lowpass, gain driven per frame
      rollGain = ctx.createGain();
      rollGain.gain.value = 0;
      const noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const nd = noiseBuf.getChannelData(0);
      let last = 0;
      for (let i = 0; i < nd.length; i++) {
        const w = Math.random() * 2 - 1;
        last = (last + 0.02 * w) / 1.02;
        nd[i] = last * 3.5;
      }
      const rollSrc = ctx.createBufferSource();
      rollSrc.buffer = noiseBuf;
      rollSrc.loop = true;
      const rollLP = ctx.createBiquadFilter();
      rollLP.type = 'lowpass';
      rollLP.frequency.value = 260;
      rollSrc.connect(rollLP).connect(rollGain).connect(master);
      rollSrc.start();

      // load samples asynchronously; playback silently skips until ready
      for (const [key, url] of Object.entries(FILES)) {
        fetch(url)
          .then((r) => r.arrayBuffer())
          .then((ab) => ctx.decodeAudioData(ab))
          .then((buf) => {
            buffers.set(key, buf);
            if (key === 'bgm') startBgm();
          })
          .catch((e) => console.warn('sfx load failed:', key, e));
      }
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  // looping lounge BGM at a low sit level; routed through master so the M
  // mute and the compressor apply to it like everything else
  let bgmStarted = false;
  function startBgm() {
    if (bgmStarted) return;
    const buf = buffers.get('bgm');
    if (!buf) return;
    bgmStarted = true;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const g = ctx.createGain();
    g.gain.value = 0.24;
    src.connect(g).connect(master);
    src.start();
  }

  function play(key, { gain = 0.5, rate = 1, jitter = 0.04 } = {}) {
    const c = ensure();
    const buf = buffers.get(key);
    if (!buf) return;
    const src = c.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate * (1 + (Math.random() * 2 - 1) * jitter);
    const g = c.createGain();
    g.gain.value = gain;
    src.connect(g).connect(master);
    src.start(c.currentTime);
  }

  // synthesized "punch" layered under the samples: HF transient tick + LF body
  // thump. This is what makes hits feel 爽 instead of just accurate.
  function punch(gain, { bodyHz = 140, bodyGain = 0.6 } = {}) {
    const c = ensure();
    const t = c.currentTime;
    // transient tick
    const tickLen = 0.006;
    const tb = c.createBuffer(1, c.sampleRate * tickLen, c.sampleRate);
    const td = tb.getChannelData(0);
    for (let i = 0; i < td.length; i++) td[i] = (Math.random() * 2 - 1) * (1 - i / td.length);
    const ts = c.createBufferSource();
    ts.buffer = tb;
    const hp = c.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 3800;
    const tg = c.createGain();
    tg.gain.value = gain;
    ts.connect(hp).connect(tg).connect(master);
    ts.start(t);
    // body thump
    const osc = c.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(bodyHz, t);
    osc.frequency.exponentialRampToValueAtTime(bodyHz * 0.55, t + 0.07);
    const og = c.createGain();
    og.gain.setValueAtTime(gain * bodyGain, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
    osc.connect(og).connect(master);
    osc.start(t);
    osc.stop(t + 0.1);
  }

  // impulse → perceptual gain, with a contrast curve so hard hits feel LOUD
  const norm = (x, ref) => Math.pow(Math.min(1, Math.log10(1 + (x / ref) * 9)), 1.5);

  return {
    unlock: ensure,
    isMuted: () => muted,
    bgmPlaying: () => bgmStarted,
    toggleMute() {
      muted = !muted;
      try { localStorage.setItem('billiards-muted', muted ? '1' : '0'); } catch (_) {}
      if (ctx) master.gain.value = muted ? 0 : 0.7;
      return muted;
    },
    loadedSamples: () => buffers.size,
    cueStrike(power, isBreak = false) {
      if (isBreak) play('break', { gain: 0.35 + power * 0.85, jitter: 0.02 });
      else play('cue', { gain: 0.45 + power * 0.85, jitter: 0.02 });
      punch(0.3 + power * 0.6, { bodyHz: 150, bodyGain: 0.75 });
    },
    rerack() { play('rack', { gain: 0.8 }); },
    ballHit(impulse) {
      const n = norm(impulse, 0.35);
      play(CLACKS[(Math.random() * CLACKS.length) | 0], { gain: 0.1 + n * 1.15 });
      if (n > 0.12) punch(n * 0.95, { bodyHz: 130, bodyGain: 0.6 });
    },
    cushion(impulse) {
      const n = norm(impulse, 0.6);
      play('cushion', { gain: 0.08 + n * 0.55, rate: 0.85 });
      if (n > 0.1) punch(n * 0.6, { bodyHz: 100, bodyGain: 0.85 });
    },
    pocket() {
      play('pocket', { gain: 1.05 });
      punch(0.7, { bodyHz: 82, bodyGain: 1.2 });
    },
    /** dart release: short filtered-noise whoosh */
    dartThrow() {
      const c = ensure();
      const t = c.currentTime;
      const len = 0.09;
      const b = c.createBuffer(1, c.sampleRate * len, c.sampleRate);
      const d = b.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.sin(Math.PI * i / d.length);
      const src = c.createBufferSource();
      src.buffer = b;
      const bp = c.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(900, t);
      bp.frequency.exponentialRampToValueAtTime(2400, t + len);
      bp.Q.value = 1.2;
      const g = c.createGain();
      g.gain.value = 0.5;
      src.connect(bp).connect(g).connect(master);
      src.start(t);
    },
    /** dart bites the board: woody knock; harder gain for rings/bull */
    dartHit(gain = 0.8) {
      punch(gain, { bodyHz: 190, bodyGain: 1.0 });
      play('cue', { gain: 0.22 * gain, rate: 0.6, jitter: 0.02 });
    },
    /** off the board: dull clatter down the wall + floor tick */
    dartMiss() {
      play('cushion', { gain: 0.3, rate: 0.55 });
      punch(0.25, { bodyHz: 90, bodyGain: 0.7 });
    },
    /** dice cup lands back on the tray */
    cupThud() {
      punch(0.5, { bodyHz: 120, bodyGain: 0.9 });
    },
    /** dice rattle: a burst of short noise ticks */
    diceShake() {
      const c = ensure();
      const t0 = c.currentTime;
      let tt = 0;
      for (let i = 0; i < 9; i++) {
        tt += 0.02 + Math.random() * 0.05;
        const len = 0.012;
        const b = c.createBuffer(1, c.sampleRate * len, c.sampleRate);
        const d = b.getChannelData(0);
        for (let j = 0; j < d.length; j++) d[j] = (Math.random() * 2 - 1) * (1 - j / d.length);
        const src = c.createBufferSource();
        src.buffer = b;
        const hp = c.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = 2500;
        const g = c.createGain();
        g.gain.value = 0.35 + Math.random() * 0.3;
        src.connect(hp).connect(g).connect(master);
        src.start(t0 + tt);
      }
    },
    /** single die knock, gain by impulse */
    diceTick(gain = 0.4) {
      const c = ensure();
      const t = c.currentTime;
      const len = 0.014;
      const b = c.createBuffer(1, c.sampleRate * len, c.sampleRate);
      const d = b.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
      const src = c.createBufferSource();
      src.buffer = b;
      const hp = c.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 2200;
      const g = c.createGain();
      g.gain.value = Math.min(0.7, 0.08 + gain * 0.5);
      src.connect(hp).connect(g).connect(master);
      src.start(t);
    },
    /** cylinder spin: accelerating ratchet clicks */
    ratchet() {
      const c = ensure();
      const t0 = c.currentTime;
      for (let i = 0; i < 7; i++) {
        const dt0 = 0.04 + i * i * 0.012;
        const len = 0.008;
        const b = c.createBuffer(1, c.sampleRate * len, c.sampleRate);
        const d = b.getChannelData(0);
        for (let j = 0; j < d.length; j++) d[j] = (Math.random() * 2 - 1) * (1 - j / d.length);
        const src = c.createBufferSource();
        src.buffer = b;
        const bp = c.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 3200;
        bp.Q.value = 4;
        const g = c.createGain();
        g.gain.value = 0.5;
        src.connect(bp).connect(g).connect(master);
        src.start(t0 + dt0);
      }
    },
    hammerCock() {
      const c = ensure();
      const t0 = c.currentTime;
      for (const dt0 of [0, 0.07]) {
        const len = 0.006;
        const b = c.createBuffer(1, c.sampleRate * len, c.sampleRate);
        const d = b.getChannelData(0);
        for (let j = 0; j < d.length; j++) d[j] = (Math.random() * 2 - 1) * (1 - j / d.length);
        const src = c.createBufferSource();
        src.buffer = b;
        const hp = c.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = 4000;
        const g = c.createGain();
        g.gain.value = 0.55;
        src.connect(hp).connect(g).connect(master);
        src.start(t0 + dt0);
      }
    },
    hammerDry() {
      this.hammerCock();
      punch(0.2, { bodyHz: 220, bodyGain: 0.3 });
    },
    /** the big one: noise burst + deep body, clamped by the compressor */
    gunshot() {
      const c = ensure();
      const t = c.currentTime;
      const len = 0.5;
      const b = c.createBuffer(1, c.sampleRate * len, c.sampleRate);
      const d = b.getChannelData(0);
      for (let i = 0; i < d.length; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 2.2);
      }
      const src = c.createBufferSource();
      src.buffer = b;
      const lp = c.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(9000, t);
      lp.frequency.exponentialRampToValueAtTime(400, t + 0.3);
      const g = c.createGain();
      g.gain.value = 1.6;
      src.connect(lp).connect(g).connect(master);
      src.start(t);
      punch(1.5, { bodyHz: 55, bodyGain: 1.4 });
    },
    /** ringing ears after the shot */
    tinnitus() {
      const c = ensure();
      const t0 = c.currentTime;
      const o = c.createOscillator();
      o.type = 'sine';
      o.frequency.value = 3400;
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.12, t0 + 0.05);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 2.6);
      o.connect(g).connect(master);
      o.start(t0);
      o.stop(t0 + 2.7);
    },
    /** descending two-note for losing the dice match */
    loseSting() {
      const c = ensure();
      const t0 = c.currentTime;
      for (const [f, dt0] of [[330, 0], [220, 0.14]]) {
        const o = c.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = f;
        const lp = c.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 1200;
        const g = c.createGain();
        g.gain.setValueAtTime(0.0001, t0 + dt0);
        g.gain.exponentialRampToValueAtTime(0.2, t0 + dt0 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.001, t0 + dt0 + 0.3);
        o.connect(lp).connect(g).connect(master);
        o.start(t0 + dt0);
        o.stop(t0 + dt0 + 0.32);
      }
    },
    /** short two-note stinger for technique badges */
    badgeSting() {
      const c = ensure();
      const t0 = c.currentTime;
      for (const [f, dt0] of [[440, 0], [659, 0.09]]) {
        const o = c.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = f;
        const lp = c.createBiquadFilter();
        lp.type = 'lowpass'; lp.frequency.value = 1800;
        const g = c.createGain();
        g.gain.setValueAtTime(0.0001, t0 + dt0);
        g.gain.exponentialRampToValueAtTime(0.22, t0 + dt0 + 0.015);
        g.gain.exponentialRampToValueAtTime(0.001, t0 + dt0 + 0.22);
        o.connect(lp).connect(g).connect(master);
        o.start(t0 + dt0);
        o.stop(t0 + dt0 + 0.25);
      }
    },
    /** chord + crowd cheer for streak / clear-table moments */
    bigSting() {
      const c = ensure();
      const t0 = c.currentTime;
      for (const f of [330, 415, 494, 659]) {
        const o = c.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = f;
        const lp = c.createBiquadFilter();
        lp.type = 'lowpass'; lp.frequency.value = 2200;
        const g = c.createGain();
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(0.12, t0 + 0.03);
        g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.8);
        o.connect(lp).connect(g).connect(master);
        o.start(t0);
        o.stop(t0 + 0.85);
      }
      play('crowd', { gain: 0.7, jitter: 0 });
    },
    /** level 0..1 — call every frame with (max ball speed / MAX_V). */
    setRoll(level) {
      if (!ctx || !rollGain) return;
      const target = Math.min(0.5, level * 0.35);
      rollGain.gain.setTargetAtTime(target, ctx.currentTime, 0.08);
    },
  };
}
