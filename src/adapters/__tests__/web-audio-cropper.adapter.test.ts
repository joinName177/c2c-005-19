import { describe, expect, it } from 'vitest';
import { WebAudioCropperAdapter, type DecodedAudio } from '../web-audio-cropper.adapter';
import { WebAudioAnalyzerAdapter } from '../web-audio-analyzer.adapter';

const decoded = (duration = 12): DecodedAudio => ({ sampleRate: 10, duration, channels: [Float32Array.from({ length: duration * 10 }, (_, index) => index % 5 ? .4 : 0)] });
const pcm = (sampleRate: number, duration: number, fn: (index: number) => number): DecodedAudio =>
  ({ sampleRate, duration, channels: [Float32Array.from({ length: sampleRate * duration }, (_, index) => fn(index))] });

describe('WebAudioCropperAdapter', () => {
  it('marks imports over ten seconds as requiring crop', async () => {
    const adapter = new WebAudioCropperAdapter({ decode: async () => decoded(12) });
    expect(await adapter.inspect(new Blob())).toEqual({ duration: 12, needsCrop: true });
  });
  it('caps encoded output range at ten seconds', async () => {
    const adapter = new WebAudioCropperAdapter({ decode: async () => decoded(12) });
    const result = await adapter.crop(new Blob(), { start: 1, end: 11 });
    expect(result.duration).toBe(10);
    expect(result.blob.type).toBe('audio/wav');
  });
});

describe('WebAudioAnalyzerAdapter', () => {
  it('extracts finite normalized features and duration', async () => {
    const result = await new WebAudioAnalyzerAdapter({ decode: async () => decoded(2) }).analyze(new Blob());
    expect(result.duration).toBe(2);
    expect(Object.values(result.features).every(Number.isFinite)).toBe(true);
    expect(result.assessment).toBeDefined();
  });
  it('rejects all silence with a reason instead of returning an emotion-feature vector', async () => {
    const audio = pcm(48000, 2, () => 0);
    const result = await new WebAudioAnalyzerAdapter({ decode: async () => audio }).analyze(new Blob());
    expect(result.assessment.valid).toBe(false);
    expect(result.assessment.reason).toBe('silence');
    expect(result.assessment.voicedDuration).toBe(0);
  });
  it('rejects steady noise that an adaptive-only threshold would admit', async () => {
    // 模拟被 AGC 抬高的平稳底噪（约 -30 dBFS 的宽带噪声），逐帧幅度几乎不变
    let state = 7;
    const nextNoise = () => { state = (state * 1103515245 + 12345) & 0x7fffffff; return (state / 0x7fffffff - 0.5) * 0.06; };
    const audio = pcm(48000, 2, () => nextNoise());
    const result = await new WebAudioAnalyzerAdapter({ decode: async () => audio }).analyze(new Blob());
    expect(result.assessment.valid).toBe(false);
    expect(result.assessment.reason).toBe('noise_floor');
  });
});
