import type { InvalidVoiceReason, VoiceActivityAssessment } from './models';

/**
 * 有效声音判定（VAD）——位于特征计算与情绪匹配之间的纯函数闸门。
 *
 * 设备录音增益差异大，任何单一门槛都会误伤：
 * - 固定绝对门槛：轻声（贴近麦克风约 -35dBFS）在高噪底设备上会被当成静音；
 * - 纯相对（噪底+Δ）门槛：持续空调/电流噪声会整体抬高，被当成连续讲话。
 * 因此采用「自适应门槛 + 最小绝对门槛 + 信噪比对比 + 时长/节奏约束」的组合判定，
 * 取样与阈值依据全部随评估结果回传，便于界面解释、也便于重分析时核对。
 *
 * 取样范围：与情绪分析同一份裁剪后单声道 PCM，帧窗 20ms、帧移 10ms（语音 VAD 常用尺度）。
 */

export const FRAME_WINDOW_S = 0.02;
export const FRAME_HOP_S = 0.01;
/** 自适应门槛 = 噪底（第 10 百分位帧能量）+ 9dB，但夹在 [-60, -30] dBFS：
 * -60 下限保证极轻讲话不被数字底噪淹没，-30 上限避免持续噪声整体被认作讲话。 */
export const MIN_GATE_DB = -60;
export const MAX_GATE_DB = -30;
export const GATE_MARGIN_DB = 9;
/** 候选帧必须同时高过自适应门槛，且与噪底拉开 6dB 信噪比，稳态噪声因此过不了。 */
export const MIN_CONTRAST_DB = 6;
/** 有效讲话的最低累计时长与占比：低于它，四个情绪标签都没有可靠依据。 */
export const MIN_VOICED_S = 0.3;
export const MIN_VOICED_RATIO = 0.05;
/** 短于一个帧窗（20ms）的能量尖刺直接丢弃；间隔 ≤50ms 的尖刺视为连续发声。 */
export const MIN_RUN_S = 0.06;
export const MERGE_GAP_S = 0.05;
/** 两次发声之间 ≥120ms 才计为一次停顿。 */
export const MIN_PAUSE_S = 0.12;
/** 短于 0.2s 的素材本身不可分析（帧样本不足）。 */
export const MIN_CLIP_S = 0.2;
/** 宽带瞬态（拍手/磕碰）过零率显著高于元音发声，用于识别单次响声。 */
export const TRANSIENT_ZCR = 0.2;
const SILENCE_FLOOR_DB = -120;

export interface VoiceActivityInput { samples: Float32Array; sampleRate: number; duration: number }

export const INVALID_REASON_COPY: Record<InvalidVoiceReason, string> = {
  'all-silence': '整段接近静音，没有检测到任何人声。',
  'continuous-noise': '存在持续且平稳的背景噪声，但没有起伏明显的讲话声。',
  'insufficient-voice': '有效讲话累计过短或占比过低，不足以下可靠结论。',
  'isolated-sound': '只检测到一次短促响声（如拍手、磕碰），不是成句的讲话。',
  'too-short': '片段过短（不足 0.2 秒），无法取样分析。',
};

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return SILENCE_FLOOR_DB;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

interface Run { startFrame: number; endFrame: number }

export function assessVoiceActivity(input: VoiceActivityInput): VoiceActivityAssessment {
  const { samples, sampleRate, duration } = input;
  const empty: VoiceActivityAssessment = {
    hasVoice: false, duration, voicedDuration: 0, voicedRatio: 0, pauseCount: 0, pauseDuration: 0,
    reasons: ['too-short'], evidence: { frameCount: 0, activeFrameCount: 0, thresholdDb: MIN_GATE_DB, noiseFloorDb: SILENCE_FLOOR_DB, contrastDb: 0, voicedFrameZcr: 0 },
  };
  if (!Number.isFinite(duration) || duration < MIN_CLIP_S || samples.length < Math.ceil(sampleRate * FRAME_WINDOW_S)) return empty;

  const windowSize = Math.max(1, Math.round(sampleRate * FRAME_WINDOW_S));
  const hopSize = Math.max(1, Math.round(sampleRate * FRAME_HOP_S));
  const frameDb: number[] = [];
  for (let start = 0; start + windowSize <= samples.length; start += hopSize) {
    let energy = 0;
    for (let i = start; i < start + windowSize; i += 1) energy += samples[i] * samples[i];
    const rms = Math.sqrt(energy / windowSize);
    frameDb.push(rms > 0 ? Math.max(SILENCE_FLOOR_DB, 20 * Math.log10(rms)) : SILENCE_FLOOR_DB);
  }
  const sorted = [...frameDb].sort((a, b) => a - b);
  const noiseFloorDb = percentile(sorted, 10);
  const peakFloorDb = percentile(sorted, 90);
  const contrastDb = Math.max(0, peakFloorDb - noiseFloorDb);
  const thresholdDb = Math.min(MAX_GATE_DB, Math.max(MIN_GATE_DB, noiseFloorDb + GATE_MARGIN_DB));

  const active: number[] = [];
  for (let i = 0; i < frameDb.length; i += 1) {
    if (frameDb[i] >= thresholdDb && frameDb[i] - noiseFloorDb >= MIN_CONTRAST_DB) active.push(i);
  }

  // 合并 ≤50ms 的缝隙、得到候选发声段；短于 60ms 的尖刺不计入有效时长，
  // 但保留下来用于识别「单次响声」，避免把一拍磕碰误报成静音。
  const runs: Run[] = [];
  for (const frame of active) {
    const last = runs[runs.length - 1];
    if (last && (frame - last.endFrame) * FRAME_HOP_S <= MERGE_GAP_S) last.endFrame = frame;
    else runs.push({ startFrame: frame, endFrame: frame });
  }
  const accepted = runs.filter((run) => (run.endFrame - run.startFrame) * FRAME_HOP_S + FRAME_WINDOW_S >= MIN_RUN_S);

  const activeFrameCount = accepted.reduce((sum, run) => sum + (run.endFrame - run.startFrame + 1), 0);
  const voicedDuration = Math.min(duration, activeFrameCount > 0 ? activeFrameCount * FRAME_HOP_S + accepted.length * (FRAME_WINDOW_S - FRAME_HOP_S) : 0);
  const voicedRatio = duration > 0 ? Math.min(1, voicedDuration / duration) : 0;

  // 在全部候选发声段（含短尖刺）上统计过零率，避免静音段把瞬态特征稀释掉。
  const voiced = new Uint8Array(samples.length);
  for (const run of runs) {
    const startSample = run.startFrame * hopSize;
    const endSample = Math.min(samples.length, (run.endFrame + 1) * hopSize + (windowSize - hopSize));
    for (let i = startSample; i < endSample; i += 1) voiced[i] = 1;
  }
  let crossings = 0; let voicedSamples = 0;
  for (let i = 1; i < samples.length; i += 1) {
    if (voiced[i] && voiced[i - 1]) { voicedSamples += 1; if ((samples[i - 1] < 0) !== (samples[i] < 0)) crossings += 1; }
  }
  const voicedFrameZcr = voicedSamples > 0 ? crossings / voicedSamples : 0;
  const candidateDuration = runs.reduce((sum, run) => sum + (run.endFrame - run.startFrame) * FRAME_HOP_S + FRAME_WINDOW_S, 0);

  let pauseCount = 0;
  let pauseDuration = 0;
  for (let i = 1; i < accepted.length; i += 1) {
    const gap = accepted[i].startFrame * FRAME_HOP_S - (accepted[i - 1].endFrame * FRAME_HOP_S + FRAME_WINDOW_S);
    if (gap >= MIN_PAUSE_S) { pauseCount += 1; pauseDuration += gap; }
  }

  const evidence = { frameCount: frameDb.length, activeFrameCount, thresholdDb, noiseFloorDb, contrastDb, voicedFrameZcr };
  const reasons: InvalidVoiceReason[] = [];
  if (voicedDuration < MIN_VOICED_S) {
    if (activeFrameCount === 0 && candidateDuration === 0) {
      // 有持续能量却没有信噪比拉开的帧 → 平稳噪声；否则才是真正的整段静音。
      if (peakFloorDb > MIN_GATE_DB && contrastDb < MIN_CONTRAST_DB) reasons.push('continuous-noise');
      else reasons.push('all-silence');
    } else if (accepted.length <= 1 && candidateDuration < 0.5 && voicedFrameZcr > TRANSIENT_ZCR) {
      reasons.push('isolated-sound');
    } else {
      reasons.push('insufficient-voice');
    }
  }
  if (voicedRatio < MIN_VOICED_RATIO && reasons.indexOf('insufficient-voice') === -1) reasons.push('insufficient-voice');

  return { hasVoice: reasons.length === 0, duration, voicedDuration, voicedRatio, pauseCount, pauseDuration, reasons, evidence };
}
