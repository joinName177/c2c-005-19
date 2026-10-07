export type EmotionLabel = '暴躁老哥' | '温柔姐姐' | '阴阳怪气' | '元气满满';
export type StudioStage = 'record' | 'crop' | 'emotion' | 'cover' | 'collection';
export interface CropRange { start: number; end: number }
export interface AudioFeatures { loudness: number; dynamics: number; pitch: number; zeroCrossing: number; pauseRatio: number; tempoVariation: number }
export interface EmotionResult { label: EmotionLabel; confidence: number; explanation: string; scores: Record<EmotionLabel, number> }
export type EmotionSource = 'auto' | 'manual';
export type InvalidVoiceReason = 'all-silence' | 'continuous-noise' | 'insufficient-voice' | 'isolated-sound' | 'too-short';
export interface VoiceActivityEvidence {
  frameCount: number;
  activeFrameCount: number;
  thresholdDb: number;
  noiseFloorDb: number;
  contrastDb: number;
  voicedFrameZcr: number;
}
export interface VoiceActivityAssessment {
  hasVoice: boolean;
  duration: number;
  voicedDuration: number;
  voicedRatio: number;
  pauseCount: number;
  pauseDuration: number;
  reasons: InvalidVoiceReason[];
  evidence: VoiceActivityEvidence;
}
export interface CoverConfig {
  label: EmotionLabel;
  title: string;
  bubbleText: string;
  bubbleX: number;
  bubbleY: number;
  palette: [string, string, string];
  filter: 'none' | 'mono' | 'saturate' | 'warm' | 'cool';
  ratio: 'square' | 'portrait';
}
export interface VoiceMeme {
  id: string;
  title: string;
  emotion: EmotionLabel;
  confidence: number;
  /** 情绪结论来源：auto=声学自动建议，manual=用户明确手选；旧作品缺少该字段时按 auto 读取 */
  emotionSource: EmotionSource;
  features: AudioFeatures;
  /** 保存时的有效声音判定依据，无有效声音（人工兜底）时为空 */
  voiceAssessment?: VoiceActivityAssessment;
  audio: Blob;
  duration: number;
  cover: Blob;
  coverConfig: CoverConfig;
  createdAt: string;
}

export function validateCropRange(range: CropRange, duration: number): string | undefined {
  if (range.start < 0) return '裁剪起点不能小于 0';
  if (range.end <= range.start) return '裁剪终点必须晚于起点';
  if (range.end > duration) return '裁剪终点超出音频时长';
  if (range.end - range.start > 10) return '裁剪片段不能超过 10 秒';
  return undefined;
}
