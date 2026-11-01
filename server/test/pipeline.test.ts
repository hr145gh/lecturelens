import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Types } from 'mongoose';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { storageRoot } from '../src/config/env.js';
import { Chunk, Lecture, Summary, TopicSection, TranscriptSegment, type ILecture } from '../src/models/index.js';
import { mapAssemblyWords } from '../src/services/asr/assemblyai.js';
import { glossarySettings, loadGlossary } from '../src/services/asr/glossary.js';
import { asrProviders } from '../src/services/asr/index.js';
import { persistTranscription, TranscriptValidationError } from '../src/services/asr/persist.js';
import { groupWordsIntoSegments } from '../src/services/asr/segments.js';
import type { AsrProvider, AsrTranscriptionResult } from '../src/services/asr/types.js';
import { mp4Layout } from '../src/services/media/extract.js';
import {
  processingPipeline,
  READY_WITHOUT_INDEXING_DETAIL,
  setPipeline,
} from '../src/services/processing/pipeline.js';
import { logger } from '../src/utils/logger.js';
import { authHeader, buildApp, makeTeacher, resetDb } from './setup.js';

/**
 * The real pipeline end to end — real FFmpeg extraction, real MongoDB, Member B's real chunking /
 * segmenting / summarising — with only the ASR provider faked (replaying the AssemblyAI fixture).
 */

const realProviders = { ...asrProviders };
afterEach(() => {
  Object.assign(asrProviders, realProviders);
  vi.restoreAllMocks();
});

const fixture = JSON.parse(
  readFileSync(new URL('../../evaluation/asr/fixtures/assemblyai-transcript.json', import.meta.url), 'utf8'),
) as { id: string; words: Parameters<typeof mapAssemblyWords>[0]; confidence: number };

const fixtureResult = (): AsrTranscriptionResult => ({
  segments: groupWordsIntoSegments(mapAssemblyWords(fixture.words, fixture.confidence)),
  modelVersion: 'assemblyai-universal-2',
  provider: 'assemblyai',
  model: 'universal-2',
  externalId: fixture.id,
  rawResponse: fixture,
});

const fake = (impl: AsrProvider['transcribe']): AsrProvider => ({ transcribe: vi.fn(impl) });
const failing = (message: string) => fake(async () => { throw new Error(message); });

function ffmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-y', ...args]);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
    child.on('error', reject);
  });
}

/** A lecture whose mediaPath is a real file made by `make(absolutePath)`. */
async function lectureWithMedia(teacherId: Types.ObjectId, file: string, make: (p: string) => Promise<void>) {
  const id = new Types.ObjectId();
  await mkdir(path.join(storageRoot, String(id)), { recursive: true });
  await make(path.join(storageRoot, String(id), file));
  return Lecture.create({
    _id: id,
    title: 'Lecture 7 — Gradient Descent',
    uploadedBy: teacherId,
    consent: { lecturerConsent: true, purposeShown: true, processorNamed: true, grantedBy: teacherId, grantedAt: new Date() },
    status: 'uploaded',
    statusDetail: 'Upload received; waiting to start audio extraction.',
    mediaPath: `${id}/${file}`,
    media: { originalFilename: file, mimeType: 'audio/mpeg', sizeBytes: 1 },
  });
}

const tone = (seconds: number) => (p: string) =>
  ffmpeg(['-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, '-ac', '2', '-ar', '44100', p]);

let teacher: Awaited<ReturnType<typeof makeTeacher>>;
beforeEach(async () => {
  await resetDb();
  setPipeline(processingPipeline);
  teacher = await makeTeacher();
});

describe('processing pipeline (Member A → Member B handoff)', () => {
  it('runs extracting → transcribing → chunking → segmenting → summarising → ready, with real progress', async () => {
    const lecture = await lectureWithMedia(teacher._id, 'lecture.mp3', tone(24));
    // Record every status the lecture is saved with, in order.
    const statuses: string[] = [];
    const originalSave = Lecture.prototype.save;
    vi.spyOn(Lecture.prototype, 'save').mockImplementation(function (this: InstanceType<typeof Lecture>, ...args: Parameters<typeof originalSave>) {
      if (statuses.at(-1) !== this.status) statuses.push(this.status);
      return originalSave.apply(this, args);
    });

    let seenDuringAsr: Pick<ILecture, 'status' | 'durationSec' | 'audioPath'> | null = null;
    asrProviders.assemblyai = fake(async (audioPath, opts) => {
      const now = await Lecture.findById(lecture._id).lean();
      seenDuringAsr = { status: now!.status, durationSec: now!.durationSec, audioPath: now!.audioPath };
      expect(audioPath.endsWith('lecture.audio.wav')).toBe(true);
      expect(opts.durationSec).toBeCloseTo(24, 1);
      return fixtureResult();
    });

    await processingPipeline.startProcessing(lecture.id);

    expect(statuses).toEqual(['extracting', 'transcribing', 'chunking', 'segmenting', 'summarising', 'ready']);
    expect(seenDuringAsr).toMatchObject({ status: 'transcribing', audioPath: `${lecture.id}/lecture.audio.wav` });

    const done = await Lecture.findById(lecture._id);
    expect(done).toMatchObject({ status: 'ready', statusDetail: READY_WITHOUT_INDEXING_DETAIL, error: null });
    expect(done!.durationSec).toBeCloseTo(24, 1);
    expect(done!.provider).toMatchObject({ asr: 'assemblyai', asrModel: 'universal-2', externalId: fixture.id });
    expect(done!.stages.map((s) => `${s.name}:${s.state}`)).toEqual([
      'extracting:done', 'transcribing:done', 'chunking:done', 'segmenting:done', 'summarising:done', 'indexing:skipped',
    ]);
    expect(done!.stages.find((s) => s.name === 'extracting')!.ms).toBeGreaterThan(0);

    // Member A's output, exactly as CONTRACTS.md §4.3 describes it.
    const segments = await TranscriptSegment.find({ lectureId: lecture._id }).sort({ index: 1 }).lean();
    const expected = fixtureResult().segments;
    expect(segments.map((s) => s.index)).toEqual(expected.map((_, i) => i));
    expect(segments.map((s) => [s.startSec, s.endSec, s.text])).toEqual(expected.map((s) => [s.startSec, s.endSec, s.text]));
    for (const s of segments) {
      expect(s.lowConfidence).toBe(s.confidence < 0.75);
      expect(s).toMatchObject({ modelVersion: 'assemblyai-universal-2', corrected: false, originalText: null });
    }

    // Member B's stages ran on it.
    expect(await Chunk.countDocuments({ lectureId: lecture._id })).toBeGreaterThan(0);
    const topics = await TopicSection.find({ lectureId: lecture._id }).sort({ index: 1 }).lean();
    expect(topics.length).toBeGreaterThan(0);
    expect(topics[0]!.startSec).toBe(0);
    expect(topics.at(-1)!.endSec).toBe(done!.durationSec);
    expect(new Set(topics.map((t) => t.method))).toEqual(new Set(['fixed_window'])); // no embedder from C yet
    expect(await Summary.countDocuments({ lectureId: lecture._id })).toBe(topics.length);

    // Traceability: the raw provider response is kept beside the media.
    const raw = JSON.parse(await readFile(path.join(storageRoot, lecture.id, 'asr-response.json'), 'utf8'));
    expect(raw).toMatchObject({ provider: 'assemblyai', externalId: fixture.id, response: { id: fixture.id } });

    // And the API shows it: status view and the teacher's transcript.
    const app = buildApp();
    const status = await request(app).get(`/api/v1/lectures/${lecture.id}/status`).set(authHeader(teacher)).expect(200);
    expect(status.body).toMatchObject({ status: 'ready', progressPct: 100 });
    const transcript = await request(app).get(`/api/v1/lectures/${lecture.id}/transcript`).set(authHeader(teacher)).expect(200);
    expect(transcript.body.items).toHaveLength(segments.length);
    expect(transcript.body.items[0]).toMatchObject({ lectureId: lecture.id, index: 0, startSec: 1.234 });
  });

  it('falls back to Groq when AssemblyAI fails, and records which provider was used', async () => {
    const lecture = await lectureWithMedia(teacher._id, 'lecture.mp3', tone(20));
    asrProviders.assemblyai = failing('AssemblyAI 503 Service Unavailable');
    asrProviders.groq = fake(async () => ({ ...fixtureResult(), provider: 'groq', model: 'whisper-large-v3-turbo', modelVersion: 'groq-whisper-large-v3-turbo', externalId: null }));

    await processingPipeline.startProcessing(lecture.id);

    const done = await Lecture.findById(lecture._id);
    expect(done!.status).toBe('ready');
    expect(done!.provider).toMatchObject({ asr: 'groq', asrModel: 'whisper-large-v3-turbo', externalId: null });
    expect((await TranscriptSegment.findOne({ lectureId: lecture._id }))!.modelVersion).toBe('groq-whisper-large-v3-turbo');
  });

  it('both providers unconfigured → failed PROVIDER_UNAVAILABLE at transcribing, with a reason a teacher can act on', async () => {
    const lecture = await lectureWithMedia(teacher._id, 'lecture.mp3', tone(3)); // real providers, no API keys in tests
    await processingPipeline.startProcessing(lecture.id);
    const done = await Lecture.findById(lecture._id);
    expect(done).toMatchObject({ status: 'failed', error: { stage: 'transcribing', code: 'PROVIDER_UNAVAILABLE' } });
    expect(done!.statusDetail).toBe('Speech recognition is not configured on this server (no AssemblyAI or Groq API key).');
    expect(done!.stages.map((s) => s.state)).toEqual(['done', 'failed', 'skipped', 'skipped', 'skipped', 'skipped']);
    expect(await TranscriptSegment.countDocuments({ lectureId: lecture._id })).toBe(0);
  });

  it('a fragmented MP4 upload is rewritten in place as a browser-playable MP4 before extraction', async () => {
    // Regression: the player showed 1:42 for a 9:42 fragmented MP4 (moov declared duration 0).
    const lecture = await lectureWithMedia(teacher._id, 'talk.mp4', (p) =>
      ffmpeg(['-f', 'lavfi', '-i', 'testsrc=duration=4:size=64x64:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
        '-c:v', 'mpeg4', '-c:a', 'aac', '-shortest', '-movflags', 'frag_keyframe+empty_moov', p]),
    );
    const stored = path.join(storageRoot, lecture.mediaPath);
    expect(await mp4Layout(stored)).toMatchObject({ fragmented: true });
    asrProviders.assemblyai = fake(async () => fixtureResult());

    await processingPipeline.startProcessing(lecture.id);

    const done = await Lecture.findById(lecture._id);
    expect(done).toMatchObject({ status: 'ready', mediaPath: lecture.mediaPath }); // same path, served as before
    expect(done!.durationSec).toBeCloseTo(4, 0);
    expect(await mp4Layout(stored)).toEqual({ fragmented: false, moovFirst: true });
  });

  it('a video with no audio track → failed NO_AUDIO_STREAM at extracting; ASR is never called', async () => {
    const lecture = await lectureWithMedia(teacher._id, 'clip.mkv', (p) =>
      ffmpeg(['-f', 'lavfi', '-i', 'testsrc=duration=1:size=64x64:rate=5', '-c:v', 'mjpeg', p]),
    );
    asrProviders.assemblyai = fake(async () => fixtureResult());
    await processingPipeline.startProcessing(lecture.id);
    expect(await Lecture.findById(lecture._id)).toMatchObject({ status: 'failed', error: { stage: 'extracting', code: 'NO_AUDIO_STREAM' } });
    expect(asrProviders.assemblyai.transcribe).not.toHaveBeenCalled();
  });

  it('provider output that fails validation → TRANSCRIPTION_FAILED, and nothing is stored', async () => {
    const lecture = await lectureWithMedia(teacher._id, 'lecture.mp3', tone(5));
    asrProviders.assemblyai = fake(async () => ({
      ...fixtureResult(),
      segments: [
        { startSec: 0, endSec: 2, text: 'one', confidence: 0.9 },
        { startSec: 1.5, endSec: 3, text: 'overlaps', confidence: 0.9 },
      ],
    }));
    await processingPipeline.startProcessing(lecture.id);
    const done = await Lecture.findById(lecture._id);
    expect(done).toMatchObject({ status: 'failed', error: { stage: 'transcribing', code: 'TRANSCRIPTION_FAILED' } });
    expect(done!.statusDetail).toMatch(/Overlapping transcript segments at indexes 0 and 1/);
    expect(await TranscriptSegment.countDocuments({ lectureId: lecture._id })).toBe(0);
  });

  it('reprocessing from chunking keeps the transcript (and its corrections) and does not call ASR again', async () => {
    const lecture = await lectureWithMedia(teacher._id, 'lecture.mp3', tone(24));
    asrProviders.assemblyai = fake(async () => fixtureResult());
    await processingPipeline.startProcessing(lecture.id);
    const before = await TranscriptSegment.find({ lectureId: lecture._id }).sort({ index: 1 });
    before[0]!.text = 'Corrected by the teacher.';
    await before[0]!.save();

    await processingPipeline.startProcessing(lecture.id, { fromStage: 'chunking' });

    const after = await TranscriptSegment.find({ lectureId: lecture._id }).sort({ index: 1 });
    expect(after.map((s) => String(s._id))).toEqual(before.map((s) => String(s._id)));
    expect(after[0]).toMatchObject({ text: 'Corrected by the teacher.', corrected: true });
    expect(asrProviders.assemblyai.transcribe).toHaveBeenCalledTimes(1);
    expect((await Lecture.findById(lecture._id))!.status).toBe('ready');
  });

  it('a lecture deleted while processing is not resurrected, and nothing throws', async () => {
    const lecture = await lectureWithMedia(teacher._id, 'lecture.mp3', tone(3));
    asrProviders.assemblyai = fake(async () => {
      await Lecture.deleteOne({ _id: lecture._id });
      return fixtureResult();
    });
    await expect(processingPipeline.startProcessing(lecture.id)).resolves.toBeUndefined();
    expect(await Lecture.countDocuments({ _id: lecture._id })).toBe(0);
    expect(await TranscriptSegment.countDocuments({ lectureId: lecture._id })).toBe(0);
  });
});

describe('robustness (PA.2)', () => {
  afterEach(() => {
    glossarySettings.enabled = false;
  });

  it('a second startProcessing while a run is in progress logs and returns: one ASR call, no duplicate segments', async () => {
    const lecture = await lectureWithMedia(teacher._id, 'lecture.mp3', tone(24)); // longer than the fixture transcript
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    asrProviders.assemblyai = fake(async () => {
      await gate;
      return fixtureResult();
    });
    const warn = vi.spyOn(logger, 'warn');

    const first = processingPipeline.startProcessing(lecture.id);
    await vi.waitFor(() => expect(asrProviders.assemblyai.transcribe).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    await processingPipeline.startProcessing(lecture.id); // returns at once
    release();
    await first;

    expect(asrProviders.assemblyai.transcribe).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/already in progress/), expect.objectContaining({ lectureId: lecture.id }));
    const indexes = (await TranscriptSegment.find({ lectureId: lecture._id }).lean()).map((s) => s.index);
    expect(indexes).toEqual([...new Set(indexes)]);
    expect(indexes).toHaveLength(fixtureResult().segments.length);
  });

  it('re-running from transcribing deletes the old segments BEFORE asking the provider again', async () => {
    const lecture = await lectureWithMedia(teacher._id, 'lecture.mp3', tone(24));
    asrProviders.assemblyai = fake(async () => fixtureResult());
    await processingPipeline.startProcessing(lecture.id);
    const oldIds = (await TranscriptSegment.find({ lectureId: lecture._id })).map((s) => String(s._id));

    let segmentsWhileTranscribing = -1;
    asrProviders.assemblyai = fake(async () => {
      segmentsWhileTranscribing = await TranscriptSegment.countDocuments({ lectureId: lecture._id });
      return { ...fixtureResult(), segments: fixtureResult().segments.slice(0, 2) };
    });
    await processingPipeline.startProcessing(lecture.id, { fromStage: 'transcribing' });

    expect(segmentsWhileTranscribing).toBe(0);
    const now = await TranscriptSegment.find({ lectureId: lecture._id }).sort({ index: 1 });
    expect(now.map((s) => s.index)).toEqual([0, 1]); // only the new transcript
    expect(now.some((s) => oldIds.includes(String(s._id)))).toBe(false);
  });

  it('ASR_USE_GLOSSARY: off → no keyterms; on → exactly the glossary, recorded with the raw response', async () => {
    const seen: Array<string[] | undefined> = [];
    asrProviders.assemblyai = fake(async (_audio, opts) => {
      seen.push(opts.keyterms);
      return fixtureResult();
    });
    const off = await lectureWithMedia(teacher._id, 'lecture.mp3', tone(4));
    await processingPipeline.startProcessing(off.id);
    glossarySettings.enabled = true;
    const on = await lectureWithMedia(teacher._id, 'lecture.mp3', tone(4));
    await processingPipeline.startProcessing(on.id);

    const glossary = await loadGlossary();
    expect(glossary.length).toBeGreaterThanOrEqual(40);
    expect(seen).toEqual([undefined, glossary]);
    const raw = JSON.parse(await readFile(path.join(storageRoot, on.id, 'asr-response.json'), 'utf8'));
    expect(raw.keyterms).toEqual(glossary);
  });

  it('the status endpoint reports the real per-stage ms measured during the run', async () => {
    const lecture = await lectureWithMedia(teacher._id, 'lecture.mp3', tone(24));
    asrProviders.assemblyai = fake(async () => {
      await new Promise((r) => setTimeout(r, 120)); // transcription takes ≥ 120 ms
      return fixtureResult();
    });
    await processingPipeline.startProcessing(lecture.id);
    const res = await request(buildApp()).get(`/api/v1/lectures/${lecture.id}/status`).set(authHeader(teacher)).expect(200);
    const ms = Object.fromEntries(res.body.stages.map((s: { name: string; ms: number | null }) => [s.name, s.ms]));
    expect(ms.extracting).toBeGreaterThan(0);
    expect(ms.transcribing).toBeGreaterThanOrEqual(120);
    for (const stage of ['chunking', 'segmenting', 'summarising']) expect(typeof ms[stage]).toBe('number');
    expect(ms.indexing).toBeNull(); // skipped until Member C
    const stored = await Lecture.findById(lecture._id);
    expect(stored!.stages.find((s) => s.name === 'transcribing')!.ms).toBe(ms.transcribing);
  });
});

describe('persistTranscription', () => {
  it('stores contiguous 0-based indexes, rejects an empty transcript, and keeps segments inside the recording', async () => {
    const lecture = await lectureWithMedia(teacher._id, 'lecture.mp3', tone(1));
    await expect(persistTranscription(lecture.id, { ...fixtureResult(), segments: [] })).rejects.toBeInstanceOf(TranscriptValidationError);

    const count = await persistTranscription(lecture.id, fixtureResult(), { durationSec: 10 });
    const stored = await TranscriptSegment.find({ lectureId: lecture._id }).sort({ index: 1 }).lean();
    expect(stored).toHaveLength(count);
    expect(stored.map((s) => s.index)).toEqual(stored.map((_, i) => i));
    expect(Math.max(...stored.map((s) => s.endSec))).toBeLessThanOrEqual(10);
    expect(existsSync(path.join(storageRoot, lecture.id, 'asr-response.json'))).toBe(true);
  });
});
