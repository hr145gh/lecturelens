import mongoose from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Lecture } from '../src/models/index.js';
import { redact } from '../src/utils/logger.js';
import { authHeader, buildApp, makeStudent, makeTeacher, resetDb } from './setup.js';

/** The error envelope — docs/CONTRACTS.md §3 — on every failure path, plus request ids. */

const app = await buildApp();
const api = () => request(app);

beforeEach(async () => {
  await resetDb();
  vi.restoreAllMocks();
});

/** Exactly { error: { code, message, details, requestId } }, details an object, id echoed in the header. */
function expectEnvelope(res: request.Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(Object.keys(res.body)).toEqual(['error']);
  expect(Object.keys(res.body.error).sort()).toEqual(['code', 'details', 'message', 'requestId']);
  expect(res.body.error.code).toBe(code);
  expect(typeof res.body.error.message).toBe('string');
  expect(res.body.error.message.length).toBeGreaterThan(0);
  expect(res.body.error.details).toBeTypeOf('object');
  expect(res.body.error.details).not.toBeNull();
  expect(res.body.error.requestId).toMatch(/^req_[A-Za-z0-9_-]+$/);
  expect(res.headers['x-request-id']).toBe(res.body.error.requestId);
  expect(res.headers['content-type']).toMatch(/^application\/json/);
}

describe('error envelope', () => {
  it('401 UNAUTHENTICATED — no token', async () => {
    const res = await api().get('/api/v1/auth/me');
    expectEnvelope(res, 401, 'UNAUTHENTICATED');
    expect(res.body.error.details).toEqual({});
  });

  it('403 FORBIDDEN — student on a teacher-only route', async () => {
    const res = await api().post('/api/v1/lectures').set(authHeader(await makeStudent()));
    expectEnvelope(res, 403, 'FORBIDDEN');
  });

  it('404 NOT_FOUND — unknown route, malformed id, unknown id', async () => {
    const teacher = authHeader(await makeTeacher());
    expectEnvelope(await api().get('/api/v1/no-such-route'), 404, 'NOT_FOUND');
    expectEnvelope(await api().get('/api/v1/lectures/xyz').set(teacher), 404, 'NOT_FOUND');
    expectEnvelope(await api().get('/api/v1/lectures/6650c3a0c3b2e41d8a1fffff').set(teacher), 404, 'NOT_FOUND');
  });

  it('422 VALIDATION_FAILED — field map with dotted paths, and malformed JSON (there is no 400)', async () => {
    const invalid = await api().post('/api/v1/auth/register').send({ email: 'x', role: 'admin' });
    expectEnvelope(invalid, 422, 'VALIDATION_FAILED');
    expect(invalid.body.error.details).toMatchObject({ name: 'Required', password: 'Required', email: 'Must be a valid email address' });

    const malformed = await api().post('/api/v1/auth/login').set('Content-Type', 'application/json').send('{"email": ');
    expectEnvelope(malformed, 422, 'VALIDATION_FAILED');
    expect(malformed.body.error.details).toEqual({ body: 'Malformed JSON.' });
  });

  it('501 NOT_IMPLEMENTED — owner and prompt in details', async () => {
    const res = await api().post('/api/v1/ask').set(authHeader(await makeStudent())).send({ question: 'What is a gradient?' });
    expectEnvelope(res, 501, 'NOT_IMPLEMENTED');
    expect(res.body.error).toMatchObject({
      message: 'Grounded Q&A is not yet implemented (owner: Member C).',
      details: { owner: 'C', prompt: 'PC.2' },
    });
  });

  it('500 INTERNAL_ERROR — generic message, no stack or internal detail leaks', async () => {
    const teacher = authHeader(await makeTeacher());
    vi.spyOn(Lecture, 'find').mockImplementation(() => {
      throw new Error('connection pool exploded at mongodb://user:secret@host');
    });
    const res = await api().get('/api/v1/lectures').set(teacher);
    expectEnvelope(res, 500, 'INTERNAL_ERROR');
    expect(res.body.error.details).toEqual({});
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/exploded|secret|mongodb:|\bat \/|\.ts:\d+/);
  });

  it('maps database errors: Mongoose ValidationError → 422 field map, an id CastError → 404', async () => {
    const teacher = authHeader(await makeTeacher());
    const invalid = new mongoose.Error.ValidationError();
    invalid.addError('title', new mongoose.Error.ValidatorError({ path: 'title', message: 'Must be at most 200 characters' }));
    vi.spyOn(Lecture, 'find').mockImplementationOnce(() => {
      throw invalid;
    });
    const res = await api().get('/api/v1/lectures').set(teacher);
    expectEnvelope(res, 422, 'VALIDATION_FAILED');
    expect(res.body.error.details).toEqual({ title: 'Must be at most 200 characters' });

    vi.spyOn(Lecture, 'find').mockImplementationOnce(() => {
      throw new mongoose.Error.CastError('ObjectId', 'abc', '_id');
    });
    expectEnvelope(await api().get('/api/v1/lectures').set(teacher), 404, 'NOT_FOUND');
  });

  it('413 PAYLOAD_TOO_LARGE — JSON body over 1 MB', async () => {
    const res = await api()
      .post('/api/v1/auth/login')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ email: 'a@b.c', password: 'x'.repeat(1024 * 1024 + 1) }));
    expectEnvelope(res, 413, 'PAYLOAD_TOO_LARGE');
  });

  it('409, 415 and 429 use the same envelope', async () => {
    const body = { name: 'Ann Lee', email: 'ann@example.edu', password: 'abcdefg1', role: 'student' };
    await api().post('/api/v1/auth/register').send(body).expect(201);
    expectEnvelope(await api().post('/api/v1/auth/register').send(body), 409, 'CONFLICT');

    const upload = await api()
      .post('/api/v1/lectures')
      .set(authHeader(await makeTeacher()))
      .field({ title: 'x', lecturerConsent: 'true', purposeShown: 'true', processorNamed: 'true' })
      .attach('file', Buffer.from('hello'), { filename: 'notes.txt', contentType: 'text/plain' });
    expectEnvelope(upload, 415, 'UNSUPPORTED_MEDIA_TYPE');

    let last: request.Response | undefined;
    for (let i = 0; i < 11; i++) last = await api().post('/api/v1/auth/login').send({ email: 'a@b.c', password: 'x' });
    expectEnvelope(last!, 429, 'RATE_LIMITED');
    expect(last!.body.error.details.retryAfterSec).toBeGreaterThan(0);
  });
});

describe('request ids', () => {
  it('every response carries a unique X-Request-Id, successes included', async () => {
    const teacher = await makeTeacher();
    const responses = [
      await api().get('/api/v1/health'), // 200
      await api().post('/api/v1/auth/register').send({ name: 'Bo Chen', email: 'bo@example.edu', password: 'abcdefg1', role: 'teacher' }), // 201
      await api().get('/api/v1/lectures').set(authHeader(teacher)), // 200
      await api().get('/api/v1/nope'), // 404
    ];
    const ids = responses.map((r) => r.headers['x-request-id']);
    for (const id of ids) expect(id).toMatch(/^req_/);
    expect(new Set(ids).size).toBe(ids.length);
    expect(responses.map((r) => r.status)).toEqual([200, 201, 200, 404]);
  });
});

describe('logging', () => {
  it('redacts passwords, tokens, secrets, keys and authorization at any depth', () => {
    expect(
      redact({ password: 'p', nested: { apiKey: 'k', Authorization: 'Bearer x', list: [{ refreshToken: 't' }] }, keep: 1 }),
    ).toEqual({ password: '[REDACTED]', nested: { apiKey: '[REDACTED]', Authorization: '[REDACTED]', list: [{ refreshToken: '[REDACTED]' }] }, keep: 1 });
  });
});
