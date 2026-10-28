import path from 'node:path';
import {
  Lecture,
  STAGE_NAMES,
  type LectureStatus,
  type StageName,
  type ProcessingStage,
} from '../../models/index.js';
import { storageRoot } from '../../config/env.js';
import { stagesAfter } from '../../modules/lectures/stages.js';
import { extractAudio, MediaProcessingError } from '../media/extract.js';
import { transcribeWithFallback } from '../asr/index.js';
import { persistTranscription } from '../asr/persist.js';
import { logger } from '../../utils/logger.js';

export interface ProcessingPipeline {
  startProcessing(lectureId: string, opts?: { fromStage?: LectureStatus }): Promise<void>;
}

export const NOT_IMPLEMENTED_DETAIL =
  'Downstream processing stages (chunking, segmenting, summarising, indexing) are not implemented yet.';

const asStage = (status: LectureStatus | undefined): StageName =>
  STAGE_NAMES.includes(status as StageName) ? (status as StageName) : 'extracting';

function finishStage(
  stages: ProcessingStage[],
  stageName: StageName,
  now = new Date(),
): ProcessingStage[] {
  return stages.map((stage) => {
    if (stage.name !== stageName || stage.state !== 'running') return stage;

    const ms = stage.startedAt
      ? Math.max(0, now.getTime() - stage.startedAt.getTime())
      : 0;

    return {
      ...stage,
      state: 'done',
      ms,
      finishedAt: now,
    };
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function recordFailure(
  lectureId: string,
  stage: StageName,
  code: 'TRANSCRIPTION_FAILED' | 'PROVIDER_UNAVAILABLE' | 'INTERNAL_ERROR' | 'NOT_IMPLEMENTED',
  message: string,
): Promise<void> {
  const lecture = await Lecture.findById(lectureId);
  if (!lecture || lecture.status === 'ready') return;

  const at = new Date();
  lecture.status = 'failed';
  lecture.statusDetail = message;
  lecture.error = { stage, code, message, at };
  lecture.stages = stagesAfter(lecture.stages, 'failed', stage, at);
  await lecture.save();
}

export const notImplementedPipeline: ProcessingPipeline = {
  async startProcessing(lectureId, opts) {
    const requestedStage = asStage(opts?.fromStage);

    try {
      const lecture = await Lecture.findById(lectureId);
      if (!lecture || lecture.status === 'ready') return;

      const stageIndex = STAGE_NAMES.indexOf(requestedStage);

      // PA.1 implements extraction and transcription only.
      // Reprocessing from a later stage must not silently rerun ASR.
      if (stageIndex >= STAGE_NAMES.indexOf('chunking')) {
        await recordFailure(
          lectureId,
          requestedStage,
          'NOT_IMPLEMENTED',
          NOT_IMPLEMENTED_DETAIL,
        );
        return;
      }

      let activeStage: StageName = requestedStage;

      if (requestedStage === 'extracting') {
        const at = new Date();
        lecture.status = 'extracting';
        lecture.statusDetail = 'Extracting audio from uploaded media.';
        lecture.error = null;
        lecture.stages = stagesAfter(lecture.stages, 'extracting', null, at);
        await lecture.save();

        const mediaPath = path.resolve(storageRoot, lecture.mediaPath);
        const extracted = await extractAudio(mediaPath);

        lecture.audioPath = path.relative(storageRoot, extracted.audioPath);
        lecture.durationSec = extracted.durationSec;
        lecture.stages = finishStage(lecture.stages, 'extracting');
        lecture.status = 'transcribing';
        lecture.statusDetail = 'Audio extracted; transcription is in progress.';
        lecture.stages = stagesAfter(lecture.stages, 'transcribing', null);
        await lecture.save();

        activeStage = 'transcribing';
      } else {
        activeStage = 'transcribing';

        if (!lecture.audioPath) {
          await recordFailure(
            lectureId,
            'transcribing',
            'INTERNAL_ERROR',
            'Cannot resume transcription because the extracted audio path is missing. Reprocess from extracting.',
          );
          return;
        }

        lecture.status = 'transcribing';
        lecture.statusDetail = 'Transcription is in progress.';
        lecture.error = null;
        lecture.stages = stagesAfter(lecture.stages, 'transcribing', null);
        await lecture.save();
      }

      const current = await Lecture.findById(lectureId);
      if (!current || current.status === 'ready') return;

      const audioPath = current.audioPath
        ? path.resolve(storageRoot, current.audioPath)
        : null;

      if (!audioPath) {
        await recordFailure(
          lectureId,
          activeStage,
          'INTERNAL_ERROR',
          'Audio path is missing; transcription cannot start.',
        );
        return;
      }

      let result;
      try {
        result = await transcribeWithFallback(audioPath);
      } catch (error) {
        const message = messageOf(error);
        logger.error('Both ASR providers failed', { lectureId, error: message });
        await recordFailure(
          lectureId,
          'transcribing',
          'TRANSCRIPTION_FAILED',
          `Transcription failed: ${message}`,
        );
        return;
      }

      await persistTranscription(lectureId, result);

      const afterTranscription = await Lecture.findById(lectureId);
      if (!afterTranscription) return;

      afterTranscription.stages = finishStage(
        afterTranscription.stages,
        'transcribing',
      );
      await afterTranscription.save();

      // PA.1 ends at transcription. Do not report ready while downstream stages
      // have no implementation to produce chunks, topics, summaries, or indexes.
      await recordFailure(
        lectureId,
        'chunking',
        'NOT_IMPLEMENTED',
        NOT_IMPLEMENTED_DETAIL,
      );
    } catch (error) {
      const message = messageOf(error);
      logger.error('Processing pipeline failed', { lectureId, error: message });

      try {
        const lecture = await Lecture.findById(lectureId);
        if (!lecture || lecture.status === 'ready' || lecture.status === 'failed') return;

        const stage = asStage(lecture.status);
        await recordFailure(
          lectureId,
          stage,
          stage === 'transcribing' ? 'TRANSCRIPTION_FAILED' : 'INTERNAL_ERROR',
          message,
        );
      } catch (recordError) {
        logger.error('Could not record pipeline failure', {
          lectureId,
          error: messageOf(recordError),
        });
      }
    }
  },
};

let pipeline: ProcessingPipeline = notImplementedPipeline;

export function setPipeline(next: ProcessingPipeline): void {
  pipeline = next;
}

export function startProcessing(
  lectureId: string,
  opts?: { fromStage?: LectureStatus },
): Promise<void> {
  return pipeline.startProcessing(lectureId, opts);
}

export async function failInterruptedLectures(): Promise<number> {
  const stuck = await Lecture.find({ status: { $nin: ['ready', 'failed'] } });

  for (const lecture of stuck) {
    const stage = asStage(lecture.status);
    const at = new Date();
    const message = 'Processing was interrupted by a server restart. Reprocess to try again.';

    lecture.status = 'failed';
    lecture.statusDetail = message;
    lecture.error = {
      stage,
      code: 'PIPELINE_INTERRUPTED',
      message,
      at,
    };
    lecture.stages = stagesAfter(lecture.stages, 'failed', stage, at);
    await lecture.save();
  }

  if (stuck.length) {
    logger.warn('Marked interrupted lectures as failed', { count: stuck.length });
  }

  return stuck.length;
}


function mapMediaError(error: unknown): {
  code: 'INTERNAL_ERROR';
  message: string;
} {
  return {
    code: 'INTERNAL_ERROR',
    message: messageOf(error),
  };
}