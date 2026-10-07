import { reactive, ref } from 'vue';
import { classifyEmotion } from '../core/emotion-engine';
import { coverPresetFor } from '../core/cover-presets';
import type { AudioFeatures, CoverConfig, EmotionLabel, EmotionResult, EmotionSource, StudioStage, VoiceActivityAssessment, VoiceMeme } from '../core/models';
import type { RecorderPort } from '../ports/recorder.port';
import type { AudioAnalyzerPort } from '../ports/audio-analyzer.port';
import type { AudioCropperPort } from '../ports/audio-cropper.port';
import type { CoverRendererPort } from '../ports/cover-renderer.port';
import type { MemeRepository } from '../ports/meme-repository.port';
import type { SharePort } from '../ports/share.port';

export interface StudioDependencies { recorder: RecorderPort; analyzer: AudioAnalyzerPort; cropper: AudioCropperPort; renderer: CoverRendererPort; repository: MemeRepository; share: SharePort }
export function useStudio(deps: StudioDependencies) {
  const stage = ref<StudioStage>('record'); const error = ref(''); const notice = ref(''); const level = ref(0);
  const draft = reactive<{ id?: string; title: string; audio?: Blob; duration: number; cropStart: number; cropEnd: number }>({ title: '我的声音表情', duration: 0, cropStart: 0, cropEnd: 0 });
  const emotion = ref<EmotionResult>(); const features = ref<AudioFeatures>(); const assessment = ref<VoiceActivityAssessment>(); const emotionSource = ref<EmotionSource>(); const cover = ref<CoverConfig>(coverPresetFor('元气满满')); const collection = ref<VoiceMeme[]>([]);

  /** 清空上一轮分析的结论与依据：重录、重新导入或重新分析时，旧警告/旧百分比不能残留。 */
  function resetAnalysis() { emotion.value = undefined; features.value = undefined; assessment.value = undefined; emotionSource.value = undefined; error.value = ''; notice.value = ''; }

  async function startRecording() { error.value = ''; try { await deps.recorder.start((value) => { level.value = value; }); notice.value = '正在录音，最长 10 秒'; } catch { error.value = '无法使用麦克风权限，请在浏览器设置中允许访问或导入音频。'; } }
  async function stopRecording() { try { resetAnalysis(); draft.audio = await deps.recorder.stop(); const info = await deps.cropper.inspect(draft.audio); draft.duration = info.duration; draft.cropStart = 0; draft.cropEnd = Math.min(10, info.duration); stage.value = 'crop'; notice.value = info.needsCrop ? '音频超过 10 秒，请选择保留片段' : '录音完成，可以试听并分析'; } catch (cause) { error.value = cause instanceof Error ? cause.message : '录音结束失败'; } }
  async function importAudio(blob: Blob) { resetAnalysis(); draft.id = undefined; draft.audio = blob; const info = await deps.cropper.inspect(blob); draft.duration = info.duration; draft.cropStart = 0; draft.cropEnd = Math.min(10, info.duration); stage.value = 'crop'; }
  async function analyze() {
    if (!draft.audio) { error.value = '请先录制或导入一段声音'; return; }
    resetAnalysis();
    const cropped = await deps.cropper.crop(draft.audio, { start: draft.cropStart, end: draft.cropEnd });
    draft.audio = cropped.blob; draft.duration = cropped.duration;
    const result = await deps.analyzer.analyze(cropped.blob);
    features.value = result.features; assessment.value = result.voice;
    // 有效声音闸门：没有可靠人声时不运行情绪匹配，界面不得展示虚假的自动百分比。
    // 原因与依据由情绪阶段内的警告卡展示（notice 已在 resetAnalysis 清空，避免旧文案残留）。
    if (result.voice.hasVoice) {
      emotion.value = classifyEmotion(result.features); emotionSource.value = 'auto';
      cover.value = coverPresetFor(emotion.value.label);
    }
    stage.value = 'emotion';
  }
  function selectEmotion(label: EmotionLabel) {
    // 无论自动建议是否成立，用户都可以明确手选；来源标记为 manual，不再显示自动百分比。
    emotion.value = { ...(emotion.value ?? classifyEmotion({ loudness: 0, dynamics: 0, pitch: 0, zeroCrossing: 0, pauseRatio: 1, tempoVariation: 0 })), label, confidence: 0, explanation: `已手动选择「${label}」标签。`, scores: emotion.value?.scores ?? { '暴躁老哥': 0, '温柔姐姐': 0, '阴阳怪气': 0, '元气满满': 0 } };
    emotionSource.value = 'manual';
    cover.value = { ...coverPresetFor(label), title: cover.value.title || label };
  }
  function goCover() { stage.value = 'cover'; }
  async function save(target?: HTMLCanvasElement) {
    if (!draft.audio || !emotion.value || !features.value || !emotionSource.value) { error.value = '作品信息尚未完整，请先完成声音分析或手动选择一个情绪标签'; return; }
    try {
      const coverBlob = await deps.renderer.render(cover.value, target);
      const meme: VoiceMeme = { id: draft.id ?? `meme-${Date.now()}`, title: draft.title.trim() || '未命名声音', emotion: emotion.value.label, confidence: emotionSource.value === 'manual' ? 0 : emotion.value.confidence, emotionSource: emotionSource.value, features: features.value, voiceAssessment: assessment.value?.hasVoice ? assessment.value : undefined, audio: draft.audio, duration: draft.duration, cover: coverBlob, coverConfig: { ...cover.value }, createdAt: new Date().toISOString() };
      await deps.repository.save(meme); await loadCollection(); stage.value = 'collection'; notice.value = '作品已保存到本地';
    } catch { error.value = '保存失败，本次编辑内容仍保留，请检查浏览器存储空间。'; }
  }
  async function loadCollection() { collection.value = (await deps.repository.list()).sort((a,b) => b.createdAt.localeCompare(a.createdAt)); }
  function editMeme(meme: VoiceMeme) {
    Object.assign(draft, { id: meme.id, title: meme.title, audio: meme.audio, duration: meme.duration, cropStart: 0, cropEnd: meme.duration });
    features.value = meme.features;
    // 重新打开仍须分清：自动建议显示百分比；人工选择显示「手动选择」且无自动百分比。
    const source: EmotionSource = meme.emotionSource ?? 'auto';
    emotionSource.value = source;
    if (source === 'manual') {
      emotion.value = { label: meme.emotion, confidence: 0, explanation: `已手动选择「${meme.emotion}」标签。`, scores: { '暴躁老哥': 0, '温柔姐姐': 0, '阴阳怪气': 0, '元气满满': 0 } };
    } else {
      emotion.value = { label: meme.emotion, confidence: meme.confidence, explanation: '自动建议（来自声音特征）', scores: { '暴躁老哥': 0, '温柔姐姐': 0, '阴阳怪气': 0, '元气满满': 0 } };
    }
    assessment.value = meme.voiceAssessment;
    cover.value = { ...meme.coverConfig }; stage.value = 'cover';
  }
  async function deleteMeme(id: string) { await deps.repository.delete(id); await loadCollection(); }
  async function shareMeme(meme: VoiceMeme) { const result = await deps.share.share(meme); notice.value = result === 'shared' ? '已打开系统分享' : '浏览器不支持文件分享，已下载音频和封面'; }
  function newRecording() { resetAnalysis(); draft.id = undefined; draft.title = '我的声音表情'; draft.audio = undefined; stage.value = 'record'; notice.value = ''; }
  return { stage, error, notice, level, draft, emotion, features, assessment, emotionSource, cover, collection, startRecording, stopRecording, importAudio, analyze, selectEmotion, goCover, save, loadCollection, editMeme, deleteMeme, shareMeme, newRecording };
}
