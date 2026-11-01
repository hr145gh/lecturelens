import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findOneAndUpdateMock, updateOneMock } = vi.hoisted(() => ({
  findOneAndUpdateMock: vi.fn(),
  updateOneMock: vi.fn(),
}));

vi.mock('../src/models/LlmCache.js', () => ({
  LlmCache: {
    findOneAndUpdate: findOneAndUpdateMock,
    updateOne: updateOneMock,
  },
}));

import {
  createAnswerCacheKey,
  getCachedAnswer,
  setCachedAnswer,
} from '../src/services/rag/cache.js';

const params = {
  model: 'test-model',
  promptVersion: 'answer-v3' as const,
  input: {
    system: 'Answer only from passages.',
    user: 'What is an operating system?',
  },
};

describe('RAG answer cache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a deterministic SHA-256 key', () => {
    expect(createAnswerCacheKey(params)).toBe(
      createAnswerCacheKey(params),
    );
    expect(createAnswerCacheKey(params)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('creates different keys for different models or prompts', () => {
    const differentModel = {
      ...params,
      model: 'another-model',
    };

    const differentPrompt = {
      ...params,
      input: {
        ...params.input,
        user: 'Explain process scheduling.',
      },
    };

    expect(createAnswerCacheKey(differentModel)).not.toBe(
      createAnswerCacheKey(params),
    );
    expect(createAnswerCacheKey(differentPrompt)).not.toBe(
      createAnswerCacheKey(params),
    );
  });

  it('returns null on a cache miss', async () => {
    findOneAndUpdateMock.mockReturnValue({
      lean: vi.fn().mockResolvedValue(null),
    });

    await expect(getCachedAnswer(params)).resolves.toBeNull();

    expect(findOneAndUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        key: createAnswerCacheKey(params),
        purpose: 'answer',
      }),
      { $inc: { hits: 1 } },
      { new: true },
    );
  });

  it('returns the cached response and token counts on a hit', async () => {
    const cached = {
      response: { answer: 'A grounded answer.' },
      tokensIn: 100,
      tokensOut: 30,
    };

    findOneAndUpdateMock.mockReturnValue({
      lean: vi.fn().mockResolvedValue(cached),
    });

    await expect(getCachedAnswer(params)).resolves.toEqual(cached);
  });

  it('writes a cache entry without overwriting an existing entry', async () => {
    updateOneMock.mockResolvedValue({ acknowledged: true });

    const response = { answer: 'A grounded answer.' };

    await setCachedAnswer(params, response, 100, 30);

    expect(updateOneMock).toHaveBeenCalledWith(
      { key: createAnswerCacheKey(params) },
      {
        $setOnInsert: {
          key: createAnswerCacheKey(params),
          purpose: 'answer',
          model: params.model,
          promptVersion: params.promptVersion,
          response,
          tokensIn: 100,
          tokensOut: 30,
        },
      },
      { upsert: true },
    );
  });

  it('rejects invalid token counts', async () => {
    await expect(
      setCachedAnswer(params, { answer: 'test' }, -1, 0),
    ).rejects.toThrow('Cache token counts must be non-negative numbers');

    expect(updateOneMock).not.toHaveBeenCalled();
  });
});