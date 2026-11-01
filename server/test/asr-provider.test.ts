
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

  it('throws AggregateError when both providers fail', async () => {
    assemblyTranscribe.mockRejectedValueOnce(
      new Error('AssemblyAI unavailable'),
    );
    groqTranscribe.mockRejectedValueOnce(new Error('Groq unavailable'));

    await expect(transcribeWithFallback('audio.wav')).rejects.toThrow(
      'Both ASR providers failed',
    );

    expect(assemblyTranscribe).toHaveBeenCalledOnce();
    expect(groqTranscribe).toHaveBeenCalledOnce();
  });
});
