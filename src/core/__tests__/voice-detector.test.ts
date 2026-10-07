import { describe, expect, it } from 'vitest';
import { assessVoice, percentile } from '../voice-detector';

const SAMPLE_RATE = 48000;

function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function render(lengthSec: number, fn: (t: number) => number): Float32Array {
  const samples = new Float32Array(Math.floor(lengthSec * SAMPLE_RATE));
  for (let i = 0; i < samples.length; i += 1) samples[i] = fn(i / SAMPLE_RATE);
  return samples;
}

const silence = (lengthSec = 3) => {
  const random = mulberry32(101);
  return render(lengthSec, () => (random() - 0.5) * 0.0001); // ≈ -86 dBFS，近似全静音
};
const steadyNoise = (lengthSec: number, amplitude: number, seed: number) => {
  const random = mulberry32(seed);
  return render(lengthSec, () => (random() - 0.5) * amplitude); // 能量平稳、无语调起伏
};
const singleBang = (lengthSec = 3) => {
  const random = mulberry32(202);
  return render(lengthSec, (t) => {
    if (t >= 1 && t < 1.12) { const k = (t - 1) / 0.12; return Math.sin(2 * Math.PI * 180 * t) * 0.6 * Math.exp(-k * 8); }
    return (random() - 0.5) * 0.0002;
  });
};
const softSpeech = (lengthSec = 3) => {
  const random = mulberry32(303);
  return render(lengthSec, (t) => {
    if (t < 0.25) return (random() - 0.5) * 0.004; // 先有一点本底噪声
    const envelope = 0.5 + 0.5 * Math.sin(2 * Math.PI * 3 * (t - 0.25));
    return Math.sin(2 * Math.PI * 180 * t) * 0.02 * envelope + (random() - 0.5) * 0.004;
  });
};
const normalSpeech = (lengthSec = 3) => {
  const random = mulberry32(404);
  return render(lengthSec, (t) => {
    if (t >= 1.3 && t < 1.7) return (random() - 0.5) * 0.0002; // 句中停顿
    const envelope = Math.max(0, 0.55 + 0.45 * Math.sin(2 * Math.PI * 4.5 * t));
    return Math.sin(2 * Math.PI * 220 * t) * 0.42 * envelope + (random() - 0.5) * 0.0002;
  });
};

describe('assessVoice', () => {
  it('rejects near-silence and explains why', () => {
    const result = assessVoice(silence(), { sampleRate: SAMPLE_RATE });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('silence');
    expect(result.reasonText).toContain('静音');
    expect(result.voicedDuration).toBe(0);
    expect(result.frames.length).toBeGreaterThan(0);
  });

  it('rejects quiet steady noise without mistaking the fixed floor for speech', () => {
    // -55 dBFS 左右的空调/风扇声：低于绝对地板，不应当成讲话
    const result = assessVoice(steadyNoise(3, 0.004, 505), { sampleRate: SAMPLE_RATE });
    expect(result.valid).toBe(false);
    expect(['silence', 'noise_floor']).toContain(result.reason);
  });

  it('rejects loud steady noise even when AGC lifts it above an adaptive-only gate', () => {
    // AGC 把本底噪声抬到约 -35 dBFS：自适应门槛会放行，必须靠调制结构否决
    const result = assessVoice(steadyNoise(3, 0.035, 606), { sampleRate: SAMPLE_RATE });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('noise_floor');
    expect(result.reasonText).toContain('背景噪声');
  });

  it('rejects a single impulsive bang as transient, not speech', () => {
    const result = assessVoice(singleBang(), { sampleRate: SAMPLE_RATE });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('transient');
    expect(result.reasonText).toContain('短促响声');
  });

  it('accepts quiet speech above a realistic noise floor (fixed threshold must not hurt it)', () => {
    const result = assessVoice(softSpeech(), { sampleRate: SAMPLE_RATE });
    expect(result.valid).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(result.voicedDuration).toBeGreaterThan(1);
  });

  it('accepts normal speech and reports voiced duration and pauses', () => {
    const result = assessVoice(normalSpeech(), { sampleRate: SAMPLE_RATE });
    expect(result.valid).toBe(true);
    expect(result.voicedDuration).toBeGreaterThan(1.5);
    expect(result.pauseCount).toBeGreaterThanOrEqual(1);
    expect(result.pauseDuration).toBeGreaterThan(0.2);
    expect(result.segments.length).toBeGreaterThanOrEqual(2);
  });

  it('rejects speech shorter than the minimum usable duration as too_short', () => {
    const random = mulberry32(707);
    const samples = render(2, (t) => {
      if (t >= 0.8 && t < 1.0) return Math.sin(2 * Math.PI * 200 * t) * 0.05 * (0.5 + 0.5 * Math.sin(2 * Math.PI * 12 * (t - 0.8)));
      return (random() - 0.5) * 0.0002;
    });
    const result = assessVoice(samples, { sampleRate: SAMPLE_RATE });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('too_short');
    expect(result.reasonText).toContain('0.4 秒');
  });

  it('is deterministic for borderline input analysed repeatedly', () => {
    // 恰好落在最短时长附近的临界输入：重复分析必须得到完全一致的结论
    const random = mulberry32(808);
    const samples = render(1.2, (t) => {
      if (t >= 0.3 && t < 0.75) return Math.sin(2 * Math.PI * 190 * t) * 0.06 * (0.5 + 0.5 * Math.sin(2 * Math.PI * 9 * (t - 0.3)));
      return (random() - 0.5) * 0.0003;
    });
    const first = assessVoice(samples, { sampleRate: SAMPLE_RATE });
    const second = assessVoice(samples, { sampleRate: SAMPLE_RATE });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('flags clipping as a non-blocking warning', () => {
    const clipped = render(1, (t) => (Math.sin(2 * Math.PI * 240 * t) > 0 ? 1 : -1) * (t < 0.9 ? 1 : 0.001));
    const result = assessVoice(clipped, { sampleRate: SAMPLE_RATE });
    expect(result.clipping).toBe(true);
  });

  it('produces only finite values and stays safe on empty input', () => {
    const result = assessVoice(new Float32Array(0), { sampleRate: SAMPLE_RATE });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('silence');
    expect(Number.isFinite(result.duration)).toBe(true);
  });
});

describe('percentile', () => {
  it('interpolates deterministically', () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentile([7], 0.5)).toBe(7);
  });
});
