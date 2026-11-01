import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Types } from 'mongoose';
import { storageRoot } from '../../config/env.js';
import { Lecture, TranscriptSegment } from '../../models/index.js';
import { logger } from '../../utils/logger.js';
import type { AsrSegment, AsrTranscriptionResult } from './types.js';

const INSERT_BATCH_SIZE = 500;

/**
 * CONTRACTS.md §4.3: `lowConfidence` is `confidence < 0.75`, set at ingest and not cleared by
 * correction. (The PA.1 brief said 0.70; the frozen contract, the fixtures and the client all
 * use 0.75, so the contract wins.)
 */
export const LOW_CONFIDENCE_THRESHOLD = 0.75;

/** The provider's output cannot be stored as a transcript (bad timings, nothing recognised…). */
export class TranscriptValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TranscriptValidationError';
  }
}

/** Throws unless every segment is well-formed and segments are ordered without overlaps. */
export function validateSegments(segments: AsrSegment[]): void {
  let previous: AsrSegment | undefined;

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!;

    if (
      !Number.isFinite(segment.startSec) ||
      !Number.isFinite(segment.endSec) ||
      segment.startSec < 0 ||
      segment.endSec <= segment.startSec
    ) {
      throw new TranscriptValidationError(`Invalid timestamps at transcript segment ${i}.`);
    }

    if (!Number.isFinite(segment.confidence) || segment.confidence < 0 || segment.confidence > 1) {
      throw new TranscriptValidationError(`Invalid confidence at transcript segment ${i}.`);
    }

    if (previous) {
      if (segment.startSec <= previous.startSec) {
        throw new TranscriptValidationError(`Transcript timestamps must be strictly increasing at segment ${i}.`);
      }
      if (segment.startSec < previous.endSec) {
        throw new TranscriptValidationError(`Overlapping transcript segments at indexes ${i - 1} and ${i}.`);
      }
    }

    if (!segment.text.trim()) {
      throw new TranscriptValidationError(`Empty transcript text at segment ${i}.`);
    }

    previous = segment;
  }
}

export function isLowConfidence(confidence: number): boolean {
  return confidence < LOW_CONFIDENCE_THRESHOLD;
}

/** Keeps the transcript inside the probed recording: [0, durationSec] (topic tiling relies on it). */
function clampToDuration(segments: AsrSegment[], durationSec: number | null | undefined): AsrSegment[] {
  if (!durationSec) return segments;
  return segments
    .filter((s) => s.startSec < durationSec)
    .map((s) => (s.endSec > durationSec ? { ...s, endSec: durationSec } : s));
}

/**
 * Replaces the lecture's transcript with the provider result. Validates everything before
 * touching the database; records which provider produced it on `lecture.provider`, and keeps
 * the raw provider response beside the media (STORAGE_DIR/<lectureId>/asr-response.json) for
 * traceability — too large for the lecture document itself.
 */
export async function persistTranscription(
  lectureId: string,
  result: AsrTranscriptionResult,
  opts: { durationSec?: number | null; keyterms?: string[] } = {},
): Promise<number> {
  if (!Types.ObjectId.isValid(lectureId)) {
    throw new Error('Cannot persist transcript: invalid lecture ID.');
  }

  const segments = clampToDuration(result.segments, opts.durationSec);
  if (segments.length === 0) {
    throw new TranscriptValidationError('No speech was recognised in the recording.');
  }
  validateSegments(segments);

  const lecture = await Lecture.findById(lectureId).select('_id');
  if (!lecture) {
    throw new Error('Cannot persist transcript: lecture not found.');
  }

  const documents = segments.map((segment, index) => ({
    lectureId: lecture._id,
    index,
    startSec: segment.startSec,
    endSec: segment.endSec,
    text: segment.text.trim(),
    confidence: segment.confidence,
    lowConfidence: isLowConfidence(segment.confidence),
    speaker: segment.speaker ?? null,
    modelVersion: result.modelVersion,
  }));

  // A transcription run replaces the transcript; clearing first keeps (lectureId, index) unique.
  await TranscriptSegment.deleteMany({ lectureId: lecture._id });
  for (let offset = 0; offset < documents.length; offset += INSERT_BATCH_SIZE) {
    await TranscriptSegment.insertMany(documents.slice(offset, offset + INSERT_BATCH_SIZE), { ordered: true });
  }

  // Targeted update: the pipeline owns status/stages on this document.
  await Lecture.updateOne(
    { _id: lecture._id },
    { $set: { provider: { asr: result.provider, asrModel: result.model, externalId: result.externalId } } },
  );

  try {
    await writeFile(
      path.join(storageRoot, String(lecture._id), 'asr-response.json'),
      JSON.stringify({
        provider: result.provider,
        model: result.model,
        externalId: result.externalId,
        keyterms: opts.keyterms ?? null, // which glossary prompt (if any) produced this transcript
        response: result.rawResponse,
      }),
    );
  } catch (err) {
    // Traceability aid only; the transcript itself is already stored.
    logger.warn('Could not store the raw ASR response', { lectureId, error: err });
  }

  return documents.length;
}
