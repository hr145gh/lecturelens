import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import { assemblyAIProvider } from './assemblyai.js';
import { groqProvider } from './groq.js';
import type {
  AsrProvider,
  AsrProviderName,
  AsrTranscriptionOptions,
  AsrTranscriptionResult,
} from './types.js';

/**
 * Thrown when every provider failed. Each provider's own error is kept in `errors` (and logged),
 * so the pipeline can record a clear reason without losing the detail.
 */
export class AsrUnavailableError extends AggregateError {
  constructor(errors: unknown[], message: string) {
    super(errors, message);
    this.name = 'AsrUnavailableError';
  }
}

/** The registered providers. Mutable so tests can stand in a fake for one or both. */
export const asrProviders: Record<AsrProviderName, AsrProvider> = {
  assemblyai: assemblyAIProvider,
  groq: groqProvider,
};
const providers = asrProviders;

/** ASR_PROVIDER (default assemblyai) first, then the other one on any provider error. */
export async function transcribeWithFallback(
  audioPath: string,
  opts: AsrTranscriptionOptions = {},
): Promise<AsrTranscriptionResult> {
  const preferredName: AsrProviderName = env.ASR_PROVIDER ?? 'assemblyai';
  const fallbackName: AsrProviderName = preferredName === 'assemblyai' ? 'groq' : 'assemblyai';

  try {
    logger.info(`Starting ASR with provider: ${preferredName}`, { lectureId: opts.lectureId, glossaryTerms: opts.keyterms?.length ?? 0 });
    const result = await providers[preferredName].transcribe(audioPath, opts);
    logger.info(`ASR succeeded with provider: ${preferredName}`, { lectureId: opts.lectureId });
    return result;
  } catch (primaryError) {
    logger.error(
      `ASR provider ${preferredName} failed: ${
        primaryError instanceof Error ? primaryError.message : String(primaryError)
      }`,
    );

    try {
      logger.info(`Retrying ASR with fallback provider: ${fallbackName}`, { lectureId: opts.lectureId });
      const result = await providers[fallbackName].transcribe(audioPath, opts);
      logger.info(`ASR succeeded with fallback provider: ${fallbackName}`, { lectureId: opts.lectureId });
      return result;
    } catch (fallbackError) {
      logger.error(
        `Fallback ASR provider ${fallbackName} failed: ${
          fallbackError instanceof Error
            ? fallbackError.message
            : String(fallbackError)
        }`,
      );

      throw new AsrUnavailableError(
        [primaryError, fallbackError],
        `Both speech-recognition providers failed (${preferredName}, ${fallbackName}).`,
      );
    }
  }
}
