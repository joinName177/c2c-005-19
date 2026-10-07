import type { AudioFeatures } from '../core/models';
import type { VoiceAssessment } from '../core/voice-detector';
export interface AudioAnalysis {
  features: AudioFeatures;
  duration: number;
  assessment: VoiceAssessment;
}
export interface AudioAnalyzerPort { analyze(blob: Blob): Promise<AudioAnalysis> }
