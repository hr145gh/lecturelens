import path from 'node:path';
import {
  Chunk,
  Lecture,
  STAGE_NAMES,
  TopicSection,
  TranscriptSegment,
  type LectureErrorCode,
  type LectureStatus,
  type ProcessingStage,
  type StageName,
} from '../../models/index.js';
import { env, storageRoot } from '../../config/env.js';
import { stagesAfter } from '../../modules/lectures/stages.js';
import { logger } from '../../utils/logger.js';
import { pipelineKeyterms } from '../asr/glossary.js';
import { AsrUnavailableError, transcribeWithFallback } from '../asr/index.js';
import { persistTranscription, TranscriptValidationError } from '../asr/persist.js';
import { buildChunks } from '../chunking/chunker.js';
import { extractAudio, makeBrowserPlayable, MediaProcessingError } from '../media/extract.js';
import { createSummariesForLecture } from '../summaries/index.js';
import {
  assertTopicTiling,
  embeddingSimilarity,
  fixedWindow,
  type EmbeddingProvider,
  type TopicSectionOutput,
} from '../topics/segmenter.js';
import { labelSection } from '../topics/labeller.js';
import { getLlmClient, llmModelName } from '../llm/client.js';

/*
 * ===========================================================================================
 *  PROCESSING PIPELINE. Interface owned by Member D; stages by Member A (extracting,
 *  transcribing), Member B (chunking, segmenting, summarising) and Member C (indexing).
 *  Do not change the interface without a contract-change issue.
 * ===========================================================================================
 *
 *  - Called WITHOUT await after upload / a reprocess claim; never throws, never leaves a
 *    lecture in a running status (failures are recorded on the lecture: status "failed" +
 *    `error`, the full error is logged).
 *  - `fromStage` is the first stage to (re)run; omitted = "extracting". Runs every stage after
 *    it in CONTRACTS.md §2 order, updating status, statusDetail and stage timings as it goes.
 */
export interface ProcessingPipeline {
  startProcessing(lectureId: string, opts?: { fromStage?: LectureStatus }): Promise<void>;
}

const asStage = (status: LectureStatus | undefined): StageName =>
  STAGE_NAMES.includes(status as StageName) ? (status as StageName) : 'extracting';

const STAGE_DETAIL: Record<StageName, string> = {
  extracting: 'Extracting audio with FFmpeg.',
  transcribing: 'Transcribing the audio (speech recognition).',
  chunking: 'Splitting the transcript into passages.',
  segmenting: 'Finding topic sections.',
  summarising: 'Writing section summaries.',
  indexing: 'Indexing passages for search.',
};

/** Indexing (embeddings for search) belongs to Member C and does not exist yet. */
export const READY_WITHOUT_INDEXING_DETAIL =
  'Ready. Search indexing is not available yet (Member C), so this lecture cannot be searched or asked about.';

/* ------------------------------------------------------------------ Member B's stages ---- */

/** Member B — chunking. Builds retrieval chunks from the stored transcript segments. */
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
    // Starting values to tune (config/env.ts); unset → the chunker's defaults (60 s / 15 s).
    { windowSec: env.CHUNK_SECONDS, overlapSec: env.CHUNK_OVERLAP_SECONDS },
  );

  await Chunk.deleteMany({ lectureId });
  await Chunk.insertMany(
    built.map((chunk) => ({
      ...chunk,
      // Validated config: an empty EMBEDDING_MODEL= counts as unset (process.env would give '').
      embeddingModel: env.EMBEDDING_MODEL ?? 'Xenova/all-MiniLM-L6-v2',
    })),
  );
  // (Status moves are made by the pipeline runner below, for every stage alike.)
  return built.length;
}

/** Member B — topic segmentation and labelling. */
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
    sections = fixedWindow(inputs, lecture.durationSec, { sectionSec: env.TOPIC_SECTION_SECONDS });
  } else {
    sections = await embeddingSimilarity(inputs, lecture.durationSec, embedder, {
      threshold: env.TOPIC_SIM_THRESHOLD,
      minSectionSec: env.TOPIC_MIN_SEC,
    });
  }
  assertTopicTiling(sections, lecture.durationSec, inputs); // before anything is written

  // Labels: the shared LLM client when configured; TF-IDF over this lecture's sections otherwise.
  const texts = sections.map((section) =>
    inputs
      .filter((segment) => segment.index >= section.segmentStart && segment.index <= section.segmentEnd)
      .map((segment) => segment.text)
      .join(' '),
  );
  const llm = getLlmClient();
  const labels = [];
  for (const text of texts) labels.push(await labelSection(text, { llm, corpus: texts }));

  await TopicSection.deleteMany({ lectureId });
  const created: Array<Record<string, unknown>> = [];
  for (const [i, section] of sections.entries()) {
    const labelled = labels[i]!;
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

/* ------------------------------------------------------------------------- stages ---- */

type StageRunner = (lectureId: string) => Promise<void>;

const STAGES: Record<Exclude<StageName, 'indexing'>, StageRunner> = {
  // Member A
  async extracting(lectureId) {
    const lecture = await Lecture.findById(lectureId).select('mediaPath');
    if (!lecture) throw new Error('Lecture not found');
    const mediaPath = path.resolve(storageRoot, lecture.mediaPath);
    // A fragmented MP4 (or one with its index at the end) plays with a wrong duration in browsers;
    // rewrite it losslessly in place first. Never fails the stage.
    await makeBrowserPlayable(mediaPath);
    const { audioPath, durationSec } = await extractAudio(mediaPath);
    await Lecture.updateOne(
      { _id: lectureId },
      { $set: { audioPath: path.relative(storageRoot, audioPath), durationSec } },
    );
  },

  // Member A
  async transcribing(lectureId) {
    const lecture = await Lecture.findById(lectureId).select('audioPath durationSec');
    if (!lecture) throw new Error('Lecture not found');
    if (!lecture.audioPath) {
      throw new TranscriptValidationError('The extracted audio is missing. Reprocess from "extracting".');
    }
    // A (re)transcription starts from nothing: never two interleaved transcripts for one lecture.
    const { deletedCount } = await TranscriptSegment.deleteMany({ lectureId });
    if (deletedCount) logger.info('Cleared the previous transcript before transcribing', { lectureId, segments: deletedCount });

    const keyterms = await pipelineKeyterms();
    const result = await transcribeWithFallback(path.resolve(storageRoot, lecture.audioPath), {
      durationSec: lecture.durationSec ?? undefined,
      lectureId,
      keyterms,
    });
    const count = await persistTranscription(lectureId, result, { durationSec: lecture.durationSec, keyterms });
    logger.info('Transcript stored', { lectureId, segments: count, provider: result.provider, modelVersion: result.modelVersion });
  },

  // Member B
  async chunking(lectureId) {
    await runChunkingStage(lectureId);
  },

  // Member B — embedding similarity needs Member C's embedder; until then, fixed windows
  // (recorded honestly as method "fixed_window" on every topic section).
  async segmenting(lectureId) {
    await runSegmentingStage(lectureId, undefined, 'fixed_window');
  },

  // Member B — the shared LLM client when configured; Member B's extractive fallback otherwise.
  async summarising(lectureId) {
    await createSummariesForLecture(lectureId, getLlmClient(), llmModelName());
  },
};

/* ----------------------------------------------------------------- status updates ---- */

function finishStage(stages: ProcessingStage[], stageName: StageName, now = new Date()): ProcessingStage[] {
  return stages.map((stage) => {
    if (stage.name !== stageName || stage.state !== 'running') return stage;
    const ms = stage.startedAt ? Math.max(0, now.getTime() - stage.startedAt.getTime()) : 0;
    return { ...stage, state: 'done', ms, finishedAt: now };
  });
}

/** Moves the lecture into `stage`. Returns false if the lecture no longer exists (deleted mid-run). */
async function enterStage(lectureId: string, stage: StageName): Promise<boolean> {
  const lecture = await Lecture.findById(lectureId);
  if (!lecture) return false;
  lecture.status = stage;
  lecture.statusDetail = STAGE_DETAIL[stage];
  lecture.error = null;
  lecture.stages = stagesAfter(lecture.stages, stage, null);
  await lecture.save();
  return true;
}

async function completeStage(lectureId: string, stage: StageName): Promise<void> {
  const lecture = await Lecture.findById(lectureId);
  if (!lecture) return;
  lecture.stages = finishStage(lecture.stages, stage);
  await lecture.save();
}

async function markReady(lectureId: string): Promise<void> {
  const lecture = await Lecture.findById(lectureId);
  if (!lecture) return;
  const at = new Date();
  lecture.status = 'ready';
  lecture.statusDetail = READY_WITHOUT_INDEXING_DETAIL;
  lecture.error = null;
  lecture.stages = stagesAfter(lecture.stages, 'ready', null, at).map((s) =>
    s.name === 'indexing' ? { name: 'indexing', state: 'skipped', ms: null, startedAt: null, finishedAt: null } : s,
  );
  await lecture.save();
}

/** A failure as the lecture records it: contract error code + a sentence a teacher can act on. */
export function describeFailure(error: unknown, stage: StageName): { code: LectureErrorCode; message: string } {
  if (error instanceof MediaProcessingError) {
    switch (error.code) {
      case 'NO_AUDIO_STREAM':
        return { code: 'NO_AUDIO_STREAM', message: 'The uploaded file has no audio track to transcribe.' };
      case 'FFMPEG_NOT_FOUND':
      case 'FFPROBE_NOT_FOUND':
        return { code: 'INTERNAL_ERROR', message: 'The server cannot process media because FFmpeg is not installed.' };
      default:
        return { code: 'UNSUPPORTED_CODEC', message: 'The file could not be decoded; it may be corrupt or use an unsupported codec.' };
    }
  }
  if (error instanceof AsrUnavailableError) {
    const notConfigured = error.errors.every((e) => e instanceof Error && /is not configured/.test(e.message));
    return {
      code: 'PROVIDER_UNAVAILABLE',
      message: notConfigured
        ? 'Speech recognition is not configured on this server (no AssemblyAI or Groq API key).'
        : 'Speech recognition is unavailable right now (both providers failed). Reprocess to try again.',
    };
  }
  if (error instanceof TranscriptValidationError) {
    return { code: 'TRANSCRIPTION_FAILED', message: `Transcription failed: ${error.message}` };
  }
  return { code: 'INTERNAL_ERROR', message: `Processing failed unexpectedly while ${STAGE_DETAIL[stage].replace(/\.$/, '').toLowerCase()}. The error has been logged.` };
}

async function recordFailure(lectureId: string, stage: StageName, error: unknown): Promise<void> {
  const { code, message } = describeFailure(error, stage);
  logger.error('Processing failed', { lectureId, stage, code, error });
  const lecture = await Lecture.findById(lectureId);
  if (!lecture) return;
  const at = new Date();
  lecture.status = 'failed';
  lecture.statusDetail = message;
  lecture.error = { stage, code, message, at };
  lecture.stages = stagesAfter(lecture.stages, 'failed', stage, at);
  await lecture.save();
}

/* ------------------------------------------------------------------------- runner ---- */

/** Lectures with a run in progress in this process (the server is single-process; §2 has no queue). */
const inFlight = new Set<string>();

export const processingPipeline: ProcessingPipeline = {
  async startProcessing(lectureId, opts) {
    // Safe to call twice: a second call while a run is going would duplicate work and segments.
    if (inFlight.has(lectureId)) {
      logger.warn('Processing already in progress for this lecture; ignoring the duplicate start', {
        lectureId,
        fromStage: opts?.fromStage ?? 'extracting',
      });
      return;
    }
    inFlight.add(lectureId);
    try {
      await runPipeline(lectureId, opts);
    } finally {
      inFlight.delete(lectureId);
    }
  },
};

/** True while this process is running the pipeline for `lectureId`. */
export const isProcessing = (lectureId: string): boolean => inFlight.has(lectureId);

async function runPipeline(lectureId: string, opts?: { fromStage?: LectureStatus }): Promise<void> {
  const fromStage = asStage(opts?.fromStage);
  let stage: StageName = fromStage;
  let settled = false;

  try {
    for (stage of STAGE_NAMES.slice(STAGE_NAMES.indexOf(fromStage))) {
      if (stage === 'indexing') break; // Member C: not implemented yet
      if (!(await enterStage(lectureId, stage))) {
        settled = true; // lecture deleted mid-run: nothing left to update
        return;
      }
      await STAGES[stage](lectureId);
      await completeStage(lectureId, stage);
    }
    await markReady(lectureId);
    settled = true;
  } catch (error) {
    try {
      await recordFailure(lectureId, stage, error);
      settled = true;
    } catch (recordError) {
      logger.error('Could not record the processing failure', { lectureId, stage, error: recordError });
    }
  } finally {
    if (!settled) {
      // Never leave a lecture in a running status: one last, minimal attempt.
      await Lecture.updateOne(
        { _id: lectureId, status: stage },
        {
          $set: {
            status: 'failed',
            statusDetail: 'Processing stopped unexpectedly. Reprocess to try again.',
            error: { stage, code: 'INTERNAL_ERROR', message: 'Processing stopped unexpectedly.', at: new Date() },
          },
        },
      ).catch((err: unknown) => logger.error('Could not mark the lecture failed', { lectureId, error: err }));
    }
  }
}

let pipeline: ProcessingPipeline = processingPipeline;

/** Swap the implementation (a fake in tests). */
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
    const message = 'Processing was interrupted by a server restart. Reprocess to try again.';
    lecture.status = 'failed';
    lecture.statusDetail = message;
    lecture.error = { stage, code: 'PIPELINE_INTERRUPTED', message, at };
    lecture.stages = stagesAfter(lecture.stages, 'failed', stage, at);
    await lecture.save();
  }
  if (stuck.length) logger.warn('Marked interrupted lectures as failed', { count: stuck.length });
  return stuck.length;
}
