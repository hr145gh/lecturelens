
import { AssemblyAI } from 'assemblyai';
import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import type {
  AsrProvider,
  AsrSegment,
  AsrTranscriptionOptions,
  AsrTranscriptionResult,
} from './types.js';
import { millisecondsToSeconds } from './time.js';

const POLLING_INTERVAL_MS = 2_000;
const POLLING_TIMEOUT_MS = 5 * 60 * 1_000;

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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Converts AssemblyAI word-level output to LectureLens segments.
 * AssemblyAI timestamps are milliseconds; LectureLens uses seconds.
 */
export function mapAssemblyWords(
  words: AssemblyWord[],
  transcriptConfidence?: number | null,
): AsrSegment[] {
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

    const client = new AssemblyAI({ apiKey });

    const keyterms = opts.keyterms
      ?.map((term) => term.trim())
      .filter(Boolean);

    // universal-2 supports word_boost for custom vocabulary.
    // keyterms_prompt is intended for other model families.
    const submitted = await client.transcripts.submit({
      audio: audioPath,
      speech_models: ['universal-2'],
      speaker_labels: true,
      ...(keyterms?.length ? { word_boost: keyterms } : {}),
    });

    if (!submitted.id) {
      throw new Error('AssemblyAI did not return a transcript ID.');
    }

    const deadline = Date.now() + POLLING_TIMEOUT_MS;
    let transcript = submitted as AssemblyTranscript;

    while (
      transcript.status !== 'completed' &&
      transcript.status !== 'error'
    ) {
      if (Date.now() >= deadline) {
        throw new Error(
          `AssemblyAI transcription timed out after ${POLLING_TIMEOUT_MS / 1000} seconds.`,
        );
      }

      await delay(POLLING_INTERVAL_MS);

      if (Date.now() >= deadline) {
        throw new Error(
          `AssemblyAI transcription timed out after ${POLLING_TIMEOUT_MS / 1000} seconds.`,
        );
      }

      transcript = (await client.transcripts.get(
        submitted.id,
      )) as AssemblyTranscript;
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

    const segments = mapAssemblyWords(words, transcript.confidence);

    logger.info(
      `ASR completed with AssemblyAI (${transcript.speech_model_used ?? 'universal-2'}); ${segments.length} word segments.`,
    );

    return {
      segments,
      modelVersion: transcript.speech_model_used ?? 'universal-2',
      rawResponse: transcript,
    };
  }
}

export const assemblyAIProvider = new AssemblyAIProvider();
