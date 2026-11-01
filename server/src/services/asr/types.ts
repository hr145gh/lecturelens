
/**
 * A normalized transcript segment shared by all ASR providers.
 * All timestamps are seconds, rounded to three decimal places.
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
}

/**
 * Normalized response returned by an ASR provider.
 */
export interface AsrTranscriptionResult {
  segments: AsrSegment[];
  modelVersion: string;
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
