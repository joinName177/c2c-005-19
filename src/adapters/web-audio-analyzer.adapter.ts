import { normalizeFeatures } from '../core/feature-normalizer';
import { assessVoiceActivity, FRAME_HOP_S, FRAME_WINDOW_S } from '../core/voice-activity';
import type { AudioAnalyzerPort } from '../ports/audio-analyzer.port';
import type { DecodedAudio } from './web-audio-cropper.adapter';
interface Dependencies { decode(blob: Blob): Promise<DecodedAudio> }
async function decode(blob: Blob): Promise<DecodedAudio> { const context = new AudioContext(); const buffer = await context.decodeAudioData(await blob.arrayBuffer()); const result = { sampleRate: buffer.sampleRate, duration: buffer.duration, channels: [buffer.getChannelData(0).slice()] }; await context.close(); return result; }

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

export class WebAudioAnalyzerAdapter implements AudioAnalyzerPort {
  constructor(private readonly deps: Dependencies = { decode }) {}
  async analyze(blob: Blob) {
    const audio = await this.deps.decode(blob);
    const samples = audio.channels[0] ?? new Float32Array();
    const duration = audio.duration;
    const voice = assessVoiceActivity({ samples, sampleRate: audio.sampleRate, duration });

    // 能量特征基于同一份裁剪后 PCM 的 20ms/10ms 帧；停顿占比改由 VAD 发声段统计，
    // 替代旧的「单样本绝对值 <0.02」固定门槛（该门槛会把轻声整段算成停顿）。
    const windowSize = Math.max(1, Math.round(audio.sampleRate * FRAME_WINDOW_S));
    const hopSize = Math.max(1, Math.round(audio.sampleRate * FRAME_HOP_S));
    const frameRms: number[] = [];
    for (let start = 0; start + windowSize <= samples.length; start += hopSize) {
      let energy = 0;
      for (let i = start; i < start + windowSize; i += 1) energy += samples[i] * samples[i];
      frameRms.push(Math.sqrt(energy / windowSize));
    }
    const rms = frameRms.length ? Math.sqrt(frameRms.reduce((sum, value) => sum + value * value, 0) / frameRms.length) : 0;
    const levelSpread = frameRms.length ? percentile(frameRms, 90) - percentile(frameRms, 10) : 0;

    // 过零率/音高只在 VAD 判为发声的样本上统计，静音与底噪不再污染音高。
    const zcr = voice.evidence.voicedFrameZcr;
    const pitchHz = voice.voicedDuration > 0 ? zcr * audio.sampleRate / 2 : 0;
    const crossings = zcr * voice.voicedDuration * audio.sampleRate;

    const features = normalizeFeatures({
      rms,
      dynamicRange: Math.min(1, levelSpread / 0.4),
      pitchHz,
      zeroCrossingRate: Math.min(1, zcr * 10),
      pauseRatio: duration > 0 ? Math.min(1, voice.pauseDuration / duration) : 1,
      tempoVariation: Math.min(1, crossings / Math.max(1, voice.voicedDuration * 30)),
    });
    return { features, voice, duration };
  }
}
