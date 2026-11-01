import {
  Chunk,
  Lecture,
  STAGE_NAMES,
  TopicSection,
  TranscriptSegment,
  type LectureStatus,
  type StageName,
} from '../../models/index.js';
import { stagesAfter } from '../../modules/lectures/stages.js';
import { logger } from '../../utils/logger.js';
import { buildChunks } from '../chunking/chunker.js';
import {
  assertTopicTiling,
  embeddingSimilarity,
  fixedWindow,
  type EmbeddingProvider,
  type TopicSectionOutput,
} from '../topics/segmenter.js';
import { labelSection } from '../topics/labeller.js';

/*
 * ===========================================================================================
 *  PROCESSING PIPELINE — INTERFACE + STUB. Owned jointly: Member D defines the interface,
 *  Member A implements it.
 *
 *  Member A replaces this implementation in PA.1/PA.2.
 *  Do not change the interface without a contract-change issue.
 * ===========================================================================================
 *
 *  Contract for implementations:
 *  - Called WITHOUT await right after the lecture is saved (upload) or claimed for a rerun
 *    (reprocess), so it must never throw synchronously and should record its own failures on
 *    the lecture (status "failed" + `error`) rather than rejecting.
 *  - `fromStage` is the first stage to (re)run; omitted = from "extracting".
 *  - Keep `status`, `statusDetail`, `error` and `stages` up to date as stages run
 *    (CONTRACTS.md §2, §4.2).
 */
export interface ProcessingPipeline {
  startProcessing(lectureId: string, opts?: { fromStage?: LectureStatus }): Promise<void>;
}

/** Member A calls these hooks after transcription; they must not be called out of pipeline order. */
export async function runChunkingStage(lectureId: string): Promise<number> {
  const lecture = await Lecture.findById(lectureId);
  if (!lecture) throw new Error('Lecture not found');
  const segments = await TranscriptSegment.find({ lectureId }).sort({ index: 1 });
  const built = buildChunks(
    segments.map((segment) => ({
      lectureId: String(segment.lectureId),
      index: segment.index,
      startSec: segment.startSec,
      endSec: segment.endSec,
      text: segment.text,
    })),
  );

  await Chunk.deleteMany({ lectureId });
  await Chunk.insertMany(
    built.map((chunk) => ({
      ...chunk,
      embeddingModel: process.env.EMBEDDING_MODEL ?? 'Xenova/all-MiniLM-L6-v2',
    })),
  );

  const at = new Date();
  lecture.status = 'segmenting';
  lecture.statusDetail = 'Detecting topic sections.';
  lecture.error = null;
  lecture.stages = stagesAfter(lecture.stages, 'segmenting', null, at);
  await lecture.save();
  return built.length;
}

export async function runSegmentingStage(
  lectureId: string,
  embedder?: EmbeddingProvider,
  method: 'embedding_similarity' | 'fixed_window' = 'embedding_similarity',
): Promise<number> {
  const lecture = await Lecture.findById(lectureId);
  if (!lecture || lecture.durationSec == null) throw new Error('Lecture duration is required');
  const segments = await TranscriptSegment.find({ lectureId }).sort({ index: 1 });
  const inputs = segments.map((segment) => ({
    index: segment.index,
    startSec: segment.startSec,
    endSec: segment.endSec,
    text: segment.text,
  }));

  let sections: TopicSectionOutput[];
  if (method === 'fixed_window') {
    sections = fixedWindow(inputs, lecture.durationSec);
  } else {
    sections = await embeddingSimilarity(inputs, lecture.durationSec, embedder);
  }
  assertTopicTiling(sections, lecture.durationSec, inputs);

  await TopicSection.deleteMany({ lectureId });
  const created: Array<Record<string, unknown>> = [];
  for (const section of sections) {
    const text = inputs
      .filter((segment) => segment.index >= section.segmentStart && segment.index <= section.segmentEnd)
      .map((segment) => segment.text)
      .join(' ');
    const labelled = await labelSection(text);
    created.push({
      lectureId,
      ...section,
      label: labelled.label,
      keywords: labelled.keywords,
      status: 'pending_review',
      rejectionReason: null,
      reviewedBy: null,
      reviewedAt: null,
    });
  }
  await TopicSection.insertMany(created);
  return sections.length;
}

export const NOT_IMPLEMENTED_DETAIL = 'Transcription pipeline not yet implemented (Member A, prompt PA.1)';

const asStage = (status: LectureStatus | undefined): StageName =>
  STAGE_NAMES.includes(status as StageName) ? (status as StageName) : 'extracting';

/**
 * Default implementation until Member A's lands: honestly marks the lecture as failed at the
 * stage it would have started, with error code NOT_IMPLEMENTED. Never fakes success.
 */
export const notImplementedPipeline: ProcessingPipeline = {
  async startProcessing(lectureId, opts) {
    const stage = asStage(opts?.fromStage);
    logger.warn('Processing pipeline is not implemented yet; marking the lecture failed', { lectureId, stage });
    try {
      const lecture = await Lecture.findById(lectureId);
      if (!lecture || lecture.status === 'ready' || lecture.status === 'failed') return; // deleted or settled
      const at = new Date();
      lecture.status = 'failed';
      lecture.statusDetail = NOT_IMPLEMENTED_DETAIL;
      lecture.error = { stage, code: 'NOT_IMPLEMENTED', message: NOT_IMPLEMENTED_DETAIL, at };
      lecture.stages = stagesAfter(lecture.stages, 'failed', stage, at);
      await lecture.save();
    } catch (err) {
      logger.error('Could not record the pipeline stub failure', { lectureId, error: err });
    }
  },
};

let pipeline: ProcessingPipeline = notImplementedPipeline;

/** Swap the implementation (Member A's pipeline, or a fake in tests). */
export function setPipeline(next: ProcessingPipeline): void {
  pipeline = next;
}

export function startProcessing(lectureId: string, opts?: { fromStage?: LectureStatus }): Promise<void> {
  return pipeline.startProcessing(lectureId, opts);
}

/**
 * On boot (§2): there is no job queue to resume from, so any lecture left mid-pipeline by a
 * restart is marked failed with PIPELINE_INTERRUPTED. Returns how many were marked.
 */
export async function failInterruptedLectures(): Promise<number> {
  const stuck = await Lecture.find({ status: { $nin: ['ready', 'failed'] } });
  for (const lecture of stuck) {
    const stage = asStage(lecture.status);
    const at = new Date();
    lecture.status = 'failed';
    lecture.statusDetail = 'Processing was interrupted by a server restart. Reprocess to try again.';
    lecture.error = { stage, code: 'PIPELINE_INTERRUPTED', message: 'The server restarted while this lecture was processing.', at };
    lecture.stages = stagesAfter(lecture.stages, 'failed', stage, at);
    await lecture.save();
  }
  if (stuck.length) logger.warn('Marked interrupted lectures as failed', { count: stuck.length });
  return stuck.length;
}
