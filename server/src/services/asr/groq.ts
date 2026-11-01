import { readFile, mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import { ffmpegInstallHint, probeDuration } from '../media/extract.js';
import { ProviderHttpError, retryAfterSeconds, withRetry } from './retry.js';
import { groupWordsIntoSegments } from './segments.js';
import type {
  AsrProvider,
  AsrTranscriptionOptions,
  AsrTranscriptionResult,
  AsrWord,
} from './types.js';

const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const MODEL = 'whisper-large-v3-turbo';
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
/** 8 min of 16 kHz mono 16-bit PCM ≈ 15.4 MB — safely under Groq's 25 MB cap. */
const CHUNK_DURATION_SEC = 8 * 60;
const CHUNK_OVERLAP_SEC = 1;
const REQUEST_TIMEOUT_MS = 5 * 60 * 1_000;

interface GroqWord {
  word?: string;
  text?: string;
  start: number;
  end: number;
}

interface GroqSegment {
  text: string;
  start: number;
  end: number;
  avg_logprob?: number;
}

interface GroqResponse {
  text?: string;
  words?: GroqWord[];
  segments?: GroqSegment[];
}

/** One chunk's words, already shifted onto the full recording's timeline. */
export interface TimedChunk {
  offsetSec: number;
  durationSec: number;
  words: AsrWord[];
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { windowsHide: true });
    let stderr = '';

    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        reject(new Error(`FFmpeg is required to split long audio for Groq. Install it with: ${ffmpegInstallHint()}`));
      } else {
        reject(error);
      }
    });

    child.once('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        logger.error(`FFmpeg chunking stderr: ${stderr.trim()}`);
        reject(new Error(`FFmpeg chunking failed (exit ${code}).`));
      }
    });
  });
}

/**
 * Merges overlapping chunks into one word list. Neighbouring chunks share an overlap
 * [next.offset, previous.end]; each keeps only the words that START on its side of the
 * overlap's midpoint. So a word recognised by both chunks appears exactly once, a word cut in
 * half at a chunk edge is taken from the chunk that heard it whole, and timestamps stay
 * monotonic across the join. Linear in the number of words.
 */
export function mergeOverlappingChunks(chunks: readonly TimedChunk[]): AsrWord[] {
  const ordered = [...chunks].sort((a, b) => a.offsetSec - b.offsetSec);
  const merged: AsrWord[] = [];

  ordered.forEach((chunk, i) => {
    const prev = ordered[i - 1];
    const next = ordered[i + 1];
    const from = prev ? (chunk.offsetSec + prev.offsetSec + prev.durationSec) / 2 : -Infinity;
    const to = next ? (next.offsetSec + chunk.offsetSec + chunk.durationSec) / 2 : Infinity;
    for (const word of chunk.words) {
      if (word.startSec < from || word.startSec >= to) continue;
      const last = merged[merged.length - 1];
      if (last && word.startSec < last.startSec) continue; // never step backwards in time
      merged.push(word);
    }
  });

  return merged;
}

/**
 * Whisper reports no per-word confidence; each word takes the probability of the segment it
 * falls in: exp(avg_logprob), clamped to 0–1.
 */
function segmentConfidence(segment: GroqSegment | undefined): number {
  if (!segment || typeof segment.avg_logprob !== 'number') return 0;
  return round3(Math.min(1, Math.max(0, Math.exp(segment.avg_logprob))));
}

/** Groq verbose_json → word timings on the full timeline (offset added to every timestamp). */
export function normalizeGroqWords(response: GroqResponse, offsetSec: number): AsrWord[] {
  const segments = response.segments ?? [];
  const words = response.words ?? [];

  if (words.length > 0) {
    return words.flatMap((word) => {
      const text = (word.word ?? word.text ?? '').trim();
      const startSec = round3(offsetSec + word.start);
      const endSec = round3(offsetSec + word.end);
      if (!text || endSec <= startSec) return []; // Whisper emits the odd zero-length token
      const home = segments.find((s) => word.start >= s.start && word.start < s.end) ?? segments.find((s) => word.start <= s.end);
      return [{ startSec, endSec, text, confidence: segmentConfidence(home) }];
    });
  }

  // Segment-level timestamps only: treat each segment as one "word" so grouping still works.
  return segments
    .map((segment) => ({
      startSec: round3(offsetSec + segment.start),
      endSec: round3(offsetSec + segment.end),
      text: segment.text.trim(),
      confidence: segmentConfidence(segment),
    }))
    .filter((w) => w.text && w.endSec > w.startSec);
}

async function transcribeFile(
  audioPath: string,
  apiKey: string,
  opts: AsrTranscriptionOptions,
  operation = 'transcribe',
): Promise<GroqResponse> {
  const bytes = await readFile(audioPath);
  const keyterms = opts.keyterms?.map((t) => t.trim()).filter(Boolean);

  // 429 / 5xx are retried with backoff (retry.ts); other 4xx fail at once.
  return withRetry(
    async () => {
      const form = new FormData(); // fresh body for every attempt
      form.append('file', new Blob([new Uint8Array(bytes)]), path.basename(audioPath));
      form.append('model', MODEL);
      form.append('response_format', 'verbose_json');
      form.append('timestamp_granularities[]', 'segment');
      form.append('timestamp_granularities[]', 'word');
      // Whisper's prompt biases spelling of the listed terms (it has no dedicated keyterms field).
      if (keyterms?.length) form.append('prompt', keyterms.join(', ').slice(0, 800));

      const response = await fetch(GROQ_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        const detail = (await response.text()).slice(0, 500);
        throw new ProviderHttpError('groq', response.status, detail, retryAfterSeconds(response.headers));
      }
      return (await response.json()) as GroqResponse;
    },
    { provider: 'groq', operation, lectureId: opts.lectureId },
  );
}

async function splitAndTranscribe(
  audioPath: string,
  apiKey: string,
  opts: AsrTranscriptionOptions,
): Promise<{ words: AsrWord[]; responses: Array<{ offsetSec: number; response: GroqResponse }> }> {
  const totalSec = opts.durationSec ?? (await probeDuration(audioPath));
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'lecturelens-groq-'));
  const chunks: TimedChunk[] = [];
  const responses: Array<{ offsetSec: number; response: GroqResponse }> = [];

  try {
    for (
      let offsetSec = 0, index = 0;
      offsetSec < totalSec;
      offsetSec += CHUNK_DURATION_SEC - CHUNK_OVERLAP_SEC, index++
    ) {
      const chunkPath = path.join(tempDir, `chunk-${index}.wav`);
      const durationSec = Math.min(CHUNK_DURATION_SEC, totalSec - offsetSec);

      await runFfmpeg([
        '-hide_banner', '-y',
        '-ss', String(offsetSec),
        '-i', audioPath,
        '-t', String(durationSec),
        '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
        chunkPath,
      ]);

      const chunkSize = (await stat(chunkPath)).size;
      if (chunkSize >= MAX_UPLOAD_BYTES) {
        throw new Error(`Audio chunk exceeds Groq's 25 MB limit (${chunkSize} bytes).`);
      }

      const response = await transcribeFile(chunkPath, apiKey, opts, `transcribe chunk ${index}`);
      responses.push({ offsetSec, response });
      chunks.push({ offsetSec, durationSec, words: normalizeGroqWords(response, offsetSec) });
      if (offsetSec + durationSec >= totalSec) break;
    }

    return { words: mergeOverlappingChunks(chunks), responses };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export class GroqProvider implements AsrProvider {
  async transcribe(
    audioPath: string,
    opts: AsrTranscriptionOptions = {},
  ): Promise<AsrTranscriptionResult> {
    const apiKey = env.GROQ_API_KEY;

    if (!apiKey) {
      throw new Error('GROQ_API_KEY is not configured.');
    }

    const fileSize = (await stat(audioPath)).size;
    const chunked = fileSize >= MAX_UPLOAD_BYTES;

    const { words, rawResponse } = chunked
      ? await splitAndTranscribe(audioPath, apiKey, opts).then(({ words, responses }) => ({
          words,
          rawResponse: { chunked: true, chunkSec: CHUNK_DURATION_SEC, overlapSec: CHUNK_OVERLAP_SEC, chunks: responses },
        }))
      : await transcribeFile(audioPath, apiKey, opts).then((response) => ({
          words: normalizeGroqWords(response, 0),
          rawResponse: response,
        }));

    const segments = groupWordsIntoSegments(words);
    logger.info(`ASR completed with Groq${chunked ? ' (chunked)' : ''}; ${words.length} words in ${segments.length} segments.`);

    return {
      segments,
      modelVersion: `groq-${MODEL}`,
      provider: 'groq',
      model: MODEL,
      externalId: null,
      rawResponse,
    };
  }
}

export const groqProvider = new GroqProvider();
