<script setup lang="ts">
import type { EmotionLabel, EmotionResult, EmotionSource, VoiceActivityAssessment } from '../../core/models';
import { INVALID_REASON_COPY } from '../../core/voice-activity';
defineProps<{ result?: EmotionResult; assessment?: VoiceActivityAssessment; source?: EmotionSource }>();
const emit = defineEmits<{ select: [e: EmotionLabel]; next: [] }>();
const labels: EmotionLabel[] = ['暴躁老哥', '温柔姐姐', '阴阳怪气', '元气满满'];
const seconds = (value: number) => `${value.toFixed(1)} 秒`;
</script>
<template>
  <section class="stage-card">
    <span class="kicker">03 / MOOD MATCH</span>
    <h2>这段声音，有点像——</h2>

    <div v-if="assessment" class="voice-evidence" data-testid="voice-evidence">
      <header>
        <b :class="assessment.hasVoice ? 'ok' : 'bad'">{{ assessment.hasVoice ? '✓ 检测到有效人声' : '⚠ 无法可靠分析情绪' }}</b>
        <span>判定依据：自适应门槛 {{ assessment.evidence.thresholdDb.toFixed(0) }} dBFS（噪底 {{ assessment.evidence.noiseFloorDb.toFixed(0) }} dBFS，动态对比 {{ assessment.evidence.contrastDb.toFixed(1) }} dB）</span>
      </header>
      <ul>
        <li>片段总时长 <b>{{ seconds(assessment.duration) }}</b></li>
        <li>有效讲话 <b>{{ seconds(assessment.voicedDuration) }}</b>（{{ (assessment.voicedRatio * 100).toFixed(0) }}%）</li>
        <li>停顿 <b>{{ assessment.pauseCount }} 次</b>，共 {{ seconds(assessment.pauseDuration) }}</li>
      </ul>
    </div>

    <!-- 无有效人声且用户尚未手选：只给原因，不展示任何自动百分比 -->
    <div v-if="assessment && !assessment.hasVoice && source !== 'manual'" class="emotion-warning" data-testid="no-voice-warning">
      <p v-for="reason in assessment.reasons" :key="reason">· {{ INVALID_REASON_COPY[reason] }}</p>
      <p class="hint">不提供自动情绪百分比。你仍可明确选择下面任一标签，作为<strong>人工来源</strong>继续制作并保存。</p>
    </div>

    <template v-else>
      <div v-if="source === 'auto' && result" class="emotion-hero" data-testid="emotion-hero">
        <b>{{ result.label }}</b><strong>{{ Math.round(result.confidence * 100) }}%</strong>
        <p>{{ result.explanation }}</p><span class="source-tag">自动建议 · 可改选</span>
      </div>
      <div v-else-if="source === 'manual' && result" class="emotion-hero manual" data-testid="emotion-hero">
        <b>{{ result.label }}</b><strong>手动</strong>
        <p>{{ result.explanation }}</p><span class="source-tag">人工选择 · 非自动分析</span>
      </div>
      <div v-if="assessment && !assessment.hasVoice && source === 'manual'" class="emotion-warning manual-notice">
        <p>该标签为人工选择：原始声音未取得可靠的自动分析结论。</p>
      </div>
    </template>

    <div class="emotion-options">
      <button v-for="label in labels" :key="label" type="button" :data-emotion="label" :class="{ active: result?.label === label }" @click="emit('select', label)">{{ label }}</button>
    </div>
    <button data-testid="to-cover" class="acid-button" type="button" :disabled="!result" @click="emit('next')">用这个情绪做封面 →</button>
  </section>
</template>
