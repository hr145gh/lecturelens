/**
 * A word with timing, as both providers report it (after conversion to seconds).
 * All timestamps are FLOAT SECONDS rounded to 3 decimals — see CONTRACTS.md §1.3.
 */
export interface AsrWord {
  startSec: number;
  endSec: number;
  text: string;
  /** 0–1. */
  confidence: number;
  speaker?: string;
}

/**
 * A normalized transcript segment shared by all ASR providers: one utterance
 * (CONTRACTS.md §4.3), not one word. Timestamps are seconds, rounded to 3 decimals.
 */
export interface AsrSegment {
  startSec: number;
  endSec: number;
  text: string;
  confidence: number;
  speaker?: string;
}

/**
 * Options supported by ASR providers.
 */
export interface AsrTranscriptionOptions {
  /**
   * Technical terms, names, or other words that may improve recognition.
   */
  keyterms?: string[];
  /** Length of the audio, used to size the provider timeout. */
  durationSec?: number;
  /** For log lines (retries, fallbacks) — which lecture this transcription is for. */
  lectureId?: string;
}

export type AsrProviderName = 'assemblyai' | 'groq';

/**
 * Normalized response returned by an ASR provider.
 */
export interface AsrTranscriptionResult {
  segments: AsrSegment[];
  /** Stored on every segment, e.g. "assemblyai-universal-2" (CONTRACTS.md §4.3). */
  modelVersion: string;
  /** Which provider produced this result (for lecture.provider). */
  provider: AsrProviderName;
  /** Bare model id, e.g. "universal-2" (for lecture.provider.asrModel). */
  model: string;
  /** The provider's job/transcript id, when it has one (for lecture.provider.externalId). */
  externalId: string | null;
  rawResponse: unknown;
}

/**
 * Common contract implemented by AssemblyAI and Groq.
 */
export interface AsrProvider {
  transcribe(
    audioPath: string,
    opts: AsrTranscriptionOptions,
  ): Promise<AsrTranscriptionResult>;
}
