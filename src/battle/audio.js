/**
 * Web Audio 合成的音效与背景音乐，不加载任何音频文件。
 * 第一次用户操作后才创建音频上下文，遵守浏览器的自动播放限制；在那之前请求的音乐会记下来，解锁后再开始。
 *
 * 信号走向：各个声音 → 音效总线 / 音乐总线 → 总音量 → 输出。音乐总线另有一路短延迟回声，让合成器听起来不那么干。
 */

const midi = (n) => 440 * 2 ** ((n - 69) / 12);

/** 颤音：一个低频振荡器推着音高上下摆 depth 音分，开头 0.25 秒内慢慢加深，像演奏者揉弦。 */
function addVibrato(ctx, osc, start, duration, depth, rate = 5.2) {
  const lfo = ctx.createOscillator();
  lfo.frequency.value = rate;
  const amount = ctx.createGain();
  amount.gain.setValueAtTime(0, start);
  amount.gain.linearRampToValueAtTime(depth, start + Math.min(0.25, duration * 0.5));
  lfo.connect(amount).connect(osc.detune);
  lfo.start(start);
  lfo.stop(start + duration + 0.05);
}

/** 大厅的脉冲响应：立体声噪声按指数衰减，高频比低频衰减得快（一阶低通的系数随时间变大）。 */
function hallImpulse(ctx, seconds) {
  const rate = ctx.sampleRate;
  const length = Math.floor(rate * seconds);
  const buffer = ctx.createBuffer(2, length, rate);
  const predelay = Math.floor(rate * 0.025);
  for (let ch = 0; ch < 2; ch += 1) {
    const data = buffer.getChannelData(ch);
    let lp = 0;
    for (let i = predelay; i < length; i += 1) {
      const t = (i - predelay) / rate;
      const k = Math.min(0.92, 0.25 + t * 0.35);
      lp = lp * k + (Math.random() * 2 - 1) * (1 - k);
      data[i] = lp * Math.exp((-6.9 * t) / seconds) * 1.6;
    }
  }
  return buffer;
}
const jitter = (amount = 0.03) => 1 + (Math.random() * 2 - 1) * amount;

/** 和弦：根音 MIDI 号 + 音程。 */
const chord = (root, intervals) => intervals.map((i) => root + i);
const MAJ = [0, 4, 7];
const MIN = [0, 3, 7];
const MAJ7 = [0, 4, 7, 11];
const MIN7 = [0, 3, 7, 10];

export class Sfx {
  constructor() {
    this.enabled = true;
    this.musicEnabled = true;
    this.context = null;
    this.music = new Music(this);
  }

  unlock() {
    if (!this.enabled && !this.musicEnabled) return;
    try {
      if (!this.context) this.attach(new (window.AudioContext || window.webkitAudioContext)());
      if (this.context.state === "suspended") this.context.resume().catch(() => {});
      this.music.resume();
    } catch {
      this.enabled = false;
      this.musicEnabled = false;
    }
  }

  /** 把声音接到一个音频上下文上（实时播放用 AudioContext，分析和测试可以传 OfflineAudioContext）。 */
  attach(ctx) {
    this.context = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(ctx.destination);
    this.sfxBus = ctx.createGain();
    this.sfxBus.gain.value = 1;
    this.sfxBus.connect(this.master);
    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = this.musicEnabled ? 0.55 : 0;
    // 音乐整体压一点 5 kHz 以上的高频，听久了不刺耳。
    const soften = ctx.createBiquadFilter();
    soften.type = "highshelf";
    soften.frequency.value = 5000;
    soften.gain.value = -8;
    this.musicBus.connect(soften).connect(this.master);
    // 音乐的回声：短延迟 + 低通反馈。
    const delay = ctx.createDelay(1);
    delay.delayTime.value = 0.23;
    const feedback = ctx.createGain();
    feedback.gain.value = 0.28;
    const damp = ctx.createBiquadFilter();
    damp.type = "lowpass";
    damp.frequency.value = 2200;
    const wet = ctx.createGain();
    wet.gain.value = 0.22;
    soften.connect(delay);
    delay.connect(damp).connect(feedback).connect(delay);
    damp.connect(wet).connect(this.master);
    // 大厅混响：算法生成的脉冲响应（衰减的立体声噪声，越往后越暗），不用下载录音。
    // 每首曲子按自己的 reverb 值把声音送进来；开关跟随音乐总线。
    this.hallIn = ctx.createGain();
    this.hallIn.gain.value = this.musicEnabled ? 0.55 : 0;
    const hall = ctx.createConvolver();
    hall.buffer = hallImpulse(ctx, 3.4);
    const hallTone = ctx.createBiquadFilter();
    hallTone.type = "lowpass";
    hallTone.frequency.value = 4200;
    this.hallIn.connect(hall).connect(hallTone).connect(this.master);
    this.noiseBuffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
    return this;
  }

  setEnabled(on) {
    this.enabled = on;
    if (on) this.unlock();
  }

  setMusic(on) {
    this.musicEnabled = on;
    if (on) this.unlock();
    if (this.musicBus) this.musicBus.gain.setTargetAtTime(on ? 0.55 : 0, this.context.currentTime, 0.2);
    if (this.hallIn) this.hallIn.gain.setTargetAtTime(on ? 0.55 : 0, this.context.currentTime, 0.2);
  }

  // ——— 基础音色 ———

  /** 一个振荡器音符。bus 默认走音效总线；音乐的音符传入 musicBus。 */
  tone(
    freq,
    duration = 0.18,
    { delay = 0, at = null, volume = 0.05, type = "sine", slide = 0, attack = 0.008, bus = null, filter = 0, detune = 0, vibrato = 0 } = {},
  ) {
    const ctx = this.context;
    if (!ctx) return;
    const out = bus ?? this.sfxBus;
    if (!bus && !this.enabled) return;
    const start = at ?? ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    // 增益节点默认是 1：不先归零的话，起音的第一个采样会以满音量漏出来，听起来是一下尖锐的咔嗒声。
    gain.gain.value = 0;
    osc.type = type;
    osc.detune.value = detune;
    osc.frequency.setValueAtTime(freq, start);
    if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(20, freq + slide), start + duration);
    if (vibrato) addVibrato(ctx, osc, start, duration, vibrato);
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(volume, start + attack);
    gain.gain.exponentialRampToValueAtTime(0.0005, start + duration);
    let node = osc;
    if (filter) {
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = filter;
      node = osc.connect(lp);
    }
    node.connect(gain).connect(out);
    osc.start(start);
    osc.stop(start + duration + 0.05);
  }

  /**
   * 人声“啊”：锯齿波带颤音，经过三个并联的带通滤波器（元音 a 的三个共振峰），像远处合唱里的一个声部。
   * female：用女声的共振峰位置，颤音稍快稍深。
   */
  voice(freq, duration, { at = null, volume = 0.01, attack = 0.3, bus = null, detune = 0, female = false } = {}) {
    const ctx = this.context;
    if (!ctx || !bus) return;
    const start = at ?? ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.value = freq;
    osc.detune.value = detune;
    addVibrato(ctx, osc, start, duration, female ? 18 : 14, (female ? 5.3 : 4.6) + Math.random() * 0.8);
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(volume, start + attack);
    gain.gain.setValueAtTime(volume, start + Math.max(attack, duration * 0.7));
    gain.gain.exponentialRampToValueAtTime(0.0005, start + duration);
    const formants = female ? [[880, 7, 1], [1240, 9, 0.55], [2850, 12, 0.22]] : [[730, 6, 1], [1090, 8, 0.5], [2440, 10, 0.18]];
    for (const [f, q, g] of formants) {
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = f;
      bp.Q.value = q;
      const level = ctx.createGain();
      level.gain.value = g * 3;
      osc.connect(bp).connect(level).connect(gain);
    }
    gain.connect(bus);
    osc.start(start);
    osc.stop(start + duration + 0.05);
  }

  /** 滤波噪声：type 为 lowpass / highpass / bandpass；sweep 让滤波频率在时长内滑到另一个值。 */
  noise(duration = 0.2, { delay = 0, at = null, volume = 0.06, filter = 1200, type = "lowpass", sweep = 0, q = 1, bus = null, attack = 0.004 } = {}) {
    const ctx = this.context;
    if (!ctx) return;
    if (!bus && !this.enabled) return;
    const start = at ?? ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const bq = ctx.createBiquadFilter();
    bq.type = type;
    bq.Q.value = q;
    bq.frequency.setValueAtTime(filter, start);
    if (sweep) bq.frequency.exponentialRampToValueAtTime(Math.max(40, sweep), start + duration);
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(volume, start + attack);
    gain.gain.exponentialRampToValueAtTime(0.0005, start + duration);
    src.connect(bq).connect(gain).connect(bus ?? this.sfxBus);
    src.start(start, Math.random() * 1.5, duration + 0.05);
  }

  /** 大钟：和音乐里的 toll 同一组分音，走音效总线。 */
  bellToll(base, duration, volume) {
    [0.5, 1, 1.183, 1.506, 2, 2.514, 3.011].forEach((ratio, i) => {
      const v = volume * [0.7, 1, 0.5, 0.35, 0.45, 0.2, 0.12][i];
      this.tone(base * ratio, duration / (1 + i * 0.45), { volume: v, type: "sine", attack: 0.003 });
      if (i < 3) this.tone(base * ratio * 1.0035, duration / (1 + i * 0.45), { volume: v * 0.5, type: "sine", attack: 0.003 });
    });
  }

  /** 金属声：几组不成整数倍的分音一起衰减（盾、铁砧、护甲）。 */
  metal(base, duration = 0.5, { delay = 0, volume = 0.04 } = {}) {
    [1, 2.76, 5.4, 8.93].forEach((ratio, i) =>
      this.tone(base * ratio * jitter(0.01), duration / (1 + i * 0.6), { delay, volume: volume / (1 + i), type: "sine", attack: 0.002 }),
    );
  }

  // ——— 音效 ———

  play(event, amount = 1) {
    this.unlock();
    if (!this.enabled || !this.context) return;
    const j = jitter();
    switch (event) {
      case "step":
        // 棋子落在棋盘上：短促的木头声。
        this.tone(320 * j, 0.06, { type: "triangle", volume: 0.035, slide: -120 });
        this.noise(0.04, { volume: 0.025, filter: 2400, type: "bandpass", q: 2 });
        break;
      case "bump":
        this.tone(95 * j, 0.18, { type: "sine", volume: 0.08, slide: -40 });
        this.noise(0.08, { volume: 0.03, filter: 500 });
        break;
      case "slash":
      case "swing-light":
        // 轻击：短、脆的一刀。
        this.noise(0.1, { volume: 0.07, filter: 6500, sweep: 2200, type: "bandpass", q: 1.6 });
        this.tone(1320 * j, 0.05, { type: "triangle", volume: 0.02, slide: -500, delay: 0.015 });
        this.tone(2400 * j, 0.03, { type: "sine", volume: 0.012, delay: 0.05 });
        break;
      case "swing-medium":
        // 中型：稍长的挥砍，带一点金属尾音。
        this.noise(0.18, { volume: 0.08, filter: 4200, sweep: 900, type: "bandpass", q: 1.2 });
        this.tone(520 * j, 0.12, { type: "triangle", volume: 0.022, slide: -240, delay: 0.03 });
        this.metal(1100 * j, 0.2, { delay: 0.1, volume: 0.015 });
        break;
      case "swing-heavy":
        // 重击：长而低的蓄势风声，落地声另由 impact 负责。
        this.noise(0.3, { volume: 0.08, filter: 1800, sweep: 5200, type: "bandpass", q: 0.8 });
        this.tone(55, 0.3, { type: "sine", volume: 0.06, slide: 40 });
        break;
      case "impact": {
        // 重击落地：一记沉闷的低频 + 碎裂的中频 + 一声短暂的金属嗡鸣，碎得越多越响。
        const k = Math.min(1.5, 0.8 + amount * 0.08);
        this.tone(95, 0.4, { type: "sine", volume: 0.2 * k, slide: -60, attack: 0.003 });
        this.tone(48, 0.55, { type: "sine", volume: 0.14 * k, attack: 0.005 });
        this.noise(0.28, { volume: 0.1 * k, filter: 900, sweep: 180, type: "lowpass" });
        this.noise(0.12, { volume: 0.05 * k, filter: 3000, type: "bandpass", q: 0.9, delay: 0.01 });
        this.metal(180 * j, 0.5, { volume: 0.03, delay: 0.02 });
        break;
      }
      case "energy":
        // 充能：两声上行的清亮音，外加一点闪光。
        for (let i = 0; i < Math.min(amount, 3); i += 1) {
          [0, 7].forEach((iv, n) => this.tone(midi(84 + iv + i * 2), 0.28, { delay: i * 0.09 + n * 0.06, volume: 0.03, type: "sine" }));
          this.noise(0.18, { delay: i * 0.09 + 0.05, volume: 0.012, filter: 9000, type: "highpass" });
        }
        break;
      case "swing-skill":
        this.noise(0.22, { volume: 0.05, filter: 7000, sweep: 2500, type: "bandpass", q: 3 });
        [1318, 1760, 2349].forEach((f, i) => this.tone(f * j, 0.25, { delay: i * 0.04, volume: 0.02, type: "triangle" }));
        break;
      case "shatter":
        // 红心碎裂：几声玻璃般的短脆音，碎得越多越密。
        for (let i = 0; i < Math.min(amount, 8); i += 1) {
          this.tone((1200 + Math.random() * 900) * (1 + i * 0.05), 0.09, { delay: i * 0.03, volume: 0.028, type: "square", filter: 5000 });
          this.noise(0.05, { delay: i * 0.03, volume: 0.02, filter: 6000, type: "highpass" });
        }
        break;
      case "crack":
        // 护甲被打裂：金属声 + 一点碎屑。
        this.metal(620 * j, 0.35, { volume: 0.05 });
        this.noise(0.06, { volume: 0.03, filter: 4000, type: "highpass" });
        break;
      case "combo": {
        // 连击：音高随连击数往上走，越连越亮。
        const base = 72 + Math.min(amount, 8) * 2;
        [0, 4, 7, 12].forEach((iv, i) => this.tone(midi(base + iv), 0.22, { delay: i * 0.045, volume: 0.035, type: "triangle" }));
        break;
      }
      case "chase":
        // 追击：一个上扬的强音。
        [0, 7, 12, 19].forEach((iv, i) => this.tone(midi(62 + iv), 0.5, { delay: i * 0.03, volume: 0.035, type: "sawtooth", filter: 3000 }));
        this.noise(0.4, { volume: 0.04, filter: 800, sweep: 6000, type: "bandpass", q: 1 });
        break;
      case "combo-break":
        this.tone(440, 0.25, { type: "square", volume: 0.025, slide: -220, filter: 1800 });
        this.tone(466, 0.25, { type: "square", volume: 0.02, slide: -230, filter: 1800 });
        break;
      case "hurt":
        this.tone(160 * j, 0.32, { type: "sawtooth", volume: 0.05, slide: -90, filter: 1200 });
        this.tone(60, 0.25, { type: "sine", volume: 0.12, slide: -20 });
        this.noise(0.22, { volume: 0.05, filter: 700 });
        break;
      case "block":
        this.metal(380 * j, 0.6, { volume: 0.06 });
        this.noise(0.1, { volume: 0.05, filter: 3000, type: "bandpass" });
        break;
      case "shield":
        // 摆好防御架势：两声干净的上行音加一点金属。
        [392, 587].forEach((f, i) => this.tone(f, 0.18, { delay: i * 0.05, type: "triangle", volume: 0.04 }));
        this.metal(900, 0.25, { delay: 0.08, volume: 0.02 });
        break;
      case "heal":
        [523, 659, 784, 1046].forEach((f, i) => this.tone(f, 0.45, { delay: i * 0.06, volume: 0.03 }));
        this.noise(0.5, { volume: 0.012, filter: 8000, type: "highpass" });
        break;
      case "pray":
        // 主教祷告：低沉的和声慢慢浮起来。
        chord(55, MIN).forEach((n) => this.tone(midi(n), 0.9, { volume: 0.025, type: "sawtooth", attack: 0.25, filter: 900, detune: Math.random() * 12 - 6 }));
        break;
      case "fortify":
        // 城堡筑墙：两下石头闷响。
        [0, 0.12].forEach((d) => {
          this.tone(90, 0.2, { delay: d, type: "sine", volume: 0.1, slide: -30 });
          this.noise(0.12, { delay: d, volume: 0.05, filter: 600 });
        });
        this.metal(300, 0.4, { delay: 0.24, volume: 0.02 });
        break;
      case "stun":
        this.metal(1400, 0.3, { volume: 0.04 });
        this.tone(660, 0.5, { type: "sine", volume: 0.03, slide: -300, delay: 0.05 });
        break;
      case "pickup":
        [659, 880, 1175].forEach((f, i) => this.tone(f, 0.25, { delay: i * 0.06, volume: 0.035, type: "triangle" }));
        break;
      case "chest":
        // 开宝箱：箱盖吱呀一声，然后是一串亮音。
        this.noise(0.25, { volume: 0.04, filter: 900, sweep: 1800, type: "bandpass", q: 6 });
        [392, 494, 587, 784, 988].forEach((f, i) => this.tone(f, 0.45, { delay: 0.15 + i * 0.07, type: "triangle", volume: 0.04 }));
        break;
      case "anvil":
        // 铁砧落锤：一下厚重的金属敲击 + 火花。
        this.metal(220, 1.1, { volume: 0.08 });
        this.tone(55, 0.25, { type: "sine", volume: 0.1 });
        this.noise(0.3, { delay: 0.02, volume: 0.03, filter: 7000, type: "highpass" });
        [1568, 2093].forEach((f, i) => this.tone(f, 0.3, { delay: 0.25 + i * 0.08, volume: 0.02, type: "triangle" }));
        break;
      case "flip":
        // 铁砧重抽：翻牌的纸声。
        this.noise(0.08, { volume: 0.05, filter: 3000, sweep: 6000, type: "bandpass", q: 2 });
        this.noise(0.06, { delay: 0.18, volume: 0.04, filter: 5000, sweep: 2500, type: "bandpass", q: 2 });
        this.tone(988, 0.12, { delay: 0.2, volume: 0.02, type: "triangle" });
        break;
      case "page":
        // 说明卡弹出。
        this.noise(0.1, { volume: 0.03, filter: 2500, sweep: 5000, type: "bandpass", q: 1.5 });
        this.tone(784, 0.15, { delay: 0.04, volume: 0.02, type: "triangle" });
        break;
      case "door":
        this.noise(0.6, { volume: 0.03, filter: 500, sweep: 1200, type: "bandpass", q: 8 });
        this.tone(120, 0.5, { type: "sawtooth", volume: 0.025, slide: 50, filter: 800 });
        this.metal(260, 0.4, { delay: 0.45, volume: 0.03 });
        break;
      case "alert":
        this.tone(740, 0.1, { type: "square", volume: 0.03, filter: 3000 });
        this.tone(988, 0.14, { delay: 0.09, type: "square", volume: 0.03, filter: 3000 });
        break;
      case "battle":
        // 进入战斗：一声扫频 + 重拍。
        this.noise(0.45, { volume: 0.05, filter: 300, sweep: 5000, type: "bandpass", q: 1.2 });
        this.tone(55, 0.5, { delay: 0.35, type: "sine", volume: 0.14, slide: -15 });
        chord(57, MIN).forEach((n) => this.tone(midi(n), 0.5, { delay: 0.35, volume: 0.025, type: "sawtooth", filter: 1500 }));
        break;
      case "charge":
        this.tone(90, 0.8, { type: "sawtooth", volume: 0.035, slide: 220, filter: 900 });
        this.noise(0.8, { volume: 0.03, filter: 200, sweep: 2500, type: "bandpass", q: 3 });
        break;
      case "curse":
        [0, 6, 11].forEach((iv) => this.tone(midi(50 + iv), 0.7, { volume: 0.03, type: "square", filter: 1400, slide: -30 }));
        this.noise(0.3, { volume: 0.04, filter: 400 });
        break;
      case "glass":
        // 打断：一声玻璃般的碎裂，带一点下坠的金属尾音。
        this.noise(0.45, { volume: 0.07, filter: 5200, sweep: 1800, type: "bandpass", q: 1.4 });
        this.metal(1900, 0.6, { volume: 0.03 });
        this.tone(1400, 0.4, { type: "triangle", volume: 0.02, slide: -900, delay: 0.04 });
        break;
      case "resolve":
        // 终局：一个落到 D 大调的和弦，底下一声钟。
        this.bellToll(73.4, 5, 0.05);
        chord(62, MAJ).concat([50, 74]).forEach((n, i) => this.tone(midi(n), 3.6, { delay: 0.25 + i * 0.05, volume: 0.022, type: "sine", attack: 0.5 }));
        break;
      case "topple":
        // 首领倒地：沉重的一声闷响，带一点石头的回声。
        this.tone(62, 0.9, { type: "sine", volume: 0.16, slide: -26, attack: 0.004 });
        this.noise(0.5, { volume: 0.07, filter: 320 });
        this.metal(140, 1.2, { volume: 0.025 });
        break;
      case "heartbeat":
        // 心跳：低沉的“咚、咚”两下。amount 越大越响。
        this.tone(52, 0.2, { type: "sine", volume: 0.08 + amount * 0.03, slide: -10, attack: 0.006 });
        this.tone(46, 0.18, { type: "sine", volume: 0.06 + amount * 0.025, slide: -8, attack: 0.006, delay: 0.17 });
        break;
      case "toll":
        // 首领开场：一声低沉的大钟。
        this.bellToll(98, 4.5, 0.06);
        break;
      case "rebirth":
        // 二阶段：一声大钟，底下一股低鸣慢慢涌上来，再叠一片小调的和声。
        this.bellToll(73.4, 5, 0.07);
        this.tone(41, 2.6, { type: "sawtooth", volume: 0.05, attack: 0.9, filter: 300, slide: 8 });
        this.noise(1.6, { volume: 0.05, filter: 200, sweep: 3200, type: "bandpass", q: 2, attack: 1.3 });
        chord(50, [0, 3, 7, 13]).forEach((n) => this.tone(midi(n), 2.4, { delay: 0.6, volume: 0.02, type: "sawtooth", attack: 0.8, filter: 1200, detune: Math.random() * 14 - 7 }));
        break;
      case "victory":
        [523, 659, 784, 1046].forEach((f, i) => this.tone(f, 0.45, { delay: i * 0.1, type: "triangle", volume: 0.05 }));
        chord(72, MAJ).forEach((n) => this.tone(midi(n), 0.9, { delay: 0.4, volume: 0.025, type: "sine" }));
        break;
      case "defeat":
        [392, 330, 262, 196].forEach((f, i) => this.tone(f, 0.6, { delay: i * 0.18, type: "triangle", volume: 0.05 }));
        this.tone(49, 1.4, { delay: 0.7, type: "sine", volume: 0.08 });
        break;
      case "win":
        [523, 659, 784, 1046, 1318, 1568].forEach((f, i) => this.tone(f, 0.7, { delay: i * 0.1, volume: 0.045, type: "triangle" }));
        chord(60, MAJ7).forEach((n) => this.tone(midi(n), 1.4, { delay: 0.6, volume: 0.02, type: "sine", attack: 0.1 }));
        break;
      case "click":
        this.tone(1200 * j, 0.04, { type: "triangle", volume: 0.018 });
        break;
      case "invalid":
        this.tone(150, 0.14, { type: "square", volume: 0.028, filter: 900 });
        this.tone(142, 0.14, { type: "square", volume: 0.022, filter: 900, delay: 0.02 });
        break;
      default:
    }
  }
}

/* ——— 背景音乐 ———
 * 每首曲子是 4 小节循环，每小节 16 步。调度器用 Web Audio 的时钟提前约 0.15 秒排好音符，
 * setInterval 只负责“往前看”，所以节奏不受主线程卡顿影响。切歌时新旧两首交叉淡入淡出。 */

/** 乐器。t 为开始时间（音频时钟），bus 为这首曲子自己的增益节点。 */
export function instruments(sfx, bus) {
  // 人性化：管弦乐音色的每个音提前或拖后几毫秒、轻重各不相同，听起来不像机器卡着拍子。
  const hum = (t) => t + (Math.random() - 0.4) * 0.014;
  const vel = (v) => v * (0.85 + Math.random() * 0.27);
  return {
    bass: (n, t, len, vol = 0.08) => {
      sfx.tone(midi(n), len, { at: t, volume: vol, type: "triangle", bus, attack: 0.01, filter: 700 });
      sfx.tone(midi(n - 12), len, { at: t, volume: vol * 0.6, type: "sine", bus, attack: 0.01 });
    },
    pluck: (n, t, vol = 0.03) => sfx.tone(midi(n), 0.28, { at: t, volume: vol, type: "triangle", bus, attack: 0.004, filter: 3200 }),
    bell: (n, t, vol = 0.025) => {
      sfx.tone(midi(n), 1.2, { at: t, volume: vol, type: "sine", bus, attack: 0.004 });
      sfx.tone(midi(n + 12) * 1.003, 0.4, { at: t, volume: vol * 0.12, type: "sine", bus, attack: 0.004 });
    },
    pad: (notes, t, len, vol = 0.014, cutoff = 1100) =>
      notes.forEach((n) => [-7, 7].forEach((d) => sfx.tone(midi(n), len, { at: t, volume: vol, type: "sawtooth", bus, attack: len * 0.35, filter: cutoff, detune: d }))),
    organ: (notes, t, len, vol = 0.012) =>
      notes.forEach((n) => {
        sfx.tone(midi(n), len, { at: t, volume: vol, type: "square", bus, attack: 0.03, filter: 1600 });
        sfx.tone(midi(n + 12), len, { at: t, volume: vol * 0.5, type: "sine", bus, attack: 0.03 });
      }),
    lead: (n, t, len, vol = 0.028) => sfx.tone(midi(n), len, { at: t, volume: vol, type: "square", bus, attack: 0.02, filter: 1800 }),
    kick: (t, vol = 0.16) => sfx.tone(140, 0.18, { at: t, volume: vol, type: "sine", bus, slide: -100, attack: 0.002 }),
    snare: (t, vol = 0.05) => {
      sfx.noise(0.16, { at: t, volume: vol, filter: 1800, type: "bandpass", q: 0.8, bus });
      sfx.tone(190, 0.08, { at: t, volume: vol * 0.6, type: "triangle", bus, attack: 0.002 });
    },
    // 镲用带通噪声，只留 6 kHz 左右的“嚓”，不要最顶上的刺声。
    hat: (t, vol = 0.014) => sfx.noise(0.035, { at: t, volume: vol, filter: 6000, type: "bandpass", q: 0.9, bus }),
    // ——— 暗王终章用的音色 ———
    // 教堂大钟：一组不成整数倍的分音（低八度的嗡音、小三度、五度……），越高的分音衰减越快，两两略微失谐产生拍音。
    toll: (n, t, vol = 0.03, len = 6) => {
      [0.5, 1, 1.183, 1.506, 2, 2.514, 3.011].forEach((ratio, i) => {
        const f = midi(n) * ratio;
        const v = vol * [0.7, 1, 0.5, 0.35, 0.45, 0.2, 0.12][i];
        sfx.tone(f, len / (1 + i * 0.45), { at: t, volume: v, type: "sine", bus, attack: 0.003 });
        if (i < 3) sfx.tone(f * 1.0035, len / (1 + i * 0.45), { at: t, volume: v * 0.5, type: "sine", bus, attack: 0.003 });
      });
      // 钟锤敲上去的那一下金属声。
      sfx.noise(0.06, { at: t, volume: vol * 0.5, filter: 2400, type: "bandpass", q: 3, bus });
    },
    // 定音鼓：带一点音高下滑的低沉鼓声，外加一下闷的敲击噪声。
    timpani: (n, t, vol = 0.12) => {
      const at = hum(t);
      const v = vel(vol);
      sfx.tone(midi(n), 1.6, { at, volume: v, type: "sine", bus, attack: 0.004, slide: -midi(n) * 0.03 });
      sfx.tone(midi(n) * 1.504, 0.7, { at, volume: v * 0.3, type: "sine", bus, attack: 0.004 });
      sfx.tone(midi(n) * 1.742, 0.4, { at, volume: v * 0.15, type: "sine", bus, attack: 0.004 });
      sfx.noise(0.09, { at, volume: v * 0.4, filter: 380, bus });
    },
    // 合唱垫音：几层略微失谐的三角波，起音很慢，像远处的人声“啊——”。
    choir: (notes, t, len, vol = 0.008) =>
      notes.forEach((n) =>
        [-11, 0, 11].forEach((d) => sfx.voice(midi(n), len, { at: hum(t), volume: vel(vol), attack: Math.min(len * 0.4, len < 1 ? 0.05 : 2), bus, detune: d })),
      ),
    // 低音弦乐：两把失谐的锯齿波压暗，短促有力，用来跑八分 / 十六分的固定音型。
    strings: (n, t, len, vol = 0.03) => {
      const at = hum(t);
      const v = vel(vol);
      [-8, 8].forEach((d) =>
        sfx.tone(midi(n), len, { at, volume: v, type: "sawtooth", bus, attack: 0.018, filter: 900, detune: d, vibrato: len > 0.4 ? 9 : 0 }),
      );
    },
    // 女声合唱：每个音三个声部略微失谐，起音慢，用女声的“啊”。
    soprano: (notes, t, len, vol = 0.009) =>
      notes.forEach((n) =>
        [-8, 0, 8].forEach((d) => sfx.voice(midi(n), len, { at: hum(t), volume: vel(vol), attack: Math.min(len * 0.35, 0.6), bus, detune: d, female: true })),
      ),
    // 小号：两把略微失谐的锯齿波，比圆号亮、起音更快，长音带颤音。
    trumpet: (n, t, len, vol = 0.012) => {
      const at = hum(t);
      const v = vel(vol);
      [-4, 4].forEach((d) => sfx.tone(midi(n), len, { at, volume: v, type: "sawtooth", bus, attack: 0.03, filter: 1900, detune: d, vibrato: len > 0.3 ? 8 : 0 }));
    },
    // 铜管和弦刺：几支圆号同时短促地吹一下。
    brass: (notes, t, len, vol = 0.012) =>
      notes.forEach((n) => {
        const at = hum(t);
        const v = vel(vol);
        [-6, 6].forEach((d) => sfx.tone(midi(n), len, { at, volume: v, type: "sawtooth", bus, attack: 0.02, filter: 1300, detune: d }));
      }),
    // 弦乐长和弦：一整个弦乐声部持续拉住，带颤音，代替管风琴的方波。
    section: (notes, t, len, vol = 0.007) =>
      notes.forEach((n) =>
        [-10, 0, 10].forEach((d) =>
          sfx.tone(midi(n), len, { at: hum(t), volume: vel(vol), type: "sawtooth", bus, attack: 0.25, filter: 1400, detune: d, vibrato: 10 }),
        ),
      ),
    // 大鼓（太鼓）：比定音鼓更低、没有明确音高的一下闷响，代替电子鼓式的底鼓。
    taiko: (t, vol = 0.14) => {
      const at = hum(t);
      const v = vel(vol);
      sfx.tone(72, 0.7, { at, volume: v, type: "sine", bus, attack: 0.004, slide: -24 });
      sfx.tone(118, 0.25, { at, volume: v * 0.35, type: "sine", bus, attack: 0.004, slide: -40 });
      sfx.noise(0.18, { at, volume: v * 0.5, filter: 260, bus });
    },
    // 上扬：一段噪声的滤波频率从低往高扫，越来越响，用来把气氛推进下一段。
    riser: (t, len, vol = 0.02) => sfx.noise(len, { at: t, volume: vol, filter: 300, sweep: 5000, type: "bandpass", q: 2.5, bus, attack: len * 0.9 }),
    // 镲：一片宽频噪声慢慢散开，压掉最刺的高频。
    crash: (t, vol = 0.02) => sfx.noise(1.8, { at: t, volume: vol, filter: 4200, type: "bandpass", q: 0.6, bus, attack: 0.004 }),
    // 铜管长音：锯齿波起音稍慢，压在中低频，像圆号。
    horn: (n, t, len, vol = 0.016) => {
      const at = hum(t);
      const v = vel(vol);
      [-5, 5].forEach((d) => sfx.tone(midi(n), len, { at, volume: v, type: "sawtooth", bus, attack: 0.07, filter: 1000, detune: d, vibrato: len > 0.35 ? 7 : 0 }));
    },
  };
}

/** 曲目：bpm、每小节的和弦（根音 + 音程），以及每一步要演奏什么。 */
export const TRACKS = {
  // 标题：舒缓的钟琴琶音，D 大调。
  title: {
    bpm: 76,
    chords: [chord(50, MAJ7), chord(47, MIN7), chord(43, MAJ7), chord(45, MAJ)],
    step(ins, s, bar, t, beat, c) {
      if (s === 0) ins.pad(c.map((n) => n + 12), t, beat * 4, 0.01, 900);
      if (s === 0) ins.bass(c[0] - 12, t, beat * 3.5, 0.05);
      if (s % 2 === 0) ins.bell(c[(s / 2) % c.length] + 12 + (s >= 8 ? 12 : 0), t, 0.016);
    },
  },
  // 棋盘探索：轻快的拨弦，C 大调。
  board: {
    bpm: 100,
    chords: [chord(48, MAJ), chord(45, MIN), chord(41, MAJ), chord(43, MAJ)],
    step(ins, s, bar, t, beat, c) {
      if (s % 4 === 0) ins.bass(c[0] - 12 + (s === 8 ? 7 : 0), t, beat * 0.9, 0.06);
      const arp = [0, 1, 2, 1, 2, 0, 1, 2];
      if (s % 2 === 0) ins.pluck(c[arp[(s / 2) % 8]] + 12 + (s % 8 === 6 ? 12 : 0), t, 0.024);
      if (s % 4 === 2) ins.hat(t, 0.01);
      if (bar % 2 === 1 && s === 12) ins.bell(c[2] + 12, t, 0.012);
    },
  },
  // 迷雾：更慢更暗，A 小调铺底，稀疏的钟声。
  fog: {
    bpm: 84,
    chords: [chord(45, MIN), chord(41, MAJ), chord(38, MIN), chord(40, MAJ)],
    step(ins, s, bar, t, beat, c) {
      if (s === 0) ins.pad(c.map((n) => n + 12), t, beat * 4.2, 0.012, 700);
      if (s === 0 || s === 10) ins.bass(c[0] - 12, t, beat * 2, 0.05);
      if (s === 0) ins.kick(t, 0.08);
      if ((s === 6 || s === 14) && Math.random() < 0.7) ins.bell(c[(s + bar) % 3] + 12, t, 0.014);
    },
  },
  // 普通战斗：推进感的八分低音 + 标准鼓组，A 小调。
  battle: {
    bpm: 132,
    chords: [chord(45, MIN), chord(45, MIN), chord(41, MAJ), chord(43, MAJ)],
    motif: [12, null, 15, null, 19, null, 17, 15, 12, null, 10, null, 12, null, null, null],
    step(ins, s, bar, t, beat, c) {
      if (s % 2 === 0) ins.bass(c[0] - 12 + (s % 4 === 2 ? 12 : 0), t, beat * 0.45, 0.06);
      if (s % 4 === 0) ins.kick(t);
      if (s === 4 || s === 12) ins.snare(t);
      if (s % 2 === 1) ins.hat(t);
      const m = this.motif[s];
      if (m !== null && bar % 2 === 1) ins.lead(57 + m, t, beat * 0.45, 0.02);
      if (s === 0) ins.pad(c.map((n) => n + 12), t, beat * 4, 0.008, 1400);
    },
  },
  // 精锐战斗：十六分低音、切分的和弦刺，D 小调。
  elite: {
    bpm: 140,
    chords: [chord(50, MIN), chord(46, MAJ), chord(43, MIN), chord(45, [0, 4, 7, 10])],
    step(ins, s, bar, t, beat, c) {
      ins.bass(c[0] - 12 + (s % 8 === 7 ? 12 : 0), t, beat * 0.22, 0.05);
      if ([0, 6, 10].includes(s)) ins.kick(t);
      if (s === 4 || s === 12) ins.snare(t, 0.06);
      if (bar === 3 && s >= 12) ins.snare(t, 0.04);
      if (s % 2 === 1) ins.hat(t, 0.012);
      if ([0, 3, 6, 10].includes(s)) ins.organ(c.map((n) => n + 12), t, beat * 0.3, 0.01);
      if (bar % 2 === 1 && s % 4 === 0) ins.lead(c[s % 3] + 12, t, beat * 0.9, 0.018);
    },
  },
  // 王座厅（终章的棋盘）：D 弗里几亚调式，管风琴持续 D + A，远处的合唱缓缓起落，每小节第 1、3 拍一声大钟，不用鼓。
  throne: {
    bpm: 56,
    reverb: 1,
    chords: [chord(50, MIN), chord(51, MAJ), chord(43, MIN), chord(50, MIN)],
    step(ins, s, bar, t, beat, c) {
      if (s === 0) ins.pad([38, 45], t, beat * 4.2, 0.011, 520);
      if (s === 0) ins.choir(c.map((n) => n + 12), t, beat * 4, 0.006);
      if (s === 0) ins.toll(50, t, 0.03);
      if (s === 8) ins.toll(bar === 1 ? 51 : 45, t, 0.018, 4);
      if (bar === 3 && s === 12) ins.bell(74, t, 0.01);
    },
  },
  // 暗王战（第一段）：慢而重的半速感，Dm – E♭ – Gm – A。定音鼓落在小节头，低音弦乐跑八分音符，小节头一声大钟。
  boss: {
    bpm: 72,
    reverb: 0.6,
    chords: [chord(50, MIN), chord(51, MAJ), chord(43, MIN), chord(45, MAJ)],
    ostinato: [0, 0, 12, 0, 7, 0, 12, 10],
    step(ins, s, bar, t, beat, c) {
      if (s === 0) {
        ins.timpani(36 + (c[0] % 12), t, 0.13);
        if (bar % 2 === 0) ins.toll(c[0], t, 0.02, 5);
        ins.section(c.map((n) => n + 12), t, beat * 3.9, 0.006);
        ins.choir(c.map((n) => n + 12), t, beat * 4, 0.007);
      }
      if (s % 2 === 0) ins.strings(c[0] - 12 + this.ostinato[s / 2], t, beat * 0.42, 0.026);
      if (s === 8) ins.timpani(43 + (c[0] % 12), t, 0.07);
      if (bar === 3 && (s === 12 || s === 14)) ins.timpani(45, t, 0.06 + (s - 12) * 0.02);
      if (bar % 2 === 1 && (s === 0 || s === 8)) ins.horn(c[2] + (s === 8 ? 12 : 0), t, beat * 1.9, 0.014);
    },
  },
  // 暗王战（第二段，王冠倾斜）：暗王重新站起之后，曲子由弱渐强，一轮轮加厚。
  //   第 1 轮：只有大钟、女声合唱的长音和弦乐长和弦，庄严肃穆；
  //   第 2 轮：加进铜管众赞歌、定音鼓和低音弦乐的八分音符；
  //   第 3 轮起：完整编制——十六分音符的切分重音、太鼓、军鼓、圆号与小号齐奏的旋律、最后一小节的冲刺。
  // 116 拍/分，Dm – B♭ – Gm – A7♭9，最后一小节的降九音把紧张推到顶，再落回开头。
  boss2: {
    bpm: 116,
    reverb: 0.6,
    chords: [chord(50, MIN), chord(46, MAJ), chord(43, MIN), chord(45, [0, 4, 7, 10, 13])],
    accents: new Set([0, 3, 6, 8, 11, 14]),
    // 女声合唱的两个声部，每小节两个二分音符：[上声部, 下声部]。
    choirLine: [
      [[81, 77], [77, 74]],
      [[77, 74], [74, 70]],
      [[79, 74], [82, 79]],
      [[81, 76], [79, 73]],
    ],
    melody: [
      [74, null, 74, 77, 76, null, 74, null],
      [74, null, 74, 77, 79, null, 77, null],
      [79, null, 79, 82, 81, null, 79, null],
      [81, 82, 81, 79, 77, 76, 73, null],
    ],
    step(ins, s, bar, t, beat, c, loop = 2) {
      const root = c[0];
      const full = loop >= 2;
      const hit = this.accents.has(s);
      // 庄严的一层（从第 1 轮就有）：大钟、女声长音、弦乐长和弦。
      if (s === 0) {
        ins.toll(root, t, loop === 0 ? 0.024 : 0.018, 3.5);
        ins.section(c.slice(0, 3).map((n) => n + 12), t, beat * 3.9, 0.005);
        if (full && bar === 0) ins.crash(t, 0.02);
      }
      if (s === 0 || s === 8) ins.soprano(this.choirLine[bar][s / 8], t, beat * 2.05, loop === 0 ? 0.012 : 0.01);
      if (loop === 0) return;
      // 第 2 轮起：铜管众赞歌、定音鼓、低音弦乐。
      if (s === 0 || s === 8) ins.brass(c.slice(0, 3), t, beat * 1.9, 0.007);
      if (!full) {
        if (s % 2 === 0) ins.strings(root - 12 + (s % 4 === 2 ? 12 : 0), t, beat * 0.4, 0.02);
        if (s === 0 || s === 8) ins.timpani(36 + (root % 12) + (s === 8 ? 7 : 0), t, 0.11);
        if (bar === 3 && s >= 12) ins.timpani(45, t, 0.05 + (s - 12) * 0.015);
        return;
      }
      // 第 3 轮起：完整编制。低音弦乐每个十六分音符都拉，重音处跳上八度，每拍最后一个音用小二度往上顶。
      const note = hit ? root : s % 4 === 3 ? root - 11 : root - 12;
      ins.strings(note, t, beat * 0.2, hit ? 0.03 : 0.016);
      if (s % 4 === 0) ins.taiko(t, s === 0 ? 0.16 : 0.11);
      if (hit) ins.timpani(36 + (root % 12) + (s === 8 ? 7 : 0), t, s === 0 ? 0.15 : 0.09);
      if (s === 4 || s === 12) ins.snare(t, 0.045);
      // 合唱短促的“哈！”与铜管和弦刺，跟着切分重音。
      if (s === 0 || s === 8) ins.choir([c[0] + 12, c[2] + 12], t, beat * 0.55, 0.008);
      if (s === 3 || s === 11) ins.brass(c.slice(0, 3).map((n) => n + 12), t, beat * 0.25, 0.01);
      const m = s % 2 === 0 ? this.melody[bar][s / 2] : null;
      if (m) {
        const held = this.melody[bar][s / 2 + 1] === null ? beat * 0.9 : beat * 0.42;
        ins.horn(m - 12, t, held, 0.016);
        ins.trumpet(m, t, held * 0.9, 0.01);
      }
      // 最后一小节：后半段定音鼓十六分连击、军鼓滚奏，噪声从低往高扫上去，接回开头。
      if (bar === 3 && s >= 8) {
        ins.timpani(45, t, 0.05 + (s - 8) * 0.012);
        [0, 0.5].forEach((k) => ins.snare(t + k * (beat / 8), 0.014 + (s - 8) * 0.005));
        if (s === 8) ins.riser(t, beat * 2, 0.016);
      }
    },
  },
};

class Music {
  constructor(sfx) {
    this.sfx = sfx;
    this.want = null;
    this.current = null;
    this.timer = 0;
    document.addEventListener("visibilitychange", () => {
      if (!this.current) return;
      // 标签页在后台时，定时器会被降频，音符会乱，先把音乐静下来。
      const ctx = this.sfx.context;
      this.current.gain.gain.setTargetAtTime(document.hidden ? 0 : 1, ctx.currentTime, 0.2);
      if (!document.hidden) this.current.next = Math.max(this.current.next, ctx.currentTime + 0.1);
    });
  }

  /**
   * 切换到某首曲子；同一首不会重新开始。null 表示淡出停止。
   * fadeIn：用多少秒从无声慢慢推到正常音量（默认约 1 秒）；fadeOut：旧曲子用多少秒淡出。
   */
  play(name, { fadeIn = 0, fadeOut = 0 } = {}) {
    this.want = name;
    this.fadeIn = fadeIn;
    this.fadeOut = fadeOut;
    this.resume();
  }

  resume() {
    const ctx = this.sfx.context;
    if (!ctx || ctx.state !== "running" && ctx.state !== "suspended") return;
    if ((this.current?.name ?? null) === this.want) return;
    const old = this.current;
    if (old) {
      const out = this.fadeOut || 1;
      old.gain.gain.setTargetAtTime(0, ctx.currentTime, out / 3);
      setTimeout(() => old.gain.disconnect(), out * 1000 + 1500);
    }
    this.current = null;
    if (!this.want || !TRACKS[this.want]) return this.stopTimer();
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, ctx.currentTime);
    if (this.fadeIn) {
      // 由弱渐强：从几乎无声线性推到正常音量。
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + 0.05);
      gain.gain.linearRampToValueAtTime(1, ctx.currentTime + this.fadeIn);
    } else gain.gain.setTargetAtTime(1, ctx.currentTime + 0.1, 0.5);
    gain.connect(this.sfx.musicBus);
    const track = TRACKS[this.want];
    // 送进大厅混响的量由曲子自己决定：肃穆的曲子混响多，轻快的曲子不加。
    if (track.reverb) {
      const send = ctx.createGain();
      send.gain.value = track.reverb;
      gain.connect(send).connect(this.sfx.hallIn);
    }
    this.current = { name: this.want, track, gain, ins: instruments(this.sfx, gain), step: 0, next: ctx.currentTime + 0.12 };
    if (!this.timer) this.timer = setInterval(() => this.tick(), 40);
  }

  stopTimer() {
    clearInterval(this.timer);
    this.timer = 0;
  }

  tick() {
    const cur = this.current;
    const ctx = this.sfx.context;
    if (!cur || !ctx || document.hidden) return;
    const beat = 60 / cur.track.bpm;
    const stepLen = beat / 4;
    while (cur.next < ctx.currentTime + 0.15) {
      const bar = Math.floor(cur.step / 16) % 4;
      const s = cur.step % 16;
      // loop：这首曲子已经完整循环了几轮，曲子可以据此一层层加乐器。
      const loop = Math.floor(cur.step / 64);
      if (this.sfx.musicEnabled) cur.track.step(cur.ins, s, bar, cur.next, beat, cur.track.chords[bar], loop);
      cur.step += 1;
      cur.next += stepLen;
    }
  }
}
