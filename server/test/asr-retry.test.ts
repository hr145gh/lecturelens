import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AssemblyAI } from 'assemblyai';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { withHttpStatusErrors } from '../src/services/asr/assemblyai.js';
import { isRetryable, ProviderHttpError, retryPolicy, withRetry } from '../src/services/asr/retry.js';
import { logger } from '../src/utils/logger.js';

const savedPolicy = { ...retryPolicy };
beforeAll(() => Object.assign(retryPolicy, { baseDelayMs: 1, maxDelayMs: 5 })); // no real waiting
afterAll(() => Object.assign(retryPolicy, savedPolicy));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const http = (status: number) => new ProviderHttpError('groq', status, 'test');

describe('withRetry — 429 and 5xx only, 3 retries, exponential backoff', () => {
  it('classifies statuses: 429 and 5xx retryable; 400/401/404/413 and non-HTTP errors are not', () => {
    for (const s of [429, 500, 502, 503, 504]) expect(isRetryable(http(s))).toBe(true);
    for (const s of [400, 401, 403, 404, 413, 422]) expect(isRetryable(http(s))).toBe(false);
    expect(isRetryable(new Error('socket hang up'))).toBe(false);
  });

  it('retries a 503 then succeeds, logging every attempt with the lecture id', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const call = vi.fn().mockRejectedValueOnce(http(503)).mockRejectedValueOnce(http(429)).mockResolvedValue('ok');
    await expect(withRetry(call, { provider: 'groq', operation: 'transcribe', lectureId: 'L1' })).resolves.toBe('ok');
    expect(call).toHaveBeenCalledTimes(3);
    expect(warn.mock.calls.map(([, f]) => f)).toEqual([
      expect.objectContaining({ lectureId: 'L1', attempt: 1, status: 503, retryInMs: 1 }),
      expect.objectContaining({ lectureId: 'L1', attempt: 2, status: 429, retryInMs: 2 }), // doubled
    ]);
  });

  it('gives up after 3 retries (4 attempts) and rethrows the last error', async () => {
    const call = vi.fn().mockRejectedValue(http(500));
    await expect(withRetry(call, { provider: 'groq', operation: 'x' })).rejects.toMatchObject({ status: 500 });
    expect(call).toHaveBeenCalledTimes(4);
  });

  it('never retries a 4xx such as 400 or 401', async () => {
    for (const status of [400, 401]) {
      const call = vi.fn().mockRejectedValue(http(status));
      await expect(withRetry(call, { provider: 'groq', operation: 'x' })).rejects.toMatchObject({ status });
      expect(call).toHaveBeenCalledTimes(1);
    }
  });
});

describe('real AssemblyAI SDK, fetch stubbed — HTTP status survives the SDK', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'lecturelens-retry-'));
    await writeFile(path.join(dir, 'a.wav'), Buffer.alloc(64));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

  it('turns an upload 429 into ProviderHttpError(429) with Retry-After, which withRetry retries', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(429, { error: 'Too many requests' }, { 'retry-after': '1' }))
      .mockResolvedValueOnce(json(200, { upload_url: 'https://cdn.example/upload/1' }))
      .mockResolvedValueOnce(json(200, { id: 'tr_1', status: 'queued' }));
    vi.stubGlobal('fetch', fetchMock);
    const client = withHttpStatusErrors(new AssemblyAI({ apiKey: 'test-key-not-real' }));

    const first = await client.transcripts.submit({ audio: path.join(dir, 'a.wav') }).catch((e: unknown) => e);
    expect(first).toBeInstanceOf(ProviderHttpError);
    expect(first).toMatchObject({ status: 429, retryAfterSec: 1, message: expect.stringContaining('Too many requests') });

    const submitted = await withRetry(() => client.transcripts.submit({ audio: path.join(dir, 'a.wav') }), {
      provider: 'assemblyai',
      operation: 'upload and submit',
      lectureId: 'L2',
    });
    expect(submitted).toMatchObject({ id: 'tr_1', status: 'queued' });
  });

  it('a 400 from AssemblyAI is surfaced as status 400 and not retried', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(400, { error: 'Invalid audio' }));
    vi.stubGlobal('fetch', fetchMock);
    const client = withHttpStatusErrors(new AssemblyAI({ apiKey: 'test-key-not-real' }));
    await expect(
      withRetry(() => client.transcripts.get('tr_x'), { provider: 'assemblyai', operation: 'poll', lectureId: 'L3' }),
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining('Invalid audio') });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
