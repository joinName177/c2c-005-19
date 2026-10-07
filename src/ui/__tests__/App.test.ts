import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import App from '../App.vue';
import type { StudioDependencies } from '../useStudio';
import type { InvalidVoiceReason, VoiceMeme } from '../../core/models';

function deps(options: { denied?: boolean } = {}): StudioDependencies {
  const works: VoiceMeme[] = [];
  const voice = { hasVoice:true,duration:2,voicedDuration:1.6,voicedRatio:.8,pauseCount:1,pauseDuration:.2,reasons:[] as InvalidVoiceReason[],evidence:{frameCount:200,activeFrameCount:160,thresholdDb:-45,noiseFloorDb:-55,contrastDb:20,voicedFrameZcr:.08} };
  return {
    recorder:{isRecording:false,start:async()=>{if(options.denied)throw new DOMException('denied','NotAllowedError')},stop:async()=>new Blob(['voice'],{type:'audio/webm'})},
    analyzer:{analyze:async()=>({duration:2,voice,features:{loudness:.75,dynamics:.55,pitch:.8,zeroCrossing:.62,pauseRatio:.12,tempoVariation:.6}})},
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
    await wrapper.get('[data-testid="analyze"]').trigger('click'); await Promise.resolve(); await wrapper.get('[data-emotion="温柔姐姐"]').trigger('click'); expect(wrapper.text()).toContain('已手动选择');
    await wrapper.get('[data-testid="to-cover"]').trigger('click'); await wrapper.get('[aria-label="气泡文字"]').setValue('轻轻说一句'); await wrapper.get('[data-testid="save-work"]').trigger('click'); await Promise.resolve(); await Promise.resolve();
    expect(wrapper.text()).toContain('作品集'); expect(wrapper.text()).toContain('我的声音表情');
  });
  it('shows no fake auto percentage for silent audio and still saves a manual label', async () => {
    const silent = { hasVoice:false,duration:2,voicedDuration:0,voicedRatio:0,pauseCount:0,pauseDuration:0,reasons:['all-silence'] as InvalidVoiceReason[],evidence:{frameCount:200,activeFrameCount:0,thresholdDb:-60,noiseFloorDb:-120,contrastDb:0,voicedFrameZcr:0} };
    const d = deps(); (d.analyzer as { analyze: () => Promise<unknown> }).analyze = async () => ({ duration: 2, voice: silent, features: { loudness:0,dynamics:0,pitch:0,zeroCrossing:0,pauseRatio:1,tempoVariation:0 } });
    const wrapper = mount(App, { props: { dependencies: d } });
    await wrapper.get('[data-testid="record"]').trigger('click'); await wrapper.get('[data-testid="stop"]').trigger('click'); await Promise.resolve();
    await wrapper.get('[data-testid="analyze"]').trigger('click'); await Promise.resolve();
    expect(wrapper.text()).toContain('无法可靠分析情绪');
    expect(wrapper.text()).toContain('有效讲话');
    expect(wrapper.find('[data-testid="emotion-hero"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="no-voice-warning"]').exists()).toBe(true);
    await wrapper.get('[data-emotion="温柔姐姐"]').trigger('click'); await Promise.resolve();
    expect(wrapper.text()).toContain('人工选择');
    await wrapper.get('[data-testid="to-cover"]').trigger('click'); await wrapper.get('[data-testid="save-work"]').trigger('click'); await Promise.resolve(); await Promise.resolve();
    expect(wrapper.text()).toContain('人工选择');
    expect(wrapper.text()).not.toContain('自动建议');
  });
});
