// 有效声音（语音活动）判定：纯函数，不依赖任何浏览器 API。
// 方案见 docs/valid-voice-detection.md：自适应本底门槛 + 绝对地板 + 时间结构（调制/瞬态）组合。

export type InvalidReason = 'silence' | 'noise_floor' | 'transient' | 'too_short';

export interface VoiceFrame {
  start: number;   // 秒
  end: number;     // 秒
  rms: number;     // 线性 RMS（0..1）
  db: number;      // dBFS
  active: boolean; // 是否高于能量门槛
}

export interface VoiceSegment {
  start: number; // 秒（含合并间隙后的起点）
  end: number;   // 秒
  frames: VoiceFrame[];
  modulationDb: number; // 段内帧能量 P90-P10（dB）
  steadyNoise: boolean; // 调制不足，疑似持续噪声
  impulsive: boolean;   // 调制过强（脉冲包络），疑似单次碰撞/敲击
}

export interface VoiceAssessment {
  valid: boolean;
  reason?: InvalidReason;
  reasonText?: string;
  duration: number;        // 片段总时长（秒）
  voicedDuration: number;  // 有效声段累计时长（含段内被合并的短间隙）
  voicedRatio: number;     // 有声帧占比
  pauseCount: number;      // 有效声段之间的停次数
  pauseDuration: number;   // 停顿总时长（秒）
  pauses: Array<{ start: number; end: number }>;
  clipping: boolean;
  floorDb: number;
  gateDb: number;
  frames: VoiceFrame[];
  segments: VoiceSegment[];
}

export interface DetectorConfig {
  sampleRate: number;
  frameMs?: number;
  hopMs?: number;
  adaptiveMarginDb?: number;
  absoluteGateDb?: number;
  floorPercentile?: number;
  mergeGapMs?: number;
  modulationDb?: number;
  impulseModulationDb?: number;
  minVoicedMs?: number;
  minVoicedRatio?: number;
  minSegmentMs?: number;
}

export const REASON_TEXT: Record<InvalidReason, string> = {
  silence: '全程接近静音，没有可用声音。',
  noise_floor: '只检测到持续平稳的背景噪声（如风扇、电流声），缺少人声声调起伏。',
  transient: '只有一次短促响声，像敲击或碰撞，不足以分析情绪。',
  too_short: '说话时间过短（不足 0.4 秒），无法可靠判断情绪。',
};

const EPS = 1e-7;
const toDb = (rms: number) => 20 * Math.log10(Math.max(rms, EPS));

/** 线性插值百分位（q 取 0..1），输入会被复制后排序，结果确定。 */
export function percentile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const position = (sortedAsc.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sortedAsc[lower];
  return sortedAsc[lower] + (sortedAsc[upper] - sortedAsc[lower]) * (position - lower);
}

interface ResolvedConfig {
  sampleRate: number;
  frameSize: number;
  hopSize: number;
  adaptiveMarginDb: number;
  absoluteGateDb: number;
  floorPercentile: number;
  mergeGapSec: number;
  modulationDb: number;
  impulseModulationDb: number;
  minVoicedSec: number;
  minVoicedRatio: number;
  minSegmentSec: number;
}

function resolveConfig(config: DetectorConfig): ResolvedConfig {
  const frameMs = config.frameMs ?? 30;
  const hopMs = config.hopMs ?? 10;
  return {
    sampleRate: config.sampleRate,
    frameSize: Math.max(1, Math.round(config.sampleRate * frameMs / 1000)),
    hopSize: Math.max(1, Math.round(config.sampleRate * hopMs / 1000)),
    adaptiveMarginDb: config.adaptiveMarginDb ?? 9,
    absoluteGateDb: config.absoluteGateDb ?? -45,
    floorPercentile: config.floorPercentile ?? 0.2,
    mergeGapSec: (config.mergeGapMs ?? 120) / 1000,
    modulationDb: config.modulationDb ?? 5,
    impulseModulationDb: config.impulseModulationDb ?? 25,
    minVoicedSec: (config.minVoicedMs ?? 400) / 1000,
    minVoicedRatio: config.minVoicedRatio ?? 0.08,
    minSegmentSec: (config.minSegmentMs ?? 300) / 1000,
  };
}

function buildFrames(samples: Float32Array, cfg: ResolvedConfig): VoiceFrame[] {
  const frames: VoiceFrame[] = [];
  const frameSec = cfg.frameSize / cfg.sampleRate;
  for (let offset = 0; offset + cfg.frameSize <= samples.length; offset += cfg.hopSize) {
    let sum = 0;
    for (let i = 0; i < cfg.frameSize; i += 1) sum += samples[offset + i] * samples[offset + i];
    const rms = Math.sqrt(sum / cfg.frameSize);
    const start = offset / cfg.sampleRate;
    frames.push({ start, end: start + frameSec, rms, db: toDb(rms), active: false });
  }
  return frames;
}

function estimateFloor(frames: VoiceFrame[], cfg: ResolvedConfig): number {
  const sorted = frames.map((f) => f.db).sort((a, b) => a - b);
  const first = percentile(sorted, cfg.floorPercentile);
  // 只用贴近本底的帧再估一次，避免语音占满片段时基线被抬高。
  const nearFloor = sorted.filter((db) => db <= first + 6);
  return percentile(nearFloor.length >= 4 ? nearFloor : sorted, cfg.floorPercentile);
}

/** 把有声帧按 ≤ mergeGapSec 的间隙合并成声段，并计算段内调制深度。 */
function buildSegments(frames: VoiceFrame[], cfg: ResolvedConfig): VoiceSegment[] {
  const active = frames.filter((f) => f.active);
  if (!active.length) return [];
  const groups: VoiceFrame[][] = [[active[0]]];
  for (let i = 1; i < active.length; i += 1) {
    const previous = groups[groups.length - 1][groups[groups.length - 1].length - 1];
    if (active[i].start - previous.start <= cfg.mergeGapSec + 1e-6) groups[groups.length - 1].push(active[i]);
    else groups.push([active[i]]);
  }
  return groups.map((group) => {
    const levels = group.map((f) => f.db).sort((a, b) => a - b);
    const modulationDb = percentile(levels, 0.9) - percentile(levels, 0.1);
    return {
      start: group[0].start,
      end: group[group.length - 1].end,
      frames: group,
      modulationDb,
      steadyNoise: modulationDb < cfg.modulationDb,
      impulsive: modulationDb > cfg.impulseModulationDb,
    };
  });
}

export function assessVoice(samples: Float32Array, config: DetectorConfig): VoiceAssessment {
  const cfg = resolveConfig(config);
  const duration = samples.length / cfg.sampleRate;
  const frames = buildFrames(samples, cfg);
  const floorDb = frames.length ? estimateFloor(frames, cfg) : -Infinity;
  const gateDb = Math.min(floorDb + cfg.adaptiveMarginDb, cfg.absoluteGateDb);
  frames.forEach((frame) => { frame.active = frame.db >= gateDb; });

  const segments = buildSegments(frames, cfg);
  // 通过调制检验的声段才算“讲话”；稳态噪声与脉冲式单次响声被否决。
  const voiced = segments.filter((segment) => !segment.steadyNoise && !segment.impulsive);
  const voicedDuration = voiced.reduce((sum, segment) => sum + (segment.end - segment.start), 0);
  const activeCount = voiced.reduce((sum, segment) => sum + segment.frames.length, 0);
  const voicedRatio = frames.length ? activeCount / frames.length : 0;

  const pauses: Array<{ start: number; end: number }> = [];
  for (let i = 1; i < voiced.length; i += 1) {
    pauses.push({ start: voiced[i - 1].end, end: voiced[i].start });
  }
  const pauseDuration = pauses.reduce((sum, pause) => sum + (pause.end - pause.start), 0);

  let clipped = 0;
  for (let i = 0; i < samples.length; i += 1) if (Math.abs(samples[i]) >= 0.99) clipped += 1;
  const clipping = samples.length > 0 && clipped / samples.length >= 0.01;

  const anyActive = frames.some((frame) => frame.active);
  const allSteadyNoise = segments.length > 0 && voiced.length === 0
    && segments.every((segment) => segment.steadyNoise);
  const anyImpulse = segments.some((segment) => segment.impulsive);
  const oneShortVoiced = voiced.length === 1
    && voiced[0].end - voiced[0].start < cfg.minSegmentSec;

  let reason: InvalidReason | undefined;
  if (!anyActive) reason = 'silence';
  else if (allSteadyNoise) reason = 'noise_floor';
  else if (voiced.length === 0 && anyImpulse) reason = 'transient';
  else if (oneShortVoiced || voicedDuration < cfg.minVoicedSec || voicedRatio < cfg.minVoicedRatio
    || !(voiced.some((segment) => segment.end - segment.start >= cfg.minSegmentSec) || voiced.length >= 2)) {
    reason = 'too_short';
  }

  return {
    valid: reason === undefined,
    reason,
    reasonText: reason ? REASON_TEXT[reason] : undefined,
    duration,
    voicedDuration,
    voicedRatio,
    pauseCount: pauses.length,
    pauseDuration,
    pauses,
    clipping,
    floorDb,
    gateDb,
    frames,
    segments: voiced,
  };
}
