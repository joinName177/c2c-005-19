import { reactive, ref } from 'vue';
import { classifyEmotion } from '../core/emotion-engine';
import { coverPresetFor } from '../core/cover-presets';
import type { AudioFeatures, CoverConfig, EmotionLabel, EmotionResult, EmotionSource, StudioStage, VoiceMeme, VoiceSummary } from '../core/models';
import type { VoiceAssessment } from '../core/voice-detector';
import type { RecorderPort } from '../ports/recorder.port';
import type { AudioAnalyzerPort } from '../ports/audio-analyzer.port';
import type { AudioCropperPort } from '../ports/audio-cropper.port';
import type { CoverRendererPort } from '../ports/cover-renderer.port';
import type { MemeRepository } from '../ports/meme-repository.port';
import type { SharePort } from '../ports/share.port';

export interface StudioDependencies { recorder: RecorderPort; analyzer: AudioAnalyzerPort; cropper: AudioCropperPort; renderer: CoverRendererPort; repository: MemeRepository; share: SharePort }

function zeroResult(): EmotionResult {
  return { label: '元气满满', confidence: 0, explanation: '', scores: { '暴躁老哥': 0, '温柔姐姐': 0, '阴阳怪气': 0, '元气满满': 0 } };
}

export function useStudio(deps: StudioDependencies) {
  const stage = ref<StudioStage>('record'); const error = ref(''); const notice = ref(''); const level = ref(0);
  const draft = reactive<{ id?: string; title: string; audio?: Blob; duration: number; cropStart: number; cropEnd: number }>({ title: '我的声音表情', duration: 0, cropStart: 0, cropEnd: 0 });
  // 自动建议（无有效声音时为 undefined，不显示自动百分比）；emotion 为用户最终选定结果。
  const autoEmotion = ref<EmotionResult>();
  const emotion = ref<EmotionResult>();
  const emotionSource = ref<EmotionSource>();
  const features = ref<AudioFeatures>();
  const assessment = ref<VoiceAssessment>();
  const analysisVersion = ref(0);
  const cover = ref<CoverConfig>(coverPresetFor('元气满满')); const collection = ref<VoiceMeme[]>([]);

  /** 新音频版本：旧警告、旧评估、旧依据全部清掉，避免残留。 */
  function resetAnalysis() {
    analysisVersion.value += 1;
    autoEmotion.value = undefined; emotion.value = undefined; emotionSource.value = undefined;
    features.value = undefined; assessment.value = undefined;
  }
  async function startRecording() { error.value = ''; try { await deps.recorder.start((value) => { level.value = value; }); notice.value = '正在录音，最长 10 秒'; } catch { error.value = '无法使用麦克风权限，请在浏览器设置中允许访问或导入音频。'; } }
  async function stopRecording() {
    try {
      resetAnalysis();
      draft.audio = await deps.recorder.stop();
      const info = await deps.cropper.inspect(draft.audio);
      draft.duration = info.duration; draft.cropStart = 0; draft.cropEnd = Math.min(10, info.duration);
      stage.value = 'crop'; notice.value = info.needsCrop ? '音频超过 10 秒，请选择保留片段' : '录音完成，可以试听并分析';
    } catch (cause) { error.value = cause instanceof Error ? cause.message : '录音结束失败'; }
  }
  async function importAudio(blob: Blob) {
    resetAnalysis();
    draft.audio = blob; const info = await deps.cropper.inspect(blob);
    draft.duration = info.duration; draft.cropStart = 0; draft.cropEnd = Math.min(10, info.duration);
    stage.value = 'crop';
  }
  async function analyze() {
    if (!draft.audio) { error.value = '请先录制或导入一段声音'; return; }
    // 每次分析都是新版本：上一次的警告与依据不残留。
    resetAnalysis();
    error.value = ''; notice.value = '';
    try {
      const cropped = await deps.cropper.crop(draft.audio, { start: draft.cropStart, end: draft.cropEnd });
      draft.audio = cropped.blob; draft.duration = cropped.duration;
      const result = await deps.analyzer.analyze(cropped.blob);
      features.value = result.features;
      assessment.value = result.assessment;
      if (result.assessment.valid) {
        const matched = classifyEmotion(result.features);
        autoEmotion.value = matched; emotion.value = matched; emotionSource.value = 'auto';
        cover.value = coverPresetFor(matched.label);
      } else {
        // 无有效声音：不产生自动建议，也不显示虚假百分比；用户仍可手动选标签。
        autoEmotion.value = undefined; emotion.value = undefined; emotionSource.value = undefined;
      }
      stage.value = 'emotion';
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : '声音分析失败，请重试或更换音频';
    }
  }
  function selectEmotion(label: EmotionLabel) {
    // 手动选择明确记录为人工来源，不携带自动百分比。
    emotion.value = { ...zeroResult(), label, explanation: `已手动选择「${label}」标签。` };
    emotionSource.value = 'manual';
    cover.value = { ...coverPresetFor(label), title: cover.value.title || label };
  }
  function goCover() { stage.value = 'cover'; }
  async function save(target?: HTMLCanvasElement) {
    if (!draft.audio || !emotion.value || !emotionSource.value) { error.value = '请先选择一个情绪标签后再保存'; return; }
    if (!features.value) { error.value = '作品信息尚未完整，请先完成声音分析'; return; }
    try {
      const coverBlob = await deps.renderer.render(cover.value, target);
      const summary: VoiceSummary | undefined = assessment.value?.valid ? {
        voicedDuration: assessment.value.voicedDuration,
        pauseCount: assessment.value.pauseCount,
        pauseDuration: assessment.value.pauseDuration,
        clipping: assessment.value.clipping,
      } : undefined;
      const meme: VoiceMeme = {
        id: draft.id ?? `meme-${Date.now()}`, title: draft.title.trim() || '未命名声音',
        emotion: emotion.value.label,
        confidence: emotionSource.value === 'auto' ? emotion.value.confidence : 0,
        emotionSource: emotionSource.value,
        voiceSummary: summary,
        features: features.value, audio: draft.audio, duration: draft.duration,
        cover: coverBlob, coverConfig: { ...cover.value }, createdAt: new Date().toISOString(),
      };
      await deps.repository.save(meme); await loadCollection(); stage.value = 'collection'; notice.value = '作品已保存到本地';
    } catch { error.value = '保存失败，本次编辑内容仍保留，请检查浏览器存储空间。'; }
  }
  async function loadCollection() { collection.value = (await deps.repository.list()).sort((a,b) => b.createdAt.localeCompare(a.createdAt)); }
  function editMeme(meme: VoiceMeme) {
    // 重新打开作品时仍能分清自动建议、人工选择；旧作品缺字段按人工选择对待。
    Object.assign(draft, { id: meme.id, title: meme.title, audio: meme.audio, duration: meme.duration, cropStart: 0, cropEnd: meme.duration });
    features.value = meme.features;
    const source: EmotionSource = meme.emotionSource ?? 'manual';
    emotionSource.value = source;
    emotion.value = {
      label: meme.emotion,
      confidence: source === 'auto' ? meme.confidence : 0,
      explanation: source === 'auto' ? '自动建议结果（来自保存时的声音分析）' : '人工选择的标签',
      scores: { '暴躁老哥': 0, '温柔姐姐': 0, '阴阳怪气': 0, '元气满满': 0 },
    };
    autoEmotion.value = source === 'auto' ? emotion.value : undefined;
    assessment.value = undefined; // 原始音频不再重算，旧警告不凭空恢复。
    cover.value = { ...meme.coverConfig }; stage.value = 'cover';
  }
  async function deleteMeme(id: string) { await deps.repository.delete(id); await loadCollection(); }
  async function shareMeme(meme: VoiceMeme) { const result = await deps.share.share(meme); notice.value = result === 'shared' ? '已打开系统分享' : '浏览器不支持文件分享，已下载音频和封面'; }
  function newRecording() {
    resetAnalysis();
    draft.id = undefined; draft.title = '我的声音表情'; draft.audio = undefined; draft.duration = 0;
    stage.value = 'record'; error.value = ''; notice.value = '';
  }
  return { stage, error, notice, level, draft, emotion, autoEmotion, emotionSource, features, assessment, analysisVersion, cover, collection, startRecording, stopRecording, importAudio, analyze, selectEmotion, goCover, save, loadCollection, editMeme, deleteMeme, shareMeme, newRecording };
}
