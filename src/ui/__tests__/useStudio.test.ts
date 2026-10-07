import { describe, expect, it } from 'vitest';
import { useStudio, type StudioDependencies } from '../useStudio';
import { coverPresetFor } from '../../core/cover-presets';
import type { VoiceActivityAssessment, VoiceMeme } from '../../core/models';

const validVoice = (overrides: Partial<VoiceActivityAssessment> = {}): VoiceActivityAssessment => ({
  hasVoice: true, duration: 2, voicedDuration: 1.6, voicedRatio: .8, pauseCount: 1, pauseDuration: .2,
  reasons: [], evidence: { frameCount: 200, activeFrameCount: 160, thresholdDb: -45, noiseFloorDb: -55, contrastDb: 20, voicedFrameZcr: .08 },
  ...overrides,
});
const noVoice = (reasons: VoiceActivityAssessment['reasons']): VoiceActivityAssessment => validVoice({ hasVoice: false, voicedDuration: 0, voicedRatio: 0, pauseCount: 0, pauseDuration: 0, reasons });

function dependencies(overrides: Partial<StudioDependencies> = {}, voice: VoiceActivityAssessment = validVoice()): StudioDependencies {
  const saved: VoiceMeme[] = [];
  return {
    recorder: { isRecording: false, start: async () => {}, stop: async () => new Blob(['voice'], { type: 'audio/webm' }) },
    analyzer: { analyze: async () => ({ duration: 2, voice, features: { loudness:.75,dynamics:.55,pitch:.8,zeroCrossing:.62,pauseRatio:.12,tempoVariation:.6 } }) },
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
    studio.selectEmotion('温柔姐姐'); expect(studio.cover.value.label).toBe('温柔姐姐'); expect(studio.emotionSource.value).toBe('manual'); expect(studio.emotion.value?.confidence).toBe(0); expect(studio.stage.value).toBe('emotion');
  });
  it('blocks auto percentage without valid voice but allows an explicit manual label', async () => {
    const studio = useStudio(dependencies({}, noVoice(['all-silence'])));
    studio.draft.audio = new Blob(['a']); studio.draft.duration = 2;
    await studio.analyze();
    expect(studio.emotion.value).toBeUndefined();
    expect(studio.assessment.value?.hasVoice).toBe(false);
    expect(studio.notice.value).toBe('');
    studio.selectEmotion('阴阳怪气');
    expect(studio.emotionSource.value).toBe('manual');
    await studio.save();
    expect(studio.stage.value).toBe('collection');
    const saved = studio.collection.value[0];
    expect(saved.emotion).toBe('阴阳怪气');
    expect(saved.emotionSource).toBe('manual');
    expect(saved.confidence).toBe(0);
    expect(saved.voiceAssessment).toBeUndefined();
  });
  it('clears stale warnings and evidence when re-analyzing with new audio', async () => {
    let silent = true;
    const studio = useStudio(dependencies({
      analyzer: { analyze: async () => silent
        ? { duration: 2, voice: noVoice(['all-silence']), features: { loudness:0,dynamics:0,pitch:0,zeroCrossing:0,pauseRatio:1,tempoVariation:0 } }
        : { duration: 2, voice: validVoice(), features: { loudness:.75,dynamics:.55,pitch:.8,zeroCrossing:.62,pauseRatio:.12,tempoVariation:.6 } } },
    }));
    studio.draft.audio = new Blob(['a']); studio.draft.duration = 2;
    await studio.analyze();
    expect(studio.assessment.value?.reasons).toEqual(['all-silence']);
    expect(studio.emotion.value).toBeUndefined();
    silent = false;
    await studio.analyze();
    expect(studio.assessment.value?.hasVoice).toBe(true);
    expect(studio.notice.value).not.toContain('手动');
    expect(studio.emotion.value?.label).toBe('元气满满');
    expect(studio.emotionSource.value).toBe('auto');
  });
  it('keeps the draft when saving fails and can edit an existing work', async () => {
    const studio = useStudio(dependencies({ repository: { list:async()=>[], save:async()=>{throw new DOMException('full','QuotaExceededError')}, rename:async()=>{}, delete:async()=>{} } }));
    studio.draft.audio = new Blob(['a']); studio.draft.duration = 1; studio.cover.value = coverPresetFor('温柔姐姐'); studio.emotion.value = { label:'温柔姐姐',confidence:.8,explanation:'柔和',scores:{'暴躁老哥':0,'温柔姐姐':1,'阴阳怪气':0,'元气满满':0} };
    studio.emotionSource.value = 'auto';
    studio.features.value = { loudness:.2,dynamics:.2,pitch:.4,zeroCrossing:.2,pauseRatio:.3,tempoVariation:.2 };
    await studio.save(); expect(studio.error.value).toContain('保存失败'); expect(studio.draft.audio?.size).toBe(1);
    const existing = { id:'old',title:'旧作品',emotion:'温柔姐姐' as const,confidence:.8,emotionSource:'manual' as const,features:{loudness:.2,dynamics:.2,pitch:.4,zeroCrossing:.2,pauseRatio:.3,tempoVariation:.2},audio:new Blob(['a']),duration:1,cover:new Blob(['c']),coverConfig:coverPresetFor('温柔姐姐'),createdAt:'2026-10-05' };
    studio.editMeme(existing); expect(studio.draft.title).toBe('旧作品'); expect(studio.stage.value).toBe('cover');
    expect(studio.emotionSource.value).toBe('manual'); expect(studio.emotion.value?.confidence).toBe(0); expect(studio.emotion.value?.explanation).toContain('手动');
  });
  it('treats legacy works without an emotion source as auto suggestions on reopen', async () => {
    const studio = useStudio(dependencies());
    const legacy = { id:'legacy',title:'旧',emotion:'元气满满' as const,confidence:.72,features:{loudness:.7,dynamics:.5,pitch:.8,zeroCrossing:.6,pauseRatio:.1,tempoVariation:.6},audio:new Blob(['a']),duration:2,cover:new Blob(['c']),coverConfig:coverPresetFor('元气满满'),createdAt:'2026-10-04' } as unknown as VoiceMeme;
    studio.editMeme(legacy);
    expect(studio.emotionSource.value).toBe('auto');
    expect(studio.emotion.value?.confidence).toBe(.72);
  });
});
