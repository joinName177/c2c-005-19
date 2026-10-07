<script setup lang="ts">
import { computed } from 'vue';
import type { EmotionLabel, EmotionResult, EmotionSource } from '../../core/models';
import type { VoiceAssessment } from '../../core/voice-detector';

const props = defineProps<{
  result?: EmotionResult;
  source?: EmotionSource;
  assessment?: VoiceAssessment;
}>();
const emit = defineEmits<{ select: [e: EmotionLabel]; next: []; retake: []; retry: [] }>();
const labels: EmotionLabel[] = ['暴躁老哥', '温柔姐姐', '阴阳怪气', '元气满满'];

const formattedDuration = computed(() => `${props.assessment?.voicedDuration.toFixed(1) ?? '0.0'} 秒`);
const pauseText = computed(() => {
  const assessment = props.assessment;
  if (!assessment || !assessment.valid) return '—';
  if (assessment.pauseCount === 0) return '无明显停顿';
  return `${assessment.pauseCount} 次（共 ${assessment.pauseDuration.toFixed(1)} 秒）`;
});
</script>
<template>
  <section class="stage-card">
    <span class="kicker">03 / MOOD MATCH</span>
    <h2>这段声音，有点像——</h2>

    <div v-if="assessment" class="voice-report" data-testid="voice-report">
      <div class="voice-stats">
        <span>有效时长 <b data-testid="voiced-duration">{{ formattedDuration }}</b></span>
        <span>停顿 <b data-testid="pause-info">{{ pauseText }}</b></span>
        <span v-if="assessment.clipping" class="voice-warn-inline" data-testid="clipping-warn">⚠ 疑似爆音，建议靠近麦克风、降低音量重录</span>
      </div>
    </div>

    <!-- 无有效声音：不显示虚假自动百分比，给出无法可靠分析的原因 -->
    <div v-if="assessment && !assessment.valid" class="emotion-invalid" data-testid="no-valid-voice">
      <b>无法可靠分析情绪</b>
      <p data-testid="invalid-reason">{{ assessment.reasonText }}</p>
      <p class="recover-hint">你仍然可以在下面明确选择一个标签继续制作，保存时会标记为人工选择；或者重录一段再试。</p>
      <div class="invalid-actions">
        <button type="button" data-testid="retake" class="ghost-button" @click="emit('retake')">↺ 重录一段</button>
        <button type="button" data-testid="retry-analyze" class="ghost-button" @click="emit('retry')">↻ 用当前裁剪重新分析</button>
      </div>
    </div>

    <!-- 自动建议 -->
    <div v-else-if="source === 'auto' && result" class="emotion-hero" data-testid="emotion-auto">
      <span class="source-badge source-auto">自动建议</span>
      <b>{{ result.label }}</b>
      <strong data-testid="auto-confidence">{{ Math.round(result.confidence * 100) }}%</strong>
      <p>{{ result.explanation }}</p>
    </div>

    <!-- 人工选择：不显示百分比 -->
    <div v-else-if="source === 'manual' && result" class="emotion-hero emotion-manual" data-testid="emotion-manual">
      <span class="source-badge source-manual">人工选择</span>
      <b>{{ result.label }}</b>
      <p>{{ result.explanation }}</p>
    </div>

    <p class="pick-hint">{{ assessment?.valid ? '觉得不准？可以手动改选：' : '手动选择标签：' }}</p>
    <div class="emotion-options">
      <button
        v-for="label in labels"
        :key="label"
        type="button"
        :data-emotion="label"
        :class="{ active: result?.label === label }"
        @click="emit('select', label)"
      >{{ label }}</button>
    </div>
    <button
      data-testid="to-cover"
      class="acid-button"
      type="button"
      :disabled="!result"
      @click="result && emit('next')"
    >用这个情绪做封面 →</button>
  </section>
</template>
