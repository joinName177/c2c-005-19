import { describe, expect, it } from 'vitest';
import { useStudio, type StudioDependencies } from '../useStudio';
import { coverPresetFor } from '../../core/cover-presets';
import type { VoiceMeme } from '../../core/models';
import type { VoiceAssessment } from '../../core/voice-detector';

const validFeatures = { loudness:.75,dynamics:.55,pitch:.8,zeroCrossing:.62,pauseRatio:.12,tempoVariation:.6 };
const validAssessment = (overrides: Partial<VoiceAssessment> = {}): VoiceAssessment => ({
  valid: true, duration: 2, voicedDuration: 1.6, voicedRatio: .8, pauseCount: 1, pauseDuration: .2,
  pauses: [{ start: .8, end: 1 }], clipping: false, floorDb: -80, gateDb: -60, frames: [], segments: [],
  ...overrides,
});
const invalidAssessment = (reason: VoiceAssessment['reason']): VoiceAssessment => ({
  valid: false, reason, reasonText: reason === 'silence' ? '全程接近静音，没有可用声音。' : '原因',
  duration: 2, voicedDuration: 0, voicedRatio: 0, pauseCount: 0, pauseDuration: 0, pauses: [],
  clipping: false, floorDb: -85, gateDb: -76, frames: [], segments: [],
});

function dependencies(overrides: Partial<StudioDependencies> = {}, assessment: VoiceAssessment = validAssessment()): StudioDependencies {
  const saved: VoiceMeme[] = [];
  return {
    recorder: { isRecording: false, start: async () => {}, stop: async () => new Blob(['voice'], { type: 'audio/webm' }) },
    analyzer: { analyze: async () => ({ duration: 2, features: validFeatures, assessment }) },
    cropper: { inspect: async () => ({duration:2,needsCrop:false}), crop: async (blob, range) => ({blob,duration:range.end-range.start}) },
    renderer: { render: async () => new Blob(['cover'], { type: 'image/png' }) },
    repository: { list: async()=>saved, save: async(m)=>{saved.push(m)}, rename:async()=>{}, delete:async()=>{} },
    share: { share: async () => 'shared' },
    ...overrides,
  };
}

describe('useStudio', () => {
  it('turns microphone denial into a recoverable error', async () => {
    const studio = useStudio(dependencies({ recorder: { isRecording:false, start:async()=>{throw new DOMException('denied','NotAllowedError')}, stop:async()=>new Blob() } }));
    await studio.startRecording();
    expect(studio.error.value).toContain('麦克风权限');
    expect(studio.stage.value).toBe('record');
  });
  it('moves recording through crop and emotion with manual override', async () => {
    const studio = useStudio(dependencies()); await studio.startRecording(); await studio.stopRecording();
    expect(studio.stage.value).toBe('crop'); await studio.analyze(); expect(studio.emotion.value?.label).toBe('元气满满');
    expect(studio.emotionSource.value).toBe('auto');
    studio.selectEmotion('温柔姐姐'); expect(studio.cover.value.label).toBe('温柔姐姐'); expect(studio.stage.value).toBe('emotion');
    expect(studio.emotionSource.value).toBe('manual');
    expect(studio.emotion.value?.confidence).toBe(0);
  });
  it('does not produce an automatic label or fake percentage when no valid voice is found', async () => {
    const studio = useStudio(dependencies({}, invalidAssessment('silence')));
    studio.draft.audio = new Blob(['silence']); studio.draft.duration = 2; studio.draft.cropEnd = 2;
    await studio.analyze();
    expect(studio.stage.value).toBe('emotion');
    expect(studio.autoEmotion.value).toBeUndefined();
    expect(studio.emotion.value).toBeUndefined();
    expect(studio.emotionSource.value).toBeUndefined();
    expect(studio.assessment.value?.reasonText).toContain('静音');
    // 保存前必须明确选择标签
    await studio.save();
    expect(studio.error.value).toContain('选择一个情绪标签');
    // 用户仍可明确选标签继续制作，并保存为人工来源
    studio.selectEmotion('温柔姐姐');
    await studio.save();
    expect(studio.stage.value).toBe('collection');
    expect(studio.collection.value[0].emotionSource).toBe('manual');
    expect(studio.collection.value[0].confidence).toBe(0);
  });
  it('clears stale warnings and evidence after recording again', async () => {
    const studio = useStudio(dependencies({}, invalidAssessment('noise_floor')));
    studio.draft.audio = new Blob(['noise']); studio.draft.duration = 2; studio.draft.cropEnd = 2;
    await studio.analyze();
    expect(studio.assessment.value?.reason).toBe('noise_floor');
    await studio.startRecording(); await studio.stopRecording();
    expect(studio.assessment.value).toBeUndefined();
    expect(studio.emotion.value).toBeUndefined();
  });
  it('gives stable results when borderline audio is analysed twice (no stale carry-over)', async () => {
    const analyzeCalls: number[] = [];
    const studio = useStudio(dependencies({ analyzer: { analyze: async () => {
      analyzeCalls.push(1);
      return { duration: 2, features: validFeatures, assessment: validAssessment() };
    } } }));
    studio.draft.audio = new Blob(['edge']); studio.draft.duration = 2; studio.draft.cropEnd = 2;
    await studio.analyze();
    const first = { label: studio.emotion.value?.label, source: studio.emotionSource.value, version: studio.analysisVersion.value };
    await studio.analyze();
    const second = { label: studio.emotion.value?.label, source: studio.emotionSource.value, version: studio.analysisVersion.value };
    expect(first.label).toBe(second.label);
    expect(first.source).toBe(second.source);
    expect(second.version).toBe(first.version + 1);
    expect(studio.assessment.value?.voicedDuration).toBe(1.6);
  });
  it('persists auto/manual source and restores it when reopening a work', async () => {
    const studio = useStudio(dependencies());
    const manual: VoiceMeme = { id:'m',title:'人工的',emotion:'温柔姐姐' as const,confidence:0,emotionSource:'manual',
      features:{loudness:.2,dynamics:.2,pitch:.4,zeroCrossing:.2,pauseRatio:.3,tempoVariation:.2},
      audio:new Blob(['a']),duration:1,cover:new Blob(['c']),coverConfig:coverPresetFor('温柔姐姐'),createdAt:'2026-10-05' };
    studio.editMeme(manual);
    expect(studio.emotionSource.value).toBe('manual');
    expect(studio.emotion.value?.confidence).toBe(0);
    expect(studio.autoEmotion.value).toBeUndefined();
    const auto: VoiceMeme = { ...manual, id:'a', emotionSource:'auto', confidence:.82, emotion:'元气满满' as const, title:'自动的' };
    studio.editMeme(auto);
    expect(studio.emotionSource.value).toBe('auto');
    expect(studio.emotion.value?.confidence).toBe(.82);
    expect(studio.autoEmotion.value?.confidence).toBe(.82);
    // 旧作品缺字段：按人工选择对待
    const legacy = { ...manual, id:'old' }; delete (legacy as Partial<VoiceMeme>).emotionSource;
    studio.editMeme(legacy);
    expect(studio.emotionSource.value).toBe('manual');
  });
  it('keeps the draft when saving fails and can edit an existing work', async () => {
    const studio = useStudio(dependencies({ repository: { list:async()=>[], save:async()=>{throw new DOMException('full','QuotaExceededError')}, rename:async()=>{}, delete:async()=>{} } }));
    studio.draft.audio = new Blob(['a']); studio.draft.duration = 1; studio.cover.value = coverPresetFor('温柔姐姐'); studio.emotion.value = { label:'温柔姐姐',confidence:0,explanation:'柔和',scores:{'暴躁老哥':0,'温柔姐姐':1,'阴阳怪气':0,'元气满满':0} };
    studio.emotionSource.value = 'manual';
    studio.features.value = { loudness:.2,dynamics:.2,pitch:.4,zeroCrossing:.2,pauseRatio:.3,tempoVariation:.2 };
    await studio.save(); expect(studio.error.value).toContain('保存失败'); expect(studio.draft.audio?.size).toBe(1);
    const existing = { id:'old',title:'旧作品',emotion:'温柔姐姐' as const,confidence:0,emotionSource:'manual' as const,features:{loudness:.2,dynamics:.2,pitch:.4,zeroCrossing:.2,pauseRatio:.3,tempoVariation:.2},audio:new Blob(['a']),duration:1,cover:new Blob(['c']),coverConfig:coverPresetFor('温柔姐姐'),createdAt:'2026-10-05' };
    studio.editMeme(existing); expect(studio.draft.title).toBe('旧作品'); expect(studio.stage.value).toBe('cover');
  });
});
