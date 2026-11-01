import { existsSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import { Types } from 'mongoose';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/app.js';
import { storageRoot } from '../src/config/env.js';
import { errorHandler } from '../src/middleware/error.js';
import { requestId } from '../src/middleware/requestId.js';
import { mediaUpload } from '../src/middleware/upload.js';
import { Chunk, Lecture, TranscriptSegment, User, initialStages } from '../src/models/index.js';
import {
  processingPipeline,
  setPipeline,
  type ProcessingPipeline,
} from '../src/services/processing/pipeline.js';
import { resetDb } from './setup.js';
import { signToken } from '../src/modules/auth/tokens.js';


const ids = { teacher: new Types.ObjectId(), otherTeacher: new Types.ObjectId(), student: new Types.ObjectId() };
const token = (who: keyof typeof ids) => `Bearer ${signToken(String(ids[who]), who === 'student' ? 'student' : 'teacher')}`;

beforeEach(async () => {
  await resetDb();
  await User.create([
    { _id: ids.teacher, email: 't@example.edu', name: 'Dr. Ananya Rao', role: 'teacher', passwordHash: 'x' },
    { _id: ids.otherTeacher, email: 'o@example.edu', name: 'Dr. Other', role: 'teacher', passwordHash: 'x' },
    { _id: ids.student, email: 's@example.edu', name: 'Rohan Mehta', role: 'student', passwordHash: 'x' },
  ]);
});

afterEach(() => vi.restoreAllMocks());

/** Something every sniffing check accepts as MP3: an ID3 header. */
const MP3 = Buffer.concat([Buffer.from('ID3\u0004\u0000\u0000'), Buffer.alloc(2048, 1)]);

const consent = { lecturerConsent: 'true', purposeShown: 'true', processorNamed: 'true' };

function upload(fields: Record<string, string>, file?: { buffer: Buffer; name: string; type?: string }, who: keyof typeof ids = 'teacher') {
  const req = request(app).post('/api/v1/lectures').set('Authorization', token(who));
  for (const [k, v] of Object.entries(fields)) req.field(k, v);
  if (file) req.attach('file', file.buffer, { filename: file.name, contentType: file.type ?? 'audio/mpeg' });
  return req;
}

const storedEntries = async () => (existsSync(storageRoot) ? readdir(storageRoot) : []);

async function waitFor<T>(read: () => Promise<T>, done: (v: T) => boolean): Promise<T> {
  for (let i = 0; i < 50; i++) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('waitFor timed out');
}

/** A lecture in a given state, owned by `owner`. */
async function lectureDoc(over: Record<string, unknown> = {}, owner = ids.teacher) {
  return Lecture.create({
    title: 'Lecture 7 — Gradient Descent',
    uploadedBy: owner,
    consent: { lecturerConsent: true, purposeShown: true, processorNamed: true, grantedBy: owner, grantedAt: new Date() },
    status: 'ready',
    statusDetail: 'Ready.',
    stages: initialStages().map((s) => ({ ...s, state: 'done', ms: 1000 })),
    mediaPath: 'placeholder/a.mp3',
    media: { originalFilename: 'a.mp3', mimeType: 'audio/mpeg', sizeBytes: MP3.length },
    transcriptApproved: true,
    ...over,
  });
}

describe('POST /lectures — upload and the consent gate', () => {
  it('rejects an upload without lecturer consent with 422 and deletes the file', async () => {
    const res = await upload({ title: 'No consent', ...consent, lecturerConsent: 'false' }, { buffer: MP3, name: 'a.mp3' }).expect(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.details).toEqual({ 'consent.lecturerConsent': 'Lecturer consent is required' });
    expect(await storedEntries()).toEqual([]);
    expect(await Lecture.countDocuments()).toBe(0);
  });

  it('requires all three consent fields (sent after the file, so the file is written first, then removed)', async () => {
    const req = request(app).post('/api/v1/lectures').set('Authorization', token('teacher'));
    req.attach('file', MP3, { filename: 'a.mp3', contentType: 'audio/mpeg' });
    req.field('title', 'Late consent').field('lecturerConsent', 'true');
    const res = await req.expect(422);
    expect(res.body.error.details).toEqual({
      'consent.purposeShown': 'The purpose statement must be shown before consent',
      'consent.processorNamed': 'The third-party processors must be named before consent',
    });
    expect(await storedEntries()).toEqual([]);
  });

  it('rejects a .txt file with 415 UNSUPPORTED_MEDIA_TYPE naming the accepted formats', async () => {
    const res = await upload({ title: 'Notes', ...consent }, { buffer: Buffer.from('hello'), name: 'notes.txt', type: 'text/plain' }).expect(415);
    expect(res.body.error).toMatchObject({ code: 'UNSUPPORTED_MEDIA_TYPE', details: { mimeType: 'text/plain' } });
    expect(res.body.error.message).toMatch(/\.mp4, \.mkv, \.mov, \.webm, \.mp3, \.wav, \.m4a/);
    expect(await storedEntries()).toEqual([]);
  });

  it('rejects a renamed file whose content is not the claimed format (sniffing)', async () => {
    await upload({ title: 'Fake', ...consent }, { buffer: Buffer.from('just text, not audio'), name: 'fake.mp3' }).expect(415);
    expect(await storedEntries()).toEqual([]);
  });

  it('accepts an .mkv with an empty browser MIME type when the content is Matroska', async () => {
    const mkv = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64)]);
    const res = await upload({ title: 'MKV', ...consent }, { buffer: mkv, name: 'lec.mkv', type: 'application/octet-stream' }).expect(202);
    expect(res.body.lecture.media.mimeType).toBe('video/x-matroska');
  });

  it('rejects a student with 403 before anything is stored', async () => {
    const res = await upload({ title: 'Mine', ...consent }, { buffer: MP3, name: 'a.mp3' }, 'student').expect(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(await storedEntries()).toEqual([]);
  });

  it('returns 202 with status "uploaded", stores the file under STORAGE_DIR/<id>/, and the real pipeline fails an undecodable file honestly', async () => {
    setPipeline(processingPipeline); // real pipeline (needs ffmpeg/ffprobe); the bytes below are not real audio
    const res = await upload(
      { title: 'Lecture 11 — Attention', courseCode: 'CS 3410', recordedOn: '2026-10-28', ...consent },
      { buffer: MP3, name: '../../etc/evil name.mp3' },
    ).expect(202);
    const { lecture } = res.body;
    expect(lecture).toMatchObject({
      title: 'Lecture 11 — Attention',
      status: 'uploaded',
      recordedOn: '2026-10-28',
      uploadedBy: String(ids.teacher),
      uploadedByName: 'Dr. Ananya Rao',
      topicCount: null,
      transcriptApproved: false,
      consent: { lecturerConsent: true, purposeShown: true, processorNamed: true, grantedBy: String(ids.teacher) },
      media: { originalFilename: 'evil name.mp3', mimeType: 'audio/mpeg', sizeBytes: MP3.length },
    });
    for (const serverOnly of ['mediaPath', 'audioPath', 'notes', 'stages', 'provider']) expect(lecture).not.toHaveProperty(serverOnly);

    const files = await readdir(path.join(storageRoot, lecture.id));
    expect(files).toEqual([expect.stringMatching(/^[0-9a-f-]{36}\.mp3$/)]);

    const failed = await waitFor(() => Lecture.findById(lecture.id), (l) => l?.status === 'failed');
    expect(failed?.error).toMatchObject({ stage: 'extracting', code: 'UNSUPPORTED_CODEC' });
    expect(failed?.statusDetail).toMatch(/could not be decoded/);
  });

  it('translates multer LIMIT_FILE_SIZE into 413 with the configured limit', async () => {
    const small = express();
    small.use(requestId);
    small.post('/upload', mediaUpload({ maxMb: 1 }), (_req, res) => res.json({ ok: true }));
    small.use(errorHandler);
    const res = await request(small)
      .post('/upload')
      .attach('file', Buffer.alloc(1024 * 1024 + 1), { filename: 'big.mp3', contentType: 'audio/mpeg' })
      .expect(413);
    expect(res.body.error).toMatchObject({ code: 'PAYLOAD_TOO_LARGE', details: { maxMb: 1 } });
    expect(await storedEntries()).toEqual([]);
  });
});

describe('GET /lectures and /lectures/:id — visibility', () => {
  beforeEach(async () => {
    await lectureDoc({ title: 'Ready and approved' });
    await lectureDoc({ title: 'Ready, transcript not approved', transcriptApproved: false });
    await lectureDoc({ title: 'Still transcribing', status: 'transcribing', transcriptApproved: false });
    await lectureDoc({ title: 'Another teacher', }, ids.otherTeacher);
  });

  it('shows a student only ready + transcript-approved lectures', async () => {
    const res = await request(app).get('/api/v1/lectures').set('Authorization', token('student')).expect(200);
    expect(res.body.items.map((l: { title: string }) => l.title).sort()).toEqual(['Another teacher', 'Ready and approved']);
    expect(res.body).toMatchObject({ page: 1, limit: 20, total: 2 });
  });

  it('shows a teacher only their own, with status / q filters and pagination', async () => {
    const all = await request(app).get('/api/v1/lectures').set('Authorization', token('teacher')).expect(200);
    expect(all.body.total).toBe(3);
    const filtered = await request(app).get('/api/v1/lectures?status=transcribing&q=TRANSCRIB').set('Authorization', token('teacher')).expect(200);
    expect(filtered.body.items.map((l: { title: string }) => l.title)).toEqual(['Still transcribing']);
    const paged = await request(app).get('/api/v1/lectures?page=2&limit=2').set('Authorization', token('teacher')).expect(200);
    expect(paged.body).toMatchObject({ page: 2, limit: 2, total: 3 });
    expect(paged.body.items).toHaveLength(1);
  });

  it('rejects out-of-range paging with 422', async () => {
    const res = await request(app).get('/api/v1/lectures?limit=101&page=0').set('Authorization', token('teacher')).expect(422);
    expect(res.body.error.details).toEqual({ page: 'Must be an integer 1–9007199254740991', limit: 'Must be an integer 1–100' });
  });

  it('answers 404 (not 403) for a lecture the caller may not see, and 404 for a malformed id', async () => {
    const hidden = await Lecture.findOne({ title: 'Still transcribing' });
    await request(app).get(`/api/v1/lectures/${hidden?.id}`).set('Authorization', token('student')).expect(404);
    await request(app).get(`/api/v1/lectures/${hidden?.id}`).set('Authorization', token('otherTeacher')).expect(404);
    const bad = await request(app).get('/api/v1/lectures/not-an-id').set('Authorization', token('teacher')).expect(404);
    expect(bad.body.error.code).toBe('NOT_FOUND');
  });

  it('returns { lecture, mediaUrl } and serves the media through the signed URL with Range', async () => {
    const lecture = await lectureDoc({ title: 'Playable' });
    await mkdir(path.join(storageRoot, lecture.id), { recursive: true });
    await writeFile(path.join(storageRoot, lecture.id, 'a.mp3'), MP3);
    await Lecture.updateOne({ _id: lecture._id }, { mediaPath: `${lecture.id}/a.mp3` });

    const res = await request(app).get(`/api/v1/lectures/${lecture.id}`).set('Authorization', token('student')).expect(200);
    expect(res.body.mediaUrl).toMatch(new RegExp(`^/api/v1/lectures/${lecture.id}/media\\?exp=\\d+&sig=[0-9a-f]{64}$`));

    const partial = await request(app).get(res.body.mediaUrl).set('Range', 'bytes=0-2').expect(206);
    expect(partial.headers['content-range']).toBe(`bytes 0-2/${MP3.length}`);
    expect(Buffer.from(partial.body).toString('latin1')).toBe('ID3');
    expect(partial.headers['cross-origin-resource-policy']).toBe('cross-origin');
    const refused = await request(app).get(res.body.mediaUrl.replace(/sig=[0-9a-f]/, 'sig=0')).expect(401);
    // Errors too, or the browser blocks the response outright instead of reporting the status.
    expect(refused.headers['cross-origin-resource-policy']).toBe('cross-origin');
  });
});

describe('GET /lectures/:id/status', () => {
  it('returns the six stages derived from status, with progress', async () => {
    const lecture = await lectureDoc({ status: 'transcribing', transcriptApproved: false });
    const res = await request(app).get(`/api/v1/lectures/${lecture.id}/status`).set('Authorization', token('teacher')).expect(200);
    expect(res.body).toMatchObject({ lectureId: lecture.id, status: 'transcribing', error: null, progressPct: 17 });
    expect(res.body.stages.map((s: { name: string; state: string }) => `${s.name}:${s.state}`)).toEqual([
      'extracting:done',
      'transcribing:running',
      'chunking:pending',
      'segmenting:pending',
      'summarising:pending',
      'indexing:pending',
    ]);
  });

  it('is owner-only: a student gets 403, another teacher 404', async () => {
    const lecture = await lectureDoc();
    await request(app).get(`/api/v1/lectures/${lecture.id}/status`).set('Authorization', token('student')).expect(403);
    await request(app).get(`/api/v1/lectures/${lecture.id}/status`).set('Authorization', token('otherTeacher')).expect(404);
  });
});

describe('POST /lectures/:id/reprocess', () => {
  it('called twice does not error and starts only one run', async () => {
    const calls: unknown[] = [];
    const slow: ProcessingPipeline = { startProcessing: async (...args) => void calls.push(args) }; // never finishes
    setPipeline(slow);
    const lecture = await lectureDoc();
    const first = await request(app).post(`/api/v1/lectures/${lecture.id}/reprocess?fromStage=transcribing`).set('Authorization', token('teacher')).expect(202);
    const second = await request(app).post(`/api/v1/lectures/${lecture.id}/reprocess`).send({ fromStage: 'transcribing' }).set('Authorization', token('teacher')).expect(202);
    expect(first.body.lecture.status).toBe('transcribing');
    expect(second.body.lecture.status).toBe('transcribing');
    expect(first.body.lecture.transcriptApproved).toBe(false);
    expect(calls).toEqual([[lecture.id, { fromStage: 'transcribing' }]]);
  });

  it('with the real pipeline, two calls both succeed and a lecture whose media is unusable ends failed, never faked as ready', async () => {
    setPipeline(processingPipeline);
    const lecture = await lectureDoc(); // mediaPath points at no real file
    await request(app).post(`/api/v1/lectures/${lecture.id}/reprocess`).set('Authorization', token('teacher')).expect(202);
    await waitFor(() => Lecture.findById(lecture.id), (l) => l?.status === 'failed');
    await request(app).post(`/api/v1/lectures/${lecture.id}/reprocess`).set('Authorization', token('teacher')).expect(202);
    const settled = await waitFor(() => Lecture.findById(lecture.id), (l) => l?.status === 'failed');
    expect(settled?.error).toMatchObject({ stage: 'extracting', code: 'UNSUPPORTED_CODEC' });
  });

  it('discards derived data from the restart stage on', async () => {
    setPipeline({ startProcessing: async () => undefined });
    const lecture = await lectureDoc();
    const lectureId = lecture._id;
    await TranscriptSegment.create({ lectureId, index: 0, startSec: 0, endSec: 1, text: 'hi', confidence: 0.9, lowConfidence: false, modelVersion: 'm' });
    await Chunk.create({ lectureId, index: 0, startSec: 0, endSec: 1, text: 'hi', segmentStart: 0, segmentEnd: 0, embeddingModel: 'm' });
    await request(app).post(`/api/v1/lectures/${lecture.id}/reprocess`).send({ fromStage: 'chunking' }).set('Authorization', token('teacher')).expect(202);
    expect(await TranscriptSegment.countDocuments({ lectureId })).toBe(1); // kept: corrections survive
    expect(await Chunk.countDocuments({ lectureId })).toBe(0);
  });

  it('answers 409 while a different run is in progress, 422 for an unknown stage', async () => {
    const lecture = await lectureDoc({ status: 'chunking', transcriptApproved: false });
    const busy = await request(app).post(`/api/v1/lectures/${lecture.id}/reprocess`).set('Authorization', token('teacher')).expect(409);
    expect(busy.body.error.details).toEqual({ status: 'chunking' });
    await request(app).post(`/api/v1/lectures/${lecture.id}/reprocess`).send({ fromStage: 'baking' }).set('Authorization', token('teacher')).expect(422);
  });
});

describe('DELETE /lectures/:id', () => {
  it('another teacher gets 404 (existence not revealed), a student 403', async () => {
    const lecture = await lectureDoc();
    const res = await request(app).delete(`/api/v1/lectures/${lecture.id}`).set('Authorization', token('otherTeacher')).expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    await request(app).delete(`/api/v1/lectures/${lecture.id}`).set('Authorization', token('student')).expect(403);
    expect(await Lecture.countDocuments()).toBe(1);
  });

  it('the owner deletes the lecture, its derived documents and its media directory', async () => {
    const created = await upload({ title: 'To delete', ...consent }, { buffer: MP3, name: 'a.mp3' }).expect(202);
    const id = created.body.lecture.id as string;
    await TranscriptSegment.create({ lectureId: id, index: 0, startSec: 0, endSec: 1, text: 'hi', confidence: 0.9, lowConfidence: false, modelVersion: 'm' });
    expect(existsSync(path.join(storageRoot, id))).toBe(true);

    await request(app).delete(`/api/v1/lectures/${id}`).set('Authorization', token('teacher')).expect(204);
    expect(await Lecture.countDocuments({ _id: id })).toBe(0);
    expect(await TranscriptSegment.countDocuments({ lectureId: id })).toBe(0);
    expect(existsSync(path.join(storageRoot, id))).toBe(false);
  });

  it('keeps the lecture and logs when a derived collection fails to delete', async () => {
    const lecture = await lectureDoc();
    vi.spyOn(Chunk, 'deleteMany').mockRejectedValueOnce(new Error('disk on fire'));
    const res = await request(app).delete(`/api/v1/lectures/${lecture.id}`).set('Authorization', token('teacher')).expect(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
    expect(await Lecture.countDocuments({ _id: lecture._id })).toBe(1);
    vi.restoreAllMocks();
  });
});
