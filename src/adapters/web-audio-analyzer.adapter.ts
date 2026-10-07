import { normalizeFeatures } from '../core/feature-normalizer';
import { assessVoice, type VoiceAssessment } from '../core/voice-detector';
import type { AudioAnalyzerPort } from '../ports/audio-analyzer.port';
import type { DecodedAudio } from './web-audio-cropper.adapter';

interface Dependencies { decode(blob: Blob): Promise<DecodedAudio> }
async function decode(blob: Blob): Promise<DecodedAudio> {
  const context = new AudioContext();
  const buffer = await context.decodeAudioData(await blob.arrayBuffer());
  const result = { sampleRate: buffer.sampleRate, duration: buffer.duration, channels: [buffer.getChannelData(0).slice()] };
  await context.close();
  return result;
}

/** 仅在通过判定的有声帧上统计特征，避免大段静音稀释结果。 */
function extractVoiced(samples: Float32Array, assessment: VoiceAssessment, sampleRate: number, duration: number) {
  const voicedFrames = assessment.frames.filter((frame) => assessment.segments.some(
    (segment) => frame.start >= segment.start - 1e-6 && frame.end <= segment.end + 1e-6,
  ));
  const indices = voicedFrames.flatMap((frame) => {
    const start = Math.round(frame.start * sampleRate);
    return Array.from({ length: Math.round((frame.end - frame.start) * sampleRate) }, (_, offset) => start + offset);
  });
  if (!indices.length) {
    return normalizeFeatures({ rms: 0, dynamicRange: 0, pitchHz: 0, zeroCrossingRate: 0, pauseRatio: 1, tempoVariation: 0 });
  }
  let sumSquares = 0; let max = 0; let previous = 0; let crossings = 0;
  const levels: number[] = [];
  for (const frame of voicedFrames) {
    const start = Math.round(frame.start * sampleRate);
    const length = Math.round((frame.end - frame.start) * sampleRate);
    let frameSquares = 0;
    for (let offset = 0; offset < length; offset += 1) {
      const value = samples[start + offset] ?? 0;
      frameSquares += value * value;
      if (Math.abs(value) > max) max = Math.abs(value);
      if (offset > 0 && (previous < 0) !== (value < 0)) crossings += 1;
      if (offset > 0) previous = value;
    }
    levels.push(Math.sqrt(frameSquares / length));
    sumSquares += frameSquares;
  }
  const rms = Math.sqrt(sumSquares / indices.length);
  const zcr = crossings / indices.length;
  const sorted = levels.sort((a, b) => a - b);
  const quiet = sorted[Math.floor(sorted.length * 0.1)] ?? rms;
  const loud = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))] ?? rms;
  const dynamicRange = quiet > 0 ? Math.min(1, Math.max(0, (loud - quiet) / Math.max(0.02, loud))) : Math.min(1, rms * 2);
  const pauseRatio = duration > 0 ? Math.max(0, Math.min(1, assessment.pauseDuration / duration)) : 1;
  const tempoVariation = Math.min(1, (assessment.segments.length + assessment.pauseCount) / Math.max(1, duration * 1.5));
  return normalizeFeatures({ rms, dynamicRange, pitchHz: zcr * sampleRate / 2, zeroCrossingRate: Math.min(1, zcr * 10), pauseRatio, tempoVariation });
}

export class WebAudioAnalyzerAdapter implements AudioAnalyzerPort {
  constructor(private readonly deps: Dependencies = { decode }) {}
  async analyze(blob: Blob) {
    const audio = await this.deps.decode(blob);
    const samples = audio.channels[0] ?? new Float32Array();
    const assessment: VoiceAssessment = assessVoice(samples, { sampleRate: audio.sampleRate });
    const features = assessment.valid ? extractVoiced(samples, assessment, audio.sampleRate, audio.duration)
      : normalizeFeatures({ rms: 0, dynamicRange: 0, pauseRatio: 1 });
    return { features, duration: audio.duration, assessment };
  }
}
