import { describe, expect, it } from 'vitest';
import { WebAudioCropperAdapter, type DecodedAudio } from '../web-audio-cropper.adapter';
import { WebAudioAnalyzerAdapter } from '../web-audio-analyzer.adapter';

const decoded = (duration = 12): DecodedAudio => ({ sampleRate: 10, duration, channels: [Float32Array.from({ length: duration * 10 }, (_, index) => index % 5 ? .4 : 0)] });

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
    expect(result.voice.evidence.frameCount).toBeGreaterThan(0);
  });
  it('gates a fully silent clip as invalid and leaves pitch unpolluted', async () => {
    const silent: DecodedAudio = { sampleRate: 8000, duration: 1, channels: [new Float32Array(8000)] };
    const result = await new WebAudioAnalyzerAdapter({ decode: async () => silent }).analyze(new Blob());
    expect(result.voice.hasVoice).toBe(false);
    expect(result.voice.reasons).toContain('all-silence');
    expect(result.features.pitch).toBe(0);
    expect(Object.values(result.features).every(Number.isFinite)).toBe(true);
  });
  it('accepts speech-shaped audio and measures voiced time', async () => {
    const sr = 8000; const samples = new Float32Array(sr * 2);
    for (let i = 0; i < samples.length; i += 1) {
      const inVoice = i > sr * 0.3 && i < sr * 1.3;
      samples[i] = inVoice ? 0.2 * Math.sin((2 * Math.PI * 140 * i) / sr) : 0.0002;
    }
    const result = await new WebAudioAnalyzerAdapter({ decode: async () => ({ sampleRate: sr, duration: 2, channels: [samples] }) }).analyze(new Blob());
    expect(result.voice.hasVoice).toBe(true);
    expect(result.voice.voicedDuration).toBeGreaterThan(0.8);
    expect(result.features.pitch).toBeGreaterThan(0);
  });
});
