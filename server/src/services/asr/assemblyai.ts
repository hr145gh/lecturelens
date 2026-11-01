import { AssemblyAI } from 'assemblyai';
import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import { ProviderHttpError, retryAfterSeconds, withRetry } from './retry.js';
import { groupWordsIntoSegments } from './segments.js';
import type {
  AsrProvider,
  AsrTranscriptionOptions,
  AsrTranscriptionResult,
  AsrWord,
} from './types.js';
import { millisecondsToSeconds } from './time.js';

const POLLING_INTERVAL_MS = 2_000;
/** At least 10 minutes, or the audio's own length if longer (universal-2 is much faster than real time). */
const MIN_POLLING_TIMEOUT_MS = 10 * 60 * 1_000;
export const pollingTimeoutMs = (durationSec?: number) =>
  Math.max(MIN_POLLING_TIMEOUT_MS, Math.ceil((durationSec ?? 0) * 1_000));

type AssemblyWord = {
  text: string;
  start: number;
  end: number;
  confidence?: number | null;
  speaker?: string | null;
};

type AssemblyTranscript = {
  id: string;
  status: string;
  error?: string;
  words?: AssemblyWord[] | null;
  confidence?: number | null;
  speech_model_used?: string | null;
  speech_models?: string[] | null;
};

/**
 * The SDK turns every HTTP error into a plain Error with only the response text, so a 429 cannot
 * be told from a 400. Its services route all calls through their (protected, declared) `fetch`,
 * built on `fetchResponse`; this wraps `fetch` so failures carry the real status instead.
 * test/asr-retry.test.ts drives the real SDK through this and fails if a new SDK version changes it.
 */
export function withHttpStatusErrors(client: AssemblyAI): AssemblyAI {
  type Service = {
    fetch(input: string, init?: RequestInit): Promise<Response>;
    fetchResponse(input: string, init?: RequestInit): Promise<Response>;
  };
  for (const service of [client.files, client.transcripts] as unknown as Array<Service | undefined>) {
    if (!service || typeof service.fetchResponse !== 'function') continue;
    const fetchResponse = service.fetchResponse.bind(service);
    service.fetch = async (input, init) => {
      const response = await fetchResponse(input, init);
      if (response.status >= 400) {
        const text = await response.text();
        let detail = text.slice(0, 300);
        try {
          detail = (JSON.parse(text) as { error?: string }).error ?? detail;
        } catch {
          /* not JSON */
        }
        throw new ProviderHttpError('assemblyai', response.status, detail, retryAfterSeconds(response.headers));
      }
      return response;
    };
  }
  return client;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Converts AssemblyAI word-level output to LectureLens word timings.
 * AssemblyAI timestamps are milliseconds; LectureLens uses seconds (3 decimals).
 */
export function mapAssemblyWords(
  words: AssemblyWord[],
  transcriptConfidence?: number | null,
): AsrWord[] {
  return words.map((word) => {
    const startSec = millisecondsToSeconds(word.start);
    const endSec = millisecondsToSeconds(word.end);

    if (endSec <= startSec) {
      throw new Error(
        `AssemblyAI returned an invalid word interval: ${startSec}–${endSec} seconds.`,
      );
    }

    return {
      startSec,
      endSec,
      text: word.text,
      confidence: word.confidence ?? transcriptConfidence ?? 0,
      ...(word.speaker ? { speaker: word.speaker } : {}),
    };
  });
}

export class AssemblyAIProvider implements AsrProvider {
  async transcribe(
    audioPath: string,
    opts: AsrTranscriptionOptions = {},
  ): Promise<AsrTranscriptionResult> {
    const apiKey = env.ASSEMBLYAI_API_KEY;

    if (!apiKey) {
      throw new Error('ASSEMBLYAI_API_KEY is not configured.');
    }

    const client = withHttpStatusErrors(new AssemblyAI({ apiKey }));
    const retryCtx = { provider: 'assemblyai' as const, lectureId: opts.lectureId };

    const keyterms = opts.keyterms
      ?.map((term) => term.trim())
      .filter(Boolean);

    // universal-2 supports word_boost for custom vocabulary.
    // keyterms_prompt is intended for other model families.
    const submitted = await withRetry(
      () =>
        client.transcripts.submit({
          audio: audioPath,
          speech_models: ['universal-2'],
          speaker_labels: true,
          ...(keyterms?.length ? { word_boost: keyterms } : {}),
        }),
      { ...retryCtx, operation: 'upload and submit' },
    );

    if (!submitted.id) {
      throw new Error('AssemblyAI did not return a transcript ID.');
    }

    const timeoutMs = pollingTimeoutMs(opts.durationSec);
    const deadline = Date.now() + timeoutMs;
    let transcript = submitted as AssemblyTranscript;

    while (
      transcript.status !== 'completed' &&
      transcript.status !== 'error'
    ) {
      if (Date.now() >= deadline) {
        throw new Error(
          `AssemblyAI transcription ${submitted.id} timed out after ${timeoutMs / 1000} seconds.`,
        );
      }

      await delay(POLLING_INTERVAL_MS);

      if (Date.now() >= deadline) {
        throw new Error(
          `AssemblyAI transcription ${submitted.id} timed out after ${timeoutMs / 1000} seconds.`,
        );
      }

      transcript = (await withRetry(() => client.transcripts.get(submitted.id), {
        ...retryCtx,
        operation: `poll ${submitted.id}`,
      })) as AssemblyTranscript;
    }

    if (transcript.status === 'error') {
      throw new Error(
        `AssemblyAI transcription failed: ${transcript.error ?? 'Unknown provider error'}`,
      );
    }

    const words = transcript.words ?? [];

    if (words.length === 0) {
      throw new Error(
        'AssemblyAI completed transcription without returning word-level timestamps.',
      );
    }

    const segments = groupWordsIntoSegments(mapAssemblyWords(words, transcript.confidence));
    const model = transcript.speech_model_used ?? 'universal-2';

    logger.info(
      `ASR completed with AssemblyAI (${model}); ${words.length} words in ${segments.length} segments.`,
      { externalId: transcript.id },
    );

    return {
      segments,
      modelVersion: `assemblyai-${model}`,
      provider: 'assemblyai',
      model,
      externalId: transcript.id,
      rawResponse: transcript,
    };
  }
}

export const assemblyAIProvider = new AssemblyAIProvider();
