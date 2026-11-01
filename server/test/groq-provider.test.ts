import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// config/env exports a frozen object; the provider only reads GROQ_API_KEY from it.
const { testEnv } = vi.hoisted(() => ({ testEnv: { GROQ_API_KEY: 'test-key-not-real' } }));
vi.mock('../src/config/env.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/config/env.js')>()),
  env: testEnv,
}));

const ok = {
  text: 'gradient descent',
  segments: [{ text: 'gradient descent', start: 0, end: 1.2, avg_logprob: -0.1 }],
  words: [
    { word: 'gradient', start: 0.1, end: 0.6 },
    { word: 'descent', start: 0.65, end: 1.2 },
  ],
};

let dir: string;
let file: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'lecturelens-groq-'));
  file = path.join(dir, 'a.wav');
  await writeFile(file, Buffer.alloc(64)); // small: a single request, no chunking
});
afterAll(() => rm(dir, { recursive: true, force: true }));
afterEach(() => vi.unstubAllGlobals());

describe('Groq provider over a stubbed fetch', () => {
  let groq: typeof import('../src/services/asr/groq.js');
  let retryPolicy: typeof import('../src/services/asr/retry.js')['retryPolicy'];

  beforeEach(async () => {
    vi.resetModules(); // test/setup.ts loaded the app with the real env first
    groq = await import('../src/services/asr/groq.js');
    retryPolicy = (await import('../src/services/asr/retry.js')).retryPolicy;
    Object.assign(retryPolicy, { baseDelayMs: 1, maxDelayMs: 5 });
  });

  it('retries a 502 and uses the transcript from the retry', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('bad gateway', { status: 502 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(ok), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await groq.groqProvider.transcribe(file, { lectureId: 'L9' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.segments.map((s) => s.text)).toEqual(['gradient descent']);
    expect(result.segments[0]!.confidence).toBe(0.905); // exp(-0.1)
  });

  it('a 400 is not retried', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"error":{"message":"bad file"}}', { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(groq.groqProvider.transcribe(file, {})).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends the glossary as Whisper\'s prompt when keyterms are given, and nothing otherwise', async () => {
    const forms: FormData[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      forms.push(init.body as FormData);
      return new Response(JSON.stringify(ok), { status: 200 });
    }));
    await groq.groqProvider.transcribe(file, { keyterms: ['backpropagation', ' sigmoid '] });
    await groq.groqProvider.transcribe(file, {});
    expect(forms[0]!.get('prompt')).toBe('backpropagation, sigmoid');
    expect(forms[1]!.get('prompt')).toBeNull();
    expect(forms[0]!.get('model')).toBe('whisper-large-v3-turbo');
  });
});
