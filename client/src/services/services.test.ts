// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AxiosAdapter } from 'axios';
import { apiClient, isNotImplemented, TOKEN_KEY, UNAUTHORISED_EVENT } from '../lib/apiClient';
import { DEV_DEFAULT_MOCKS, parseMockFlag, selectServices } from '.';
import { mockServices } from './mock';
import { httpServices } from './http';
import { DEMO_PASSWORD } from './mock/db';

const TEACHER = 'teacher@lecturelens.dev';
const STUDENT = 'student@lecturelens.dev';
const L7 = '6650c3a0c3b2e41d8a100001';

async function signIn(email: string) {
  const { token } = await mockServices.auth.login(email, DEMO_PASSWORD);
  localStorage.setItem(TOKEN_KEY, token);
}

beforeEach(() => localStorage.clear());

describe('VITE_USE_MOCKS', () => {
  it('parses all / none / lists, ignoring unknown domains', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(parseMockFlag(undefined).size).toBe(9);
    expect(parseMockFlag('all').size).toBe(9);
    expect(parseMockFlag('').size).toBe(9);
    expect(parseMockFlag('none').size).toBe(0);
    expect([...parseMockFlag(' Auth, lectures ,transcript')]).toEqual(['auth', 'lectures', 'transcript']);
    expect([...parseMockFlag('qa,bogus')]).toEqual(['qa']);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('unset means none in a production build (fixtures never ship as real data)', () => {
    expect(parseMockFlag(undefined, 'none').size).toBe(0);
    expect(parseMockFlag('qa', 'none').size).toBe(1);
  });

  it('unset in development: every domain the server implements uses the real API', () => {
    // Regression: transcript/topics/summaries stayed mocked after their routes landed, so a lecture
    // processed by the real pipeline showed "No transcript for this lecture — Lecture not found."
    const services = selectServices(parseMockFlag(undefined, DEV_DEFAULT_MOCKS));
    for (const domain of ['auth', 'lectures', 'transcript', 'topics', 'summaries'] as const) {
      expect(services[domain]).toBe(httpServices[domain]);
    }
    // Only Member C's domains (still 501 on the server) are mocked.
    for (const domain of ['search', 'qa', 'quizzes', 'revision'] as const) {
      expect(services[domain]).toBe(mockServices[domain]);
    }
  });

  it('selects the adapter per domain', () => {
    const s = selectServices(parseMockFlag('auth,search'));
    expect(s.auth).toBe(mockServices.auth);
    expect(s.search).toBe(mockServices.search);
    expect(s.lectures).toBe(httpServices.lectures);
    expect(s.revision).toBe(httpServices.revision);
  });
});

describe('apiClient', () => {
  const original = apiClient.defaults.adapter;
  afterEach(() => {
    apiClient.defaults.adapter = original;
  });
  /** Respond to every request with this status and body. */
  const respond = (status: number, data: unknown): AxiosAdapter => async (config) => {
    const response = { status, statusText: String(status), data, headers: {}, config };
    if (status >= 200 && status < 300) return response;
    const err = Object.assign(new Error(`status ${status}`), { isAxiosError: true, config, response });
    throw err;
  };
  const envelope = (code: string, status: number) => ({ error: { code, message: `${code} message`, details: { owner: 'C', prompt: 'C3' }, requestId: 'req_8fK2a' }, status });

  it('attaches the bearer token', async () => {
    localStorage.setItem(TOKEN_KEY, 'abc');
    let seen: unknown;
    apiClient.defaults.adapter = async (config) => {
      seen = config.headers.get('Authorization');
      return { status: 200, statusText: 'OK', data: {}, headers: {}, config };
    };
    await apiClient.get('/health');
    expect(seen).toBe('Bearer abc');
  });

  it('normalises the error envelope and flags 501 as not implemented', async () => {
    apiClient.defaults.adapter = respond(501, envelope('NOT_IMPLEMENTED', 501));
    const err = await apiClient.post('/ask').catch((e) => e);
    expect(err).toMatchObject({ status: 501, code: 'NOT_IMPLEMENTED', requestId: 'req_8fK2a', details: { owner: 'C', prompt: 'C3' } });
    expect(isNotImplemented(err)).toBe(true);
    expect(isNotImplemented(new Error('x'))).toBe(false);
  });

  it('maps a non-contract body and a network failure', async () => {
    apiClient.defaults.adapter = respond(503, '<html>Bad gateway</html>');
    expect(await apiClient.get('/x').catch((e) => e)).toMatchObject({ status: 503, code: 'PROVIDER_UNAVAILABLE' });
    apiClient.defaults.adapter = async (config) => {
      throw Object.assign(new Error('Network Error'), { isAxiosError: true, config });
    };
    expect(await apiClient.get('/x').catch((e) => e)).toMatchObject({ status: 0, code: 'NETWORK_ERROR' });
  });

  it('on a 401 for an authenticated request: clears the token and dispatches ll:unauthorised', async () => {
    localStorage.setItem(TOKEN_KEY, 'expired');
    const onEvent = vi.fn();
    window.addEventListener(UNAUTHORISED_EVENT, onEvent);
    apiClient.defaults.adapter = respond(401, envelope('UNAUTHENTICATED', 401));
    await apiClient.get('/lectures').catch(() => undefined);
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(onEvent).toHaveBeenCalledOnce();
    window.removeEventListener(UNAUTHORISED_EVENT, onEvent);
  });

  it('a failed login (no token sent) is a plain 401, not a session end', async () => {
    const onEvent = vi.fn();
    window.addEventListener(UNAUTHORISED_EVENT, onEvent);
    apiClient.defaults.adapter = respond(401, envelope('UNAUTHENTICATED', 401));
    await apiClient.post('/auth/login').catch(() => undefined);
    expect(onEvent).not.toHaveBeenCalled();
    window.removeEventListener(UNAUTHORISED_EVENT, onEvent);
  });

  it('the http auth adapter registers through POST /auth/register and returns the server\'s answer', async () => {
    const calls: Array<{ method?: string; url?: string; data: unknown }> = [];
    const user = { id: '6ae21655e84cced2342afc47', email: 'new@example.edu', name: 'New Person', role: 'student' };
    apiClient.defaults.adapter = async (config) => {
      calls.push({ method: config.method, url: config.url, data: JSON.parse(String(config.data)) });
      return { status: 201, statusText: 'Created', data: { user, token: 'jwt' }, headers: {}, config };
    };
    const payload = { name: 'New Person', email: 'new@example.edu', password: 'notebook42', role: 'student' as const };
    await expect(httpServices.auth.register(payload)).resolves.toEqual({ user, token: 'jwt' });
    expect(calls).toEqual([{ method: 'post', url: '/auth/register', data: payload }]);
  });

  it('login and register never carry a stale token, so their 401 never ends a session', async () => {
    localStorage.setItem(TOKEN_KEY, 'stale-token');
    const onEvent = vi.fn();
    window.addEventListener(UNAUTHORISED_EVENT, onEvent);
    const sent: Array<string | undefined> = [];
    apiClient.defaults.adapter = async (config) => {
      sent.push(config.headers.get('Authorization') as string | undefined);
      return respond(401, envelope('UNAUTHENTICATED', 401))(config);
    };
    await apiClient.post('/auth/login', {}).catch(() => undefined);
    await apiClient.post('/auth/register', {}).catch(() => undefined);
    expect(sent).toEqual([undefined, undefined]);
    expect(onEvent).not.toHaveBeenCalled();
    expect(localStorage.getItem(TOKEN_KEY)).toBe('stale-token');
    window.removeEventListener(UNAUTHORISED_EVENT, onEvent);
  });
});

describe('mixed mode: real auth, mocked domains', () => {
  const jwt = (claims: object) =>
    `eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify(claims)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')}.sig`;
  afterEach(() => localStorage.clear());

  it('mocked domains accept the real API token of a seeded demo user', async () => {
    localStorage.setItem(TOKEN_KEY, jwt({ sub: '6650c3a0c3b2e41d8a000001', role: 'teacher', exp: Date.now() / 1000 + 3600 }));
    expect((await mockServices.lectures.list()).total).toBe(6);
  });

  it('a newly registered real user owns no fixture data, and an expired token is a 401', async () => {
    localStorage.setItem(TOKEN_KEY, jwt({ sub: '6ae21655e84cced2342afc47', role: 'teacher', exp: Date.now() / 1000 + 3600 }));
    expect((await mockServices.lectures.list()).total).toBe(0);
    localStorage.setItem(TOKEN_KEY, jwt({ sub: '6650c3a0c3b2e41d8a000001', role: 'teacher', exp: 1 }));
    await expect(mockServices.lectures.list()).rejects.toMatchObject({ status: 401 });
  });
});

describe('mock adapters follow the contract', () => {
  it('rejects unauthenticated calls with 401', async () => {
    await expect(mockServices.lectures.list()).rejects.toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
  });

  it('wrong password → 401; duplicate email → 409', async () => {
    await expect(mockServices.auth.login(TEACHER, 'nope')).rejects.toMatchObject({ status: 401 });
    await expect(mockServices.auth.register({ email: TEACHER, password: 'password1', name: 'Xi Chen', role: 'teacher' })).rejects.toMatchObject({
      status: 409,
      code: 'CONFLICT',
    });
  });

  it('students only receive approved topics, summaries and ready, transcript-approved lectures', async () => {
    await signIn(STUDENT);
    const lectures = await mockServices.lectures.list();
    expect(lectures.items.length).toBe(2);
    expect(lectures.items.every((l) => l.status === 'ready' && l.transcriptApproved)).toBe(true);
    expect((await mockServices.topics.list(L7)).items.map((t) => t.status)).toEqual(['approved', 'approved', 'approved', 'approved']);
    expect((await mockServices.summaries.list(L7)).items.every((s) => s.status === 'approved')).toBe(true);
    await expect(mockServices.lectures.getStatus(L7)).rejects.toMatchObject({ status: 403 });
  });

  it('teacher sees everything they own, including pending items', async () => {
    await signIn(TEACHER);
    expect((await mockServices.lectures.list()).total).toBe(6);
    expect((await mockServices.topics.list(L7)).items).toHaveLength(5);
    expect((await mockServices.summaries.list(L7)).items.filter((s) => s.status === 'pending_review')).toHaveLength(2);
  });

  it('first segment edit preserves originalText; later edits never overwrite it', async () => {
    await signIn(TEACHER);
    const first = await mockServices.transcript.updateSegment(L7, 0, 'Okay, let us get started.');
    const original = first.originalText;
    expect(original).toMatch(/^Okay, let's get started\./);
    const second = await mockServices.transcript.updateSegment(L7, 0, 'Okay — let us begin.');
    expect(second.originalText).toBe(original);
    expect(second.text).toBe('Okay — let us begin.');
  });

  it('seeded attempt 3 matches CONTRACTS.md §6.11', async () => {
    await signIn(STUDENT);
    const attempt = await mockServices.quizzes.getAttempt('6650c3a0c3b2e41d8a800003');
    expect(attempt.score).toEqual({ correct: 3, total: 5, accuracy: 0.6 });
    expect(attempt.perTopic.map((p) => [p.correct, p.total])).toEqual([[1, 1], [1, 2], [0, 1], [1, 1]]);
    expect(attempt.timeTakenSec).toBe(504.913);
    expect(attempt.answers[2].deepLink).toBe(`/lectures/${L7}/play?t=357.43`);
  });

  it('quiz questions hide the answer key from students; submitting scores them', async () => {
    await signIn(STUDENT);
    const quiz = await mockServices.quizzes.create({ lectureId: L7, questionCount: 3 });
    expect(quiz.questions).toHaveLength(3);
    expect(quiz.questions.every((q) => !('correctOptionId' in q))).toBe(true);
    const attempt = await mockServices.quizzes.submitAttempt(quiz.id, {
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      answers: quiz.questions.map((q) => ({ questionId: q.id, selectedOptionId: 'a' })),
    });
    expect(attempt.score.total).toBe(3);
    expect(attempt.answers.every((a) => a.correctOptionId && a.explanation)).toBe(true);
  });

  it('ask: answers the learning-rate question, abstains (200, not an error) otherwise', async () => {
    await signIn(STUDENT);
    const yes = await mockServices.qa.ask({ question: 'Why does a learning rate that is too large make the loss blow up?', lectureId: L7 });
    expect(yes.abstained).toBe(false);
    expect(yes.citations).toHaveLength(2);
    const no = await mockServices.qa.ask({ question: 'What did the lecturer say about Adam beta2?', lectureId: L7 });
    expect(no).toMatchObject({ abstained: true, answerable: false, abstainReason: 'NO_RELEVANT_PASSAGE', citations: [], answer: null });
  });

  it('rejecting a question requires a reason (422 with a field map)', async () => {
    await signIn(TEACHER);
    await expect(mockServices.quizzes.updateQuestion('6650c3a0c3b2e41d8a600006', { status: 'rejected' })).rejects.toMatchObject({
      status: 422,
      code: 'VALIDATION_FAILED',
      details: { rejectionReason: 'Required when status is rejected' },
    });
  });

  it('upload validates consent and starts processing', async () => {
    await signIn(TEACHER);
    const form = new FormData();
    form.set('file', new File(['x'], 'lecture.mp4', { type: 'video/mp4' }));
    form.set('title', 'Lecture 11 — Attention');
    form.set('lecturerConsent', 'true');
    form.set('purposeShown', 'false');
    form.set('processorNamed', 'true');
    await expect(mockServices.lectures.create(form)).rejects.toMatchObject({ status: 422, details: { 'consent.purposeShown': expect.any(String) } });
    form.set('purposeShown', 'true');
    const created = await mockServices.lectures.create(form);
    expect(created).toMatchObject({ status: 'uploaded', title: 'Lecture 11 — Attention', consent: { lecturerConsent: true } });
    expect((await mockServices.lectures.getStatus(created.id)).stages.every((s) => s.state === 'pending')).toBe(true);
  });
});

describe('mock lecture pipeline', () => {
  it('a fresh upload reports "uploaded" (not undefined) before processing starts', async () => {
    localStorage.setItem(TOKEN_KEY, (await mockServices.auth.login(TEACHER, DEMO_PASSWORD)).token);
    const form = new FormData();
    form.set('file', new File(['x'], 'fresh.mp4', { type: 'video/mp4' }));
    form.set('title', 'Fresh upload');
    for (const k of ['lecturerConsent', 'purposeShown', 'processorNamed']) form.set(k, 'true');
    const created = await mockServices.lectures.create(form);
    expect((await mockServices.lectures.get(created.id)).status).toBe('uploaded');
    expect((await mockServices.lectures.getStatus(created.id)).status).toBe('uploaded');
  });
});
