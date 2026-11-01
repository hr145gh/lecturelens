
import { Types } from 'mongoose';
import { Lecture, TranscriptSegment } from '../../models/index.js';
import type { AsrSegment, AsrTranscriptionResult } from './types.js';

const INSERT_BATCH_SIZE = 500;
const LOW_CONFIDENCE_THRESHOLD = 0.70;

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
      throw new Error(`Invalid timestamps at transcript segment ${i}.`);
    }

    if (
      !Number.isFinite(segment.confidence) ||
      segment.confidence < 0 ||
      segment.confidence > 1
    ) {
      throw new Error(`Invalid confidence at transcript segment ${i}.`);
    }

    if (i > 0 && previous) {
      if (segment.startSec <= previous.startSec) {
        throw new Error(
          `Transcript timestamps must be strictly increasing at segment ${i}.`,
        );
      }

      if (segment.startSec < previous.endSec) {
        throw new Error(
          `Overlapping transcript segments at indexes ${i - 1} and ${i}.`,
        );
      }
    }

    if (!segment.text.trim()) {
      throw new Error(`Empty transcript text at segment ${i}.`);
    }

    previous = segment;
  }
}

export async function persistTranscription(
  lectureId: string,
  result: AsrTranscriptionResult,
): Promise<void> {
  if (!Types.ObjectId.isValid(lectureId)) {
    throw new Error('Cannot persist transcript: invalid lecture ID.');
  }

  validateSegments(result.segments);

  const lecture = await Lecture.findById(lectureId);

  if (!lecture) {
    throw new Error('Cannot persist transcript: lecture not found.');
  }

  const documents = result.segments.map((segment, index) => ({
    lectureId: lecture._id,
    index,
    startSec: segment.startSec,
    endSec: segment.endSec,
    text: segment.text,
    confidence: segment.confidence,
    lowConfidence: isLowConfidence(segment.confidence),
    speaker: segment.speaker ?? null,
    modelVersion: result.modelVersion,
  }));

  // Clear prior ASR output so reprocessing does not collide with the unique
  // (lectureId, index) index. The caller should only invoke this for a
  // transcription run, where replacing the transcript is intended.
  await TranscriptSegment.deleteMany({ lectureId: lecture._id });

  for (let offset = 0; offset < documents.length; offset += INSERT_BATCH_SIZE) {
    await TranscriptSegment.insertMany(
      documents.slice(offset, offset + INSERT_BATCH_SIZE),
      { ordered: true },
    );
  }

  lecture.provider = {
    asr: lecture.provider?.asr ?? null,
    asrModel: result.modelVersion,
    externalId: null,
  };

  await lecture.save();
}

export function isLowConfidence(confidence: number): boolean {
  return confidence < LOW_CONFIDENCE_THRESHOLD;
}

