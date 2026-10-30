
import request from 'supertest';
import { Types } from 'mongoose';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/services/retrieval/keyword.js', () => ({
  keywordSearch: vi.fn(),
}));

vi.mock('../src/services/retrieval/vector.js', () => ({
  vectorSearch: vi.fn(),
}));

vi.mock('../src/services/retrieval/hybrid.js', () => ({
  hybridSearch: vi.fn(),
}));

import { app } from '../src/app.js';
import { Lecture, initialStages, type ILecture } from '../src/models/index.js';
import { keywordSearch } from '../src/services/retrieval/keyword.js';
import { vectorSearch } from '../src/services/retrieval/vector.js';
import { hybridSearch } from '../src/services/retrieval/hybrid.js';
import {
  authHeader,
  makeStudent,
  makeTeacher,
  resetDb,
} from './setup.js';

async function createLecture(
  ownerId: Types.ObjectId,
  overrides: Partial<ILecture> = {},
) {
  return Lecture.create({
    title: 'Lecture 7 — Gradient Descent',
    uploadedBy: ownerId,
    consent: {
      lecturerConsent: true,
      purposeShown: true,
      processorNamed: true,
      grantedBy: ownerId,
      grantedAt: new Date(),
    },
    status: 'ready',
    statusDetail: 'Ready.',
    stages: initialStages().map((stage) => ({
      ...stage,
      state: 'done',
      ms: 1000,
    })),
    mediaPath: 'placeholder/lecture.mp3',
    media: {
      originalFilename: 'lecture.mp3',
      mimeType: 'audio/mpeg',
      sizeBytes: 2048,
    },
    transcriptApproved: true,
    ...overrides,
  });
}

function resultFor(lectureId: string) {
  return {
    chunkId: '6650c3a0c3b2e41d8a400001',
    lectureId,
    startSec: 30,
    endSec: 75,
    text: 'A large learning rate can cause the loss to diverge.',
    score: 0.75,
  };
}

describe('POST /api/v1/search', () => {
  beforeEach(async () => {
    await resetDb();
    vi.resetAllMocks();
  });

  it('requires authentication', async () => {
    await request(app)
      .post('/api/v1/search')
      .send({ query: 'learning rate' })
      .expect(401);
  });

  it.each([
    [{ query: '' }],
    [{ query: '   ' }],
    [{ query: 'learning rate', topK: 0 }],
    [{ query: 'learning rate', topK: 21 }],
    [{ query: 'learning rate', topK: 1.5 }],
    [{ query: 'learning rate', retriever: 'magic' }],
    [{ query: 'learning rate', unexpected: true }],
  ])('rejects invalid search input: %o', async (body) => {
    const student = await makeStudent();

    await request(app)
      .post('/api/v1/search')
      .set(authHeader(student))
      .send(body)
      .expect(422);
  });

  it('returns an empty list when no lectures are visible', async () => {
    const student = await makeStudent();

    const response = await request(app)
      .post('/api/v1/search')
      .set(authHeader(student))
      .send({ query: 'learning rate' })
      .expect(200);

    expect(response.body).toMatchObject({
      query: 'learning rate',
      retriever: 'hybrid',
      items: [],
    });
    expect(response.body.tookMs).toEqual(expect.any(Number));
    expect(hybridSearch).not.toHaveBeenCalled();
  });

  it.each(['keyword', 'vector', 'hybrid'] as const)(
    'dispatches to the %s retriever and returns contract-shaped results',
    async (selectedRetriever) => {
      const teacher = await makeTeacher();
      const lecture = await createLecture(teacher._id);
      const student = await makeStudent();
      const result = resultFor(String(lecture._id));

      vi.mocked(keywordSearch).mockResolvedValue([result]);
      vi.mocked(vectorSearch).mockResolvedValue([result]);
      vi.mocked(hybridSearch).mockResolvedValue([result]);

      const response = await request(app)
        .post('/api/v1/search')
        .set(authHeader(student))
        .send({
          query: 'learning rate',
          lectureId: String(lecture._id),
          retriever: selectedRetriever,
          topK: 5,
        })
        .expect(200);

      expect(response.body.query).toBe('learning rate');
      expect(response.body.retriever).toBe(selectedRetriever);
      expect(response.body.tookMs).toEqual(expect.any(Number));

      expect(response.body.items).toEqual([
        {
          ...result,
          lectureTitle: lecture.title,
          retriever: selectedRetriever,
          rank: 1,
          deepLink: `/lectures/${lecture._id}/play?t=30`,
        },
      ]);

      const expectedArguments = {
        query: 'learning rate',
        allowedLectureIds: [String(lecture._id)],
        k: 5,
      };

      if (selectedRetriever === 'keyword') {
        expect(keywordSearch).toHaveBeenCalledWith(expectedArguments);
        expect(vectorSearch).not.toHaveBeenCalled();
        expect(hybridSearch).not.toHaveBeenCalled();
      } else if (selectedRetriever === 'vector') {
        expect(vectorSearch).toHaveBeenCalledWith(expectedArguments);
        expect(keywordSearch).not.toHaveBeenCalled();
        expect(hybridSearch).not.toHaveBeenCalled();
      } else {
        expect(hybridSearch).toHaveBeenCalledWith(expectedArguments);
        expect(keywordSearch).not.toHaveBeenCalled();
        expect(vectorSearch).not.toHaveBeenCalled();
      }
    },
  );

  it('defaults retriever to hybrid and topK to 5', async () => {
    const teacher = await makeTeacher();
    const lecture = await createLecture(teacher._id);
    const student = await makeStudent();

    vi.mocked(hybridSearch).mockResolvedValue([]);

    await request(app)
      .post('/api/v1/search')
      .set(authHeader(student))
      .send({
        query: 'learning rate',
        lectureId: String(lecture._id),
      })
      .expect(200);

    expect(hybridSearch).toHaveBeenCalledWith({
      query: 'learning rate',
      allowedLectureIds: [String(lecture._id)],
      k: 5,
    });
  });

  it('lets students search ready, approved lectures only', async () => {
    const teacher = await makeTeacher();

    const visible = await createLecture(teacher._id);

    const unapproved = await createLecture(teacher._id, {
      title: 'Not approved',
      transcriptApproved: false,
    });

    const processing = await createLecture(teacher._id, {
      title: 'Still processing',
      status: 'transcribing',
      transcriptApproved: false,
    });

    const student = await makeStudent();

    vi.mocked(keywordSearch).mockResolvedValue([
      resultFor(String(visible._id)),
    ]);

    const response = await request(app)
      .post('/api/v1/search')
      .set(authHeader(student))
      .send({
        query: 'learning rate',
        retriever: 'keyword',
      })
      .expect(200);

    expect(keywordSearch).toHaveBeenCalledWith({
      query: 'learning rate',
      allowedLectureIds: [String(visible._id)],
      k: 5,
    });

    expect(
      response.body.items.map((item: { lectureId: string }) => item.lectureId),
    ).toEqual([String(visible._id)]);

    const hiddenIds = [
      String(unapproved._id),
      String(processing._id),
    ];

    expect(
      response.body.items.some((item: { lectureId: string }) =>
        hiddenIds.includes(item.lectureId),
      ),
    ).toBe(false);
  });

  it('returns 404 for a lecture that is not visible to the student', async () => {
    const teacher = await makeTeacher();
    const unapproved = await createLecture(teacher._id, {
      transcriptApproved: false,
    });
    const student = await makeStudent();

    await request(app)
      .post('/api/v1/search')
      .set(authHeader(student))
      .send({
        query: 'learning rate',
        lectureId: String(unapproved._id),
      })
      .expect(404);

    expect(hybridSearch).not.toHaveBeenCalled();
  });

  it('returns 404 for a nonexistent lecture ID', async () => {
    const student = await makeStudent();

    await request(app)
      .post('/api/v1/search')
      .set(authHeader(student))
      .send({
        query: 'learning rate',
        lectureId: '6650c3a0c3b2e41d8a100001',
      })
      .expect(404);
  });
});
