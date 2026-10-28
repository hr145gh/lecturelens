
import { readFile, mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import type {
  AsrProvider,
  AsrSegment,
  AsrTranscriptionOptions,
  AsrTranscriptionResult,
} from './types.js';

const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const CHUNK_DURATION_SEC = 8 * 60;
const CHUNK_OVERLAP_SEC = 1;

interface GroqWord {
  word?: string;
  text?: string;
  start: number;
  end: number;
  confidence?: number;
}

interface GroqResponse {
  text?: string;
  words?: GroqWord[];
  segments?: Array<{
    text: string;
    start: number;
    end: number;
    avg_logprob?: number;
  }>;
}

export interface TimedChunk {
  offsetSec: number;
  segments: AsrSegment[];
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { windowsHide: true });
    let stderr = '';

    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        reject(new Error('FFmpeg is required for large Groq uploads. Install it with: winget install Gyan.FFmpeg'));
      } else {
        reject(error);
      }
    });

    child.once('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        logger.error(`FFmpeg chunking stderr: ${stderr.trim()}`);
        reject(new Error(`FFmpeg chunking failed (exit ${code}): ${stderr.trim()}`));
      }
    });
  });
}

/**
 * Merge chunks whose timestamps have already been shifted to the full
 * recording timeline. Duplicate words in overlapping regions are removed.
 */
export function mergeOverlappingSegments(chunks: TimedChunk[]): AsrSegment[] {
  const candidates = chunks
    .flatMap((chunk) => chunk.segments)
    .sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec);

  const merged: AsrSegment[] = [];

  for (const candidate of candidates) {
    const normalized = candidate.text.trim().toLowerCase();

    const duplicateIndex = merged.findIndex((existing) => {
      const sameText = existing.text.trim().toLowerCase() === normalized;
      const startsClose = Math.abs(existing.startSec - candidate.startSec) <= 0.4;
      const endsClose = Math.abs(existing.endSec - candidate.endSec) <= 0.5;

      return sameText && startsClose && endsClose;
    });

    if (duplicateIndex === -1) {
      merged.push(candidate);
      continue;
    }

    // Keep the more confident version when an overlap produces a duplicate.
    if (
      candidate.confidence >
      merged[duplicateIndex].confidence
    ) {
      merged[duplicateIndex] = candidate;
    }
  }

  return merged.sort((a, b) => a.startSec - b.startSec);
}

function normalizeGroqResponse(
  response: GroqResponse,
  offsetSec: number,
): AsrSegment[] {
  const words = response.words ?? [];

  if (words.length > 0) {
    return words.map((word) => {
      const text = word.word ?? word.text ?? '';
      const startSec = Number((offsetSec + word.start).toFixed(3));
      const endSec = Number((offsetSec + word.end).toFixed(3));

      if (!text.trim() || endSec <= startSec) {
        throw new Error('Groq returned an invalid word timestamp.');
      }

      return {
        startSec,
        endSec,
        text: text.trim(),
        confidence: word.confidence ?? 0,
      };
    });
  }

  // Segment-level timestamps are a fallback if the API omits word results.
  return (response.segments ?? []).map((segment) => ({
    startSec: Number((offsetSec + segment.start).toFixed(3)),
    endSec: Number((offsetSec + segment.end).toFixed(3)),
    text: segment.text.trim(),
    confidence: 0,
  })).filter((segment) => segment.endSec > segment.startSec);
}

async function transcribeFile(
  audioPath: string,
  apiKey: string,
): Promise<GroqResponse> {
  const bytes = await readFile(audioPath);
  const form = new FormData();

  form.append(
    'file',
    new Blob([new Uint8Array(bytes)]),
    path.basename(audioPath),
  );
  form.append('model', 'whisper-large-v3-turbo');
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'segment');
  form.append('timestamp_granularities[]', 'word');

  const response = await fetch(GROQ_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Groq transcription failed (${response.status}): ${detail}`);
  }

  return await response.json() as GroqResponse;
}

async function splitAndTranscribe(
  audioPath: string,
  apiKey: string,
): Promise<AsrSegment[]> {
  const durationProbe = await new Promise<number>((resolve, reject) => {
    const child = spawn(
      'ffprobe',
      [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        audioPath,
      ],
      { windowsHide: true },
    );

    let output = '';
    let errorOutput = '';

    child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { errorOutput += data.toString(); });

    child.once('error', reject);
    child.once('close', (code) => {
      const duration = Number.parseFloat(output.trim());

      if (code !== 0 || !Number.isFinite(duration) || duration <= 0) {
        reject(new Error(`Unable to determine audio duration: ${errorOutput}`));
      } else {
        resolve(duration);
      }
    });
  });

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'lecturelens-groq-'));
  const chunks: TimedChunk[] = [];

  try {
    for (
      let offsetSec = 0, index = 0;
      offsetSec < durationProbe;
      offsetSec += CHUNK_DURATION_SEC - CHUNK_OVERLAP_SEC, index++
    ) {
      const chunkPath = path.join(tempDir, `chunk-${index}.wav`);
      const chunkDuration = Math.min(
        CHUNK_DURATION_SEC,
        durationProbe - offsetSec,
      );

      await runFfmpeg([
        '-hide_banner', '-y',
        '-ss', String(offsetSec),
        '-i', audioPath,
        '-t', String(chunkDuration),
        '-vn',
        '-ac', '1',
        '-ar', '16000',
        '-c:a', 'pcm_s16le',
        chunkPath,
      ]);

      const chunkSize = (await stat(chunkPath)).size;

      if (chunkSize >= MAX_UPLOAD_BYTES) {
        throw new Error(
          `Audio chunk exceeds Groq's 25 MB limit (${chunkSize} bytes).`,
        );
      }

      const response = await transcribeFile(chunkPath, apiKey);

      chunks.push({
        offsetSec,
        segments: normalizeGroqResponse(response, offsetSec),
      });
    }

    return mergeOverlappingSegments(chunks);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export class GroqProvider implements AsrProvider {
  async transcribe(
    audioPath: string,
    _opts: AsrTranscriptionOptions = {},
  ): Promise<AsrTranscriptionResult> {
    const apiKey = env.GROQ_API_KEY;

    if (!apiKey) {
      throw new Error('GROQ_API_KEY is not configured.');
    }

    const fileSize = (await stat(audioPath)).size;

    if (fileSize >= MAX_UPLOAD_BYTES) {
      const segments = await splitAndTranscribe(audioPath, apiKey);

      logger.info(`ASR completed with Groq; ${segments.length} merged segments.`);

      return {
        segments,
        modelVersion: 'whisper-large-v3-turbo',
        rawResponse: { chunked: true, segments },
      };
    }

    const response = await transcribeFile(audioPath, apiKey);
    const segments = normalizeGroqResponse(response, 0);

    logger.info(`ASR completed with Groq; ${segments.length} segments.`);

    return {
      segments,
      modelVersion: 'whisper-large-v3-turbo',
      rawResponse: response,
    };
  }
}

export const groqProvider = new GroqProvider();
