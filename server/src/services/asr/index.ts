import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import { assemblyAIProvider } from './assemblyai.js';
import { groqProvider } from './groq.js';
import type {
  AsrProvider,
  AsrTranscriptionOptions,
  AsrTranscriptionResult,
} from './types.js';

const providers: Record<'assemblyai' | 'groq', AsrProvider> = {
  assemblyai: assemblyAIProvider,
  groq: groqProvider,
};

export async function transcribeWithFallback(
  audioPath: string,
  opts: AsrTranscriptionOptions = {},
): Promise<AsrTranscriptionResult> {
  const preferredName = env.ASR_PROVIDER ?? 'assemblyai';
  const fallbackName = preferredName === 'assemblyai' ? 'groq' : 'assemblyai';

  try {
    logger.info(`Starting ASR with provider: ${preferredName}`);
    const result = await providers[preferredName].transcribe(audioPath, opts);
    logger.info(`ASR succeeded with provider: ${preferredName}`);
    return result;
  } catch (primaryError) {
    logger.error(
      `ASR provider ${preferredName} failed: ${
        primaryError instanceof Error ? primaryError.message : String(primaryError)
      }`,
    );

    try {
      logger.info(`Retrying ASR with fallback provider: ${fallbackName}`);
      const result = await providers[fallbackName].transcribe(audioPath, opts);
      logger.info(`ASR succeeded with fallback provider: ${fallbackName}`);
      return result;
    } catch (fallbackError) {
      logger.error(
        `Fallback ASR provider ${fallbackName} failed: ${
          fallbackError instanceof Error
            ? fallbackError.message
            : String(fallbackError)
        }`,
      );

      throw new AggregateError(
        [primaryError, fallbackError],
        `Both ASR providers failed (${preferredName}, ${fallbackName}).`,
      );
    }
  }
}