import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** The AssemblyAI SDK is replaced by a fake that replays the fixture: no network. */
const { submit, get, testEnv } = vi.hoisted(() => ({
  submit: vi.fn(),
  get: vi.fn(),
  // config/env exports a frozen object; the provider only reads this key.
  testEnv: { ASSEMBLYAI_API_KEY: 'test-key-not-real' as string | undefined },
}));
vi.mock('assemblyai', () => ({
  AssemblyAI: vi.fn(() => ({ transcripts: { submit, get } })),
}));
vi.mock('../src/config/env.js', () => ({ env: testEnv }));

const completed = JSON.parse(
  readFileSync(new URL('../../evaluation/asr/fixtures/assemblyai-transcript.json', import.meta.url), 'utf8'),
) as { id: string; words: unknown[] };

describe('AssemblyAI provider (SDK faked with the fixture)', () => {
  let provider: typeof import('../src/services/asr/assemblyai.js');

  beforeEach(async () => {
    vi.useFakeTimers();
    submit.mockReset();
    get.mockReset();
    testEnv.ASSEMBLYAI_API_KEY = 'test-key-not-real';
    // test/setup.ts already imported the app (and this provider) with the real env: start fresh.
    vi.resetModules();
    provider = await import('../src/services/asr/assemblyai.js');
  });

  afterEach(() => vi.useRealTimers());

  it('submits universal-2 with speaker labels and keyterms, polls until completed, and returns utterances', async () => {
    submit.mockResolvedValue({ id: completed.id, status: 'queued' });
    get.mockResolvedValueOnce({ id: completed.id, status: 'processing' }).mockResolvedValueOnce(completed);

    const pending = provider.assemblyAIProvider.transcribe('/tmp/audio.wav', { keyterms: [' backpropagation ', '', 'ReLU'] });
    await vi.advanceTimersByTimeAsync(4_100);
    const result = await pending;

    expect(submit).toHaveBeenCalledWith({
      audio: '/tmp/audio.wav',
      speech_models: ['universal-2'],
      speaker_labels: true,
      word_boost: ['backpropagation', 'ReLU'], // universal-2's custom vocabulary (SDK 4.42: keyterms_prompt is Slam-1 only)
    });
    expect(get).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ provider: 'assemblyai', model: 'universal-2', modelVersion: 'assemblyai-universal-2', externalId: completed.id });
    expect(result.segments.length).toBeLessThan(completed.words.length); // utterances, not words
    expect(result.segments[0]!.startSec).toBe(1.234); // 1234 ms
  });

  it('a provider-side error status becomes a thrown error with its reason', async () => {
    submit.mockResolvedValue({ id: 'x', status: 'queued' });
    get.mockResolvedValue({ id: 'x', status: 'error', error: 'Audio file is corrupt' });
    const pending = provider.assemblyAIProvider.transcribe('/tmp/a.wav', {}).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(2_100);
    expect(String(await pending)).toMatch(/AssemblyAI transcription failed: Audio file is corrupt/);
  });

  it('gives up after the timeout, which scales with the audio length (≥ 10 min)', async () => {
    expect(provider.pollingTimeoutMs(60)).toBe(600_000);
    expect(provider.pollingTimeoutMs(2 * 3600)).toBe(7_200_000);
    submit.mockResolvedValue({ id: 'slow', status: 'queued' });
    get.mockResolvedValue({ id: 'slow', status: 'processing' });
    const pending = provider.assemblyAIProvider.transcribe('/tmp/a.wav', { durationSec: 60 }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(600_000 + 2_100);
    expect(String(await pending)).toMatch(/timed out after 600 seconds/);
  });

  it('refuses to run without ASSEMBLYAI_API_KEY (the fallback can then take over)', async () => {
    testEnv.ASSEMBLYAI_API_KEY = undefined;
    await expect(provider.assemblyAIProvider.transcribe('/tmp/a.wav', {})).rejects.toThrow(/ASSEMBLYAI_API_KEY is not configured/);
    expect(submit).not.toHaveBeenCalled();
  });
});
