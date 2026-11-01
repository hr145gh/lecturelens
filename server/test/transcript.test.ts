import { Types } from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { Lecture, TranscriptSegment, User, initialStages } from '../src/models/index.js';
import { signToken } from '../src/modules/auth/tokens.js';
import { resetDb } from './setup.js';

const ids = {
  teacher: new Types.ObjectId(),
  otherTeacher: new Types.ObjectId(),
  student: new Types.ObjectId(),
};

const token = (role: 'teacher' | 'student', id: Types.ObjectId) =>
  `Bearer ${signToken(String(id), role)}`;

const auth = {
  teacher: () => ({ Authorization: token('teacher', ids.teacher) }),
  otherTeacher: () => ({ Authorization: token('teacher', ids.otherTeacher) }),
  student: () => ({ Authorization: token('student', ids.student) }),
};

const MP3_SIZE = 1024;

async function createLecture(
  owner = ids.teacher,
  overrides: Record<string, unknown> = {},
) {
  return Lecture.create({
    title: 'Transcript test lecture',
    uploadedBy: owner,
    consent: {
      lecturerConsent: true,
      purposeShown: true,
      processorNamed: true,
      grantedBy: owner,
      grantedAt: new Date(),
    },
    status: 'ready',
    statusDetail: 'Ready.',
    stages: initialStages().map((stage) => ({
      ...stage,
      state: 'done',
      ms: 100,
    })),
    mediaPath: 'placeholder/audio.mp3',
    media: {
      originalFilename: 'audio.mp3',
      mimeType: 'audio/mpeg',
      sizeBytes: MP3_SIZE,
    },
    transcriptApproved: false,
    ...overrides,
  });
}

async function createSegment(lectureId: Types.ObjectId, index = 0) {
  return TranscriptSegment.create({
    lectureId,
    index,
    startSec: index * 2,
    endSec: index * 2 + 1.5,
    text: `Original sentence ${index}`,
    confidence: 0.95,
    lowConfidence: false,
    speaker: null,
    corrected: false,
    originalText: null,
    correctedBy: null,
    correctedAt: null,
    modelVersion: 'test-model',
  });
}

describe('Transcript routes', () => {
  let lectureId: Types.ObjectId;

  beforeEach(async () => {
    await resetDb();

    await User.create([
      {
        _id: ids.teacher,
        email: 'transcript-teacher@example.edu',
        name: 'Transcript Teacher',
        role: 'teacher',
        passwordHash: 'x',
      },
      {
        _id: ids.otherTeacher,
        email: 'transcript-other@example.edu',
        name: 'Other Teacher',
        role: 'teacher',
        passwordHash: 'x',
      },
      {
        _id: ids.student,
        email: 'transcript-student@example.edu',
        name: 'Transcript Student',
        role: 'student',
        passwordHash: 'x',
      },
    ]);

    const lecture = await createLecture();
    lectureId = lecture._id as Types.ObjectId;
    await createSegment(lectureId);
  });

  it('lets the owner read their transcript in index order', async () => {
    await createSegment(lectureId, 1);

    const res = await request(app)
      .get(`/api/v1/lectures/${lectureId}/transcript`)
      .set(auth.teacher())
      .expect(200);

    expect(res.body).toMatchObject({
      lectureId: String(lectureId),
      transcriptApproved: false,
    });
    expect(res.body.items.map((item: { index: number }) => item.index)).toEqual([0, 1]);
  });

  it('returns 404 when another teacher reads the lecture transcript', async () => {
    await request(app)
      .get(`/api/v1/lectures/${lectureId}/transcript`)
      .set(auth.otherTeacher())
      .expect(404);
  });

  it('blocks students from reading an unapproved transcript', async () => {
    const res = await request(app)
      .get(`/api/v1/lectures/${lectureId}/transcript`)
      .set(auth.student())
      .expect(403);

    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(res.body.error.details).toEqual({ reason: 'TRANSCRIPT_NOT_APPROVED' });
  });

  it('lets students read a ready, approved transcript', async () => {
    await Lecture.updateOne({ _id: lectureId }, { transcriptApproved: true });

    const res = await request(app)
      .get(`/api/v1/lectures/${lectureId}/transcript`)
      .set(auth.student())
      .expect(200);

    expect(res.body.items).toHaveLength(1);
  });

  it('PATCH twice with different text keeps the FIRST originalText (the ASR text) — audit trail', async () => {
    const patch = (text: string) =>
      request(app).patch(`/api/v1/lectures/${lectureId}/segments/0`).set(auth.teacher()).send({ text }).expect(200);
    await patch('First correction.');
    const second = await patch('Second correction.');
    expect(second.body.segment).toMatchObject({ text: 'Second correction.', originalText: 'Original sentence 0', corrected: true });
    const stored = await TranscriptSegment.findOne({ lectureId, index: 0 });
    expect(stored?.originalText).toBe('Original sentence 0');
  });

  it('PATCH as a student → 403, and the segment is unchanged', async () => {
    const res = await request(app)
      .patch(`/api/v1/lectures/${lectureId}/segments/0`)
      .set(auth.student())
      .send({ text: 'Student edit' })
      .expect(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect((await TranscriptSegment.findOne({ lectureId, index: 0 }))?.text).toBe('Original sentence 0');
  });

  it('every transcript item carries the contract fields, including lectureId (CONTRACTS.md §6.3)', async () => {
    const res = await request(app).get(`/api/v1/lectures/${lectureId}/transcript`).set(auth.teacher()).expect(200);
    expect(Object.keys(res.body.items[0]).sort()).toEqual(
      ['confidence', 'correctedAt', 'correctedBy', 'corrected', 'createdAt', 'endSec', 'id', 'index', 'lectureId', 'lowConfidence', 'modelVersion', 'originalText', 'speaker', 'startSec', 'text', 'updatedAt'].sort(),
    );
    expect(res.body.items[0].lectureId).toBe(String(lectureId));
  });

  it('lets the owner correct a segment and preserves its original text', async () => {
    const res = await request(app)
      .patch(`/api/v1/lectures/${lectureId}/segments/0`)
      .set(auth.teacher())
      .send({ text: 'Corrected sentence.' })
      .expect(200);

    expect(res.body.segment).toMatchObject({
      index: 0,
      text: 'Corrected sentence.',
      originalText: 'Original sentence 0',
      corrected: true,
      correctedBy: String(ids.teacher),
    });
    expect(res.body.segment.correctedAt).toBeTruthy();
  });

  it('preserves the original audit metadata when the same corrected text is submitted again', async () => {
    await request(app)
      .patch(`/api/v1/lectures/${lectureId}/segments/0`)
      .set(auth.teacher())
      .send({ text: 'Corrected sentence.' })
      .expect(200);


    const before = await TranscriptSegment.findOne({ lectureId, index: 0 });
    const originalText = before?.originalText;
    const correctedAt = before?.correctedAt?.toISOString();
    const correctedBy = String(before?.correctedBy);


    await request(app)
      .patch(`/api/v1/lectures/${lectureId}/segments/0`)
      .set(auth.teacher())
      .send({ text: 'Corrected sentence.' })
      .expect(200);

    const after = await TranscriptSegment.findOne({ lectureId, index: 0 });

    expect(after?.originalText).toBe(originalText);
    expect(after?.correctedAt?.toISOString()).toBe(correctedAt);
    expect(String(after?.correctedBy)).toBe(correctedBy);

  });
  it('returns 404 when another teacher edits a segment', async () => {
    await request(app)
      .patch(`/api/v1/lectures/${lectureId}/segments/0`)
      .set(auth.otherTeacher())
      .send({ text: 'Not allowed.' })
      .expect(404);
  });

  it('approves a ready transcript and keeps approval idempotent', async () => {
    const first = await request(app)
      .post(`/api/v1/lectures/${lectureId}/transcript/approve`)
      .set(auth.teacher())
      .expect(200);

    expect(first.body.lecture.transcriptApproved).toBe(true);
    expect(first.body.lecture.transcriptApprovedBy).toBe(String(ids.teacher));
    // Serialised like every lecture (§5.3): computed fields present, server-only fields absent.
    expect(first.body.lecture).toHaveProperty('uploadedByName');
    expect(first.body.lecture).toHaveProperty('topicCount');
    for (const serverOnly of ['mediaPath', 'audioPath', 'notes', 'stages', 'provider']) expect(first.body.lecture).not.toHaveProperty(serverOnly);

    const approvedAt = first.body.lecture.transcriptApprovedAt;

    const second = await request(app)
      .post(`/api/v1/lectures/${lectureId}/transcript/approve`)
      .set(auth.teacher())
      .expect(200);

    expect(second.body.lecture.transcriptApproved).toBe(true);
    expect(second.body.lecture.transcriptApprovedAt).toBe(approvedAt);
  });

  it('rejects approval until the lecture is ready', async () => {
    await Lecture.updateOne({ _id: lectureId }, { status: 'transcribing' });

    const res = await request(app)
      .post(`/api/v1/lectures/${lectureId}/transcript/approve`)
      .set(auth.teacher())
      .expect(409);

    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('rejects an invalid segment correction body', async () => {
    await request(app)
      .patch(`/api/v1/lectures/${lectureId}/segments/0`)
      .set(auth.teacher())
      .send({ text: '   ' })
      .expect(422);
  });
});
