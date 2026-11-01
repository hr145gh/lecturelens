export interface TranscriptSegmentInput {
  lectureId?: string | { toString(): string };
  index: number;
  startSec: number;
  endSec: number;
  text: string;
}

export interface ChunkOutput {
  lectureId: string;
  index: number;
  startSec: number;
  endSec: number;
  text: string;
  segmentStart: number;
  segmentEnd: number;
  embedding: number[];
  embeddingModel: string;
}

export interface ChunkOptions {
  windowSec?: number;
  overlapSec?: number;
}

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

/**
 * Retrieval chunks (RAG units, invisible to users) — NOT topic sections (services/topics).
 * Defaults are STARTING VALUES to tune (CHUNK_SECONDS / CHUNK_OVERLAP_SECONDS in config/env.ts,
 * passed in by the pipeline), not fixed rules.
 */
export const CHUNK_DEFAULTS = Object.freeze({ windowSec: 60, overlapSec: 15 });

/**
 * Embedding models truncate long inputs silently (all-MiniLM-L6-v2: 256 word pieces), which
 * causes retrieval failures that are very hard to diagnose — so chunks end early at ~200 words.
 */
export const WORD_CAP = 200;

const wordCount = (text: string): number =>
  text.trim().length === 0 ? 0 : text.trim().split(/\s+/).length;

/**
 * Walks the segments accumulating until the window length is reached (or the next segment would
 * pass WORD_CAP), emits a chunk, then rewinds so the next chunk starts at the last segment
 * starting at or before (chunk end − overlapSec). Every boundary is a segment edge: a segment is
 * never split, so the real overlap is ≥ overlapSec (snapped), or 0 when a chunk is one segment.
 * A single segment longer than WORD_CAP still becomes its own chunk (it cannot be split).
 */
export function buildChunks(
  segments: readonly TranscriptSegmentInput[],
  options: ChunkOptions = {},
): ChunkOutput[] {
  if (segments.length === 0) return [];

  const windowSec = options.windowSec ?? CHUNK_DEFAULTS.windowSec;
  const overlapSec = options.overlapSec ?? CHUNK_DEFAULTS.overlapSec;

  if (!Number.isFinite(windowSec) || windowSec <= 0) throw new Error('windowSec must be positive');
  if (!Number.isFinite(overlapSec) || overlapSec < 0 || overlapSec >= windowSec) {
    throw new Error('overlapSec must be non-negative and smaller than windowSec');
  }

  const ordered = [...segments].sort((a, b) => a.index - b.index);
  const lectureId =
    typeof ordered[0]!.lectureId === 'object'
      ? ordered[0]!.lectureId!.toString()
      : String(ordered[0]!.lectureId ?? '');

  const chunks: ChunkOutput[] = [];
  let windowStart = ordered[0]!.startSec;
  let segmentStart = 0;

  while (segmentStart < ordered.length) {
    let segmentEnd = segmentStart;
    let text = '';
    let words = 0;

    while (segmentEnd < ordered.length) {
      const segment = ordered[segmentEnd]!;
      const candidateWords = wordCount(segment.text);
      if (segmentEnd > segmentStart && words + candidateWords > WORD_CAP) break;
      text = text ? `${text} ${segment.text}` : segment.text;
      words += candidateWords;
      segmentEnd += 1;

      const duration = segment.endSec - windowStart;
      if (duration >= windowSec || words >= WORD_CAP) break;
    }

    // A word limit that begins with one oversized segment is an embedding failure risk.
    // Keeping the segment whole is also important: chunks must never split a segment.
    if (segmentEnd === segmentStart) break;

    const first = ordered[segmentStart]!;
    const last = ordered[segmentEnd - 1]!;
    chunks.push({
      lectureId,
      index: chunks.length,
      startSec: round3(first.startSec),
      endSec: round3(last.endSec),
      text,
      segmentStart: first.index,
      segmentEnd: last.index,
      embedding: [],
      embeddingModel: '',
    });

    const rewindTarget = last.endSec - overlapSec;
    let nextStart = segmentStart;
    for (let i = segmentStart; i < segmentEnd; i += 1) {
      if (ordered[i]!.startSec <= rewindTarget) nextStart = i;
      else break;
    }
    if (nextStart <= segmentStart) nextStart = segmentEnd;
    segmentStart = nextStart;
    if (segmentStart >= ordered.length) break;
    windowStart = ordered[segmentStart]!.startSec;
  }

  return chunks;
}
