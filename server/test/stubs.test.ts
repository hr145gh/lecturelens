import { Types } from 'mongoose';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { User } from '../src/models/index.js';
import { signToken } from '../src/modules/auth/tokens.js';
import { resetDb } from './setup.js';

/** Every A/B/C route is mounted with real guards + validation and answers 501 (CONTRACTS.md §7). */

const teacherId = new Types.ObjectId();
const studentId = new Types.ObjectId();
const teacher = `Bearer ${signToken(String(teacherId), 'teacher')}`;
const student = `Bearer ${signToken(String(studentId), 'student')}`;

beforeAll(async () => {
  await resetDb();
  await User.create([
    { _id: teacherId, email: 't@example.edu', name: 'Dr. Ananya Rao', role: 'teacher', passwordHash: 'x' },
    { _id: studentId, email: 's@example.edu', name: 'Rohan Mehta', role: 'student', passwordHash: 'x' },
  ]);
});

const L = '6650c3a0c3b2e41d8a100001';
const ID = '6650c3a0c3b2e41d8a400000';

type Method = 'get' | 'post' | 'patch';
interface Stub {
  method: Method;
  path: string;
  body?: object;
  owner: 'A' | 'B' | 'C';
  prompt: string;
  feature: string;
  teacherOnly: boolean;
}

const STUBS: Stub[] = [
  // Live since Member B's PB.1/PB.2 (not stubs any more): GET /lectures/:id/topics, PATCH /topics/:id,
  // POST /topics/:id/approve, GET /lectures/:id/summaries, POST /summaries/:id/approve — see rbac.test.ts.
  { method: 'post', path: `/topics/${ID}/reject`, body: { rejectionReason: 'AMBIGUOUS', reviewNote: null }, owner: 'B', prompt: 'PB.1', feature: 'Topic rejection', teacherOnly: true },
  { method: 'patch', path: `/summaries/${ID}`, body: { keyPoints: ['One.', 'Two.'] }, owner: 'B', prompt: 'PB.2', feature: 'Summary editing', teacherOnly: true },
  { method: 'post', path: `/summaries/${ID}/reject`, body: { rejectionReason: 'UNSUPPORTED' }, owner: 'B', prompt: 'PB.2', feature: 'Summary rejection', teacherOnly: true },
  { method: 'post', path: '/ask', body: { question: 'Why does the loss blow up?' }, owner: 'C', prompt: 'PC.2', feature: 'Grounded Q&A', teacherOnly: false },
  { method: 'post', path: `/lectures/${L}/questions/generate`, body: { count: 3, difficulty: 'medium' }, owner: 'C', prompt: 'PC.3', feature: 'Question generation', teacherOnly: true },
  { method: 'get', path: `/questions?lectureId=${L}&status=pending_review`, owner: 'C', prompt: 'PC.3', feature: 'The question bank', teacherOnly: true },
  { method: 'patch', path: `/questions/${ID}`, body: { status: 'rejected', rejectionReason: 'TOO_EASY' }, owner: 'C', prompt: 'PC.3', feature: 'Question review', teacherOnly: true },
  { method: 'post', path: '/quizzes', body: { lectureId: L, questionCount: 5 }, owner: 'C', prompt: 'PC.3', feature: 'Quiz creation', teacherOnly: false },
  { method: 'get', path: `/quizzes?lectureId=${L}`, owner: 'C', prompt: 'PC.3', feature: 'The quiz list', teacherOnly: false },
  {
    method: 'post',
    path: `/quizzes/${ID}/attempts`,
    body: { startedAt: '2026-10-26T18:31:02.118Z', answers: [{ questionId: ID, selectedOptionId: 'b' }, { questionId: L, selectedOptionId: null }] },
    owner: 'C',
    prompt: 'PC.3',
    feature: 'Quiz attempts',
    teacherOnly: false,
  },
  { method: 'get', path: `/attempts/${ID}`, owner: 'C', prompt: 'PC.3', feature: 'Attempt results', teacherOnly: false },
  { method: 'get', path: `/revision-plan?lectureId=${L}`, owner: 'C', prompt: 'PC.3', feature: 'The revision plan', teacherOnly: false },
];

const call = (stub: Stub, auth?: string) => {
  const req = request(app)[stub.method](`/api/v1${stub.path}`);
  if (auth) req.set('Authorization', auth);
  return stub.body ? req.send(stub.body) : req;
};

describe('A/B/C stub routes', () => {
  it.each(STUBS.map((s) => [`${s.method.toUpperCase()} ${s.path}`, s] as const))(
    '%s → 501 NOT_IMPLEMENTED with the exact envelope',
    async (_name, stub) => {
      // A role the route allows: students for open routes (proves they are not teacher-gated).
      const res = await call(stub, stub.teacherOnly ? teacher : student).expect(501);
      expect(res.body).toEqual({
        error: {
          code: 'NOT_IMPLEMENTED',
          message: `${stub.feature} is not yet implemented (owner: Member ${stub.owner}).`,
          details: { owner: stub.owner, prompt: stub.prompt },
          requestId: expect.stringMatching(/^req_/),
        },
      });
    },
  );

  // By path, not array position: the list shrinks as owners replace stubs.
  const stubAt = (method: Stub['method'], suffix: string) => {
    const found = STUBS.find((s) => s.method === method && s.path.split('?')[0]!.endsWith(suffix));
    if (!found) throw new Error(`no stub ${method} …${suffix}`);
    return found;
  };
  it.each([
    ['POST /lectures/:id/questions/generate', stubAt('post', '/questions/generate')],
    ['PATCH /questions/:id', stubAt('patch', `/questions/${ID}`)],
    ['POST /topics/:id/reject', stubAt('post', `/topics/${ID}/reject`)],
  ])('%s with a student token → 403 FORBIDDEN', async (_name, stub) => {
    const res = await call(stub, student).expect(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('every stub requires a token (401 without one)', async () => {
    for (const stub of STUBS) {
      const res = await call(stub);
      expect(res.status, `${stub.method} ${stub.path}`).toBe(401);
    }
  });

  it('validates before answering 501: bad input → 422 with a field map, malformed id → 404', async () => {
    const bad = await request(app).post('/api/v1/ask').set('Authorization', student).send({ question: 'Hi', retriever: 'magic' }).expect(422);
    expect(bad.body.error.details).toEqual({ question: 'Must be 3–500 characters', retriever: 'Must be one of keyword, vector, hybrid' });
    await request(app).get('/api/v1/questions').set('Authorization', teacher).expect(422); // lectureId is required
    await request(app).get('/api/v1/quizzes/not-an-id').set('Authorization', student).expect(404);
  });

  it('leaves D routes and unknown paths alone', async () => {
    await request(app).get('/api/v1/health').expect(200);
    await request(app).get('/api/v1/nope').expect(404);
  });
});
