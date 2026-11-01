
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { assemblyTranscribe, groqTranscribe } = vi.hoisted(() => ({
  assemblyTranscribe: vi.fn(),
  groqTranscribe: vi.fn(),
}));

vi.mock('../src/config/env.js', () => ({
  env: { ASR_PROVIDER: undefined },
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('../src/services/asr/assemblyai.js', () => ({
  assemblyAIProvider: { transcribe: assemblyTranscribe },
}));

vi.mock('../src/services/asr/groq.js', () => ({
  groqProvider: { transcribe: groqTranscribe },
}));

const successResult = {
  segments: [
    { startSec: 0, endSec: 1, text: 'hello', confidence: 0.9 },
  ],
  modelVersion: 'test-model',
  provider: 'assemblyai',
  model: 'test-model',
  externalId: null,
  rawResponse: {},
};

describe('ASR provider selection and fallback', () => {
  let transcribeWithFallback: typeof import('../src/services/asr/index.js')['transcribeWithFallback'];
  let mockedEnv: typeof import('../src/config/env.js')['env'];

  beforeEach(async () => {
    vi.resetAllMocks();
    vi.resetModules();

    const envModule = await import('../src/config/env.js');
    mockedEnv = envModule.env;
    Reflect.set(mockedEnv, 'ASR_PROVIDER', undefined);

    assemblyTranscribe.mockResolvedValue(successResult);
    groqTranscribe.mockResolvedValue(successResult);

    const asrModule = await import('../src/services/asr/index.js');
    transcribeWithFallback = asrModule.transcribeWithFallback;
  });

  it('uses AssemblyAI by default', async () => {
    const result = await transcribeWithFallback('audio.wav');

    expect(result).toEqual(successResult);
    expect(assemblyTranscribe).toHaveBeenCalledOnce();
    expect(groqTranscribe).not.toHaveBeenCalled();
  });

  it('uses Groq when ASR_PROVIDER is groq', async () => {
  Reflect.set(mockedEnv, 'ASR_PROVIDER', 'groq');

    await transcribeWithFallback('audio.wav');

    expect(groqTranscribe).toHaveBeenCalledOnce();
    expect(assemblyTranscribe).not.toHaveBeenCalled();
  });

  it('falls back to Groq when AssemblyAI fails', async () => {
    assemblyTranscribe.mockRejectedValueOnce(
      new Error('AssemblyAI unavailable'),
    );

    const result = await transcribeWithFallback('audio.wav');

    expect(result).toEqual(successResult);
    expect(assemblyTranscribe).toHaveBeenCalledOnce();
    expect(groqTranscribe).toHaveBeenCalledOnce();
  });

  it('throws AsrUnavailableError (an AggregateError keeping both causes) when both providers fail', async () => {
    const primary = new Error('AssemblyAI unavailable');
    const fallback = new Error('Groq unavailable');
    assemblyTranscribe.mockRejectedValueOnce(primary);
    groqTranscribe.mockRejectedValueOnce(fallback);

    const { AsrUnavailableError } = await import('../src/services/asr/index.js');
    const error = await transcribeWithFallback('audio.wav').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AsrUnavailableError);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).message).toMatch(/Both speech-recognition providers failed/);
    expect((error as AggregateError).errors).toEqual([primary, fallback]);

    expect(assemblyTranscribe).toHaveBeenCalledOnce();
    expect(groqTranscribe).toHaveBeenCalledOnce();
  });
});
