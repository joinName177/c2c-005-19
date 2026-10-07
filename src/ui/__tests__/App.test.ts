import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import App from '../App.vue';
import type { StudioDependencies } from '../useStudio';
import type { VoiceMeme } from '../../core/models';
import type { VoiceAssessment } from '../../core/voice-detector';

const validFeatures = { loudness:.75,dynamics:.55,pitch:.8,zeroCrossing:.62,pauseRatio:.12,tempoVariation:.6 };
const validAssessment: VoiceAssessment = {
  valid: true, duration: 2, voicedDuration: 1.6, voicedRatio: .8, pauseCount: 1, pauseDuration: .2,
  pauses: [{ start: .8, end: 1 }], clipping: false, floorDb: -80, gateDb: -60, frames: [], segments: [],
};
const silenceAssessment: VoiceAssessment = {
  valid: false, reason: 'silence', reasonText: '全程接近静音，没有可用声音。',
  duration: 2, voicedDuration: 0, voicedRatio: 0, pauseCount: 0, pauseDuration: 0, pauses: [],
  clipping: false, floorDb: -85, gateDb: -76, frames: [], segments: [],
};

function deps(options: { denied?: boolean; silent?: boolean } = {}): StudioDependencies {
  const works: VoiceMeme[] = [];
  return {
    recorder:{isRecording:false,start:async()=>{if(options.denied)throw new DOMException('denied','NotAllowedError')},stop:async()=>new Blob(['voice'],{type:'audio/webm'})},
    analyzer:{analyze:async()=>({duration:2,features:validFeatures,assessment:options.silent?silenceAssessment:validAssessment})},
    cropper:{inspect:async()=>({duration:2,needsCrop:false}),crop:async(blob,range)=>({blob,duration:range.end-range.start})},
    renderer:{render:async()=>new Blob(['cover'],{type:'image/png'})},
    repository:{list:async()=>works,save:async(m)=>{works.push(m)},rename:async()=>{},delete:async(id)=>{const i=works.findIndex(w=>w.id===id);if(i>=0)works.splice(i,1)}},
    share:{share:async()=> 'shared'},
  };
}

describe('Voice meme App', () => {
  it('shows the studio stages, time limit and sharing disclosure', () => {
    const wrapper = mount(App,{props:{dependencies:deps()}});
    expect(wrapper.text()).toContain('声音表情包工坊');
    expect(wrapper.text()).toContain('00:10 MAX');
    expect(wrapper.text()).toContain('分享链接不包含原始声音');
  });
  it('shows a recoverable microphone permission error', async () => {
    const wrapper=mount(App,{props:{dependencies:deps({denied:true})}}); await wrapper.get('[data-testid="record"]').trigger('click'); await Promise.resolve();
    expect(wrapper.text()).toContain('麦克风权限');
  });
  it('creates, labels, edits and saves a work to the gallery', async () => {
    const wrapper=mount(App,{props:{dependencies:deps()}}); await wrapper.get('[data-testid="record"]').trigger('click'); await wrapper.get('[data-testid="stop"]').trigger('click'); await Promise.resolve();
    await wrapper.get('[data-testid="analyze"]').trigger('click'); await Promise.resolve();
    expect(wrapper.get('[data-testid="auto-confidence"]').text()).toMatch(/%/);
    await wrapper.get('[data-emotion="温柔姐姐"]').trigger('click'); expect(wrapper.text()).toContain('已手动选择');
    expect(wrapper.text()).toContain('人工选择');
    await wrapper.get('[data-testid="to-cover"]').trigger('click'); await wrapper.get('[aria-label="气泡文字"]').setValue('轻轻说一句'); await wrapper.get('[data-testid="save-work"]').trigger('click'); await Promise.resolve(); await Promise.resolve();
    expect(wrapper.text()).toContain('作品集'); expect(wrapper.text()).toContain('我的声音表情');
    expect(wrapper.get('[data-source="manual"]').text()).toContain('人工选择');
  });
  it('shows why silence cannot be analysed, hides fake percentage, and still allows manual labeling', async () => {
    const wrapper=mount(App,{props:{dependencies:deps({silent:true})}});
    await wrapper.get('[data-testid="record"]').trigger('click'); await wrapper.get('[data-testid="stop"]').trigger('click'); await Promise.resolve();
    await wrapper.get('[data-testid="analyze"]').trigger('click'); await Promise.resolve();
    expect(wrapper.get('[data-testid="no-valid-voice"]').text()).toContain('无法可靠分析情绪');
    expect(wrapper.get('[data-testid="invalid-reason"]').text()).toContain('静音');
    expect(wrapper.text()).not.toContain('%');
    expect(wrapper.text()).toContain('有效时长');
    expect(wrapper.text()).toContain('0.0 秒');
    expect(wrapper.find('[data-testid="auto-confidence"]').exists()).toBe(false);
    // 仍可明确选标签继续制作
    await wrapper.get('[data-emotion="元气满满"]').trigger('click');
    expect(wrapper.text()).toContain('人工选择');
    await wrapper.get('[data-testid="to-cover"]').trigger('click');
    await wrapper.get('[data-testid="save-work"]').trigger('click'); await Promise.resolve(); await Promise.resolve();
    expect(wrapper.get('[data-source="manual"]').text()).toContain('人工选择');
  });
});
