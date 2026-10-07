import type { AudioFeatures, VoiceActivityAssessment } from '../core/models';
export interface AudioAnalysis { features: AudioFeatures; voice: VoiceActivityAssessment; duration: number }
export interface AudioAnalyzerPort { analyze(blob: Blob): Promise<AudioAnalysis> }
