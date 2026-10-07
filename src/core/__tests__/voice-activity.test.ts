import { describe, expect, it } from 'vitest';
import { assessVoiceActivity } from '../voice-activity';
import type { VoiceActivityInput } from '../voice-activity';

const SR = 22050;
const make = (samples: Float32Array, duration: number): VoiceActivityInput => ({ samples, sampleRate: SR, duration });
const noise = (n: number, amp: number) => Float32Array.from({ length: n }, () => (Math.random() * 2 - 1) * amp);
/** 类讲话信号：低频基频 + 少量随机抖动，模拟元音发声（过零率低）。 */
function voiceLike(n: number, amp: number, freq = 130) {
  return Float32Array.from({ length: n }, (_, i) => amp * (0.85 * Math.sin((2 * Math.PI * freq * i) / SR) + 0.15 * (Math.random() * 2 - 1)));
}
function overlay(base: Float32Array, signal: Float32Array, at: number) {
  const start = Math.floor(at * SR);
  for (let i = 0; i < signal.length && start + i < base.length; i += 1) base[start + i] = signal[i];
}

describe('assessVoiceActivity', () => {
  it('classifies digital silence as all-silence without emotion-grade evidence', () => {
    const result = assessVoiceActivity(make(new Float32Array(SR * 2), 2));
    expect(result.hasVoice).toBe(false);
    expect(result.reasons).toContain('all-silence');
    expect(result.voicedDuration).toBe(0);
  });

  it('does not mistake a sustained low-level noise floor for talking', () => {
    // 持续平稳底噪：自适应门槛会跟着抬高，但帧间对比远小于 6dB。
    const result = assessVoiceActivity(make(noise(SR * 2, 0.004), 2));
    expect(result.hasVoice).toBe(false);
    expect(result.reasons).toContain('continuous-noise');
    expect(result.evidence.contrastDb).toBeLessThan(6);
  });

  it('does not accept a single broadband clap/knock as speech', () => {
    const clip = noise(SR * 2, 0.0008);
    overlay(clip, noise(0.1 * SR, 0.5), 0.9);
    const result = assessVoiceActivity(make(clip, 2));
    expect(result.hasVoice).toBe(false);
    expect(result.reasons).toContain('isolated-sound');
    expect(result.pauseCount).toBe(0);
  });

  it('keeps soft speech valid on a noisy device (adaptive floor, not a fixed gate)', () => {
    // 轻声约 -35dBFS（0.018）叠加可听见的底噪；固定 -30dBFS 门槛会整段判静音。
    const clip = noise(SR * 2, 0.002);
    overlay(clip, voiceLike(1.0 * SR, 0.018), 0.5);
    const result = assessVoiceActivity(make(clip, 2));
    expect(result.hasVoice).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(result.voicedDuration).toBeGreaterThanOrEqual(0.9);
    expect(result.evidence.thresholdDb).toBeLessThan(-30);
  });

  it('accepts normal speech and reports voiced time and pauses', () => {
    const clip = noise(SR * 3, 0.0005);
    overlay(clip, voiceLike(0.8 * SR, 0.22), 0.3);
    overlay(clip, voiceLike(0.9 * SR, 0.2), 1.4);
    const result = assessVoiceActivity(make(clip, 3));
    expect(result.hasVoice).toBe(true);
    expect(result.voicedDuration).toBeGreaterThan(1.4);
    expect(result.pauseCount).toBe(1);
    expect(result.pauseDuration).toBeGreaterThanOrEqual(0.12);
  });

  it('rejects clips shorter than the sampling window', () => {
    const result = assessVoiceActivity(make(noise(Math.floor(SR * 0.1), 0.3), 0.1));
    expect(result.hasVoice).toBe(false);
    expect(result.reasons).toEqual(['too-short']);
  });

  it('is deterministic: repeated analysis of the same input is identical', () => {
    const clip = noise(SR * 2, 0.002);
    overlay(clip, voiceLike(0.8 * SR, 0.05), 0.4);
    const first = assessVoiceActivity(make(clip, 2));
    const second = assessVoiceActivity(make(Float32Array.from(clip), 2));
    expect(second).toEqual(first);
  });
});
