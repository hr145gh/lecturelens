import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  keywordSearchMock,
  vectorSearchMock,
  hybridSearchMock,
  getCachedAnswerMock,
  setCachedAnswerMock,
} = vi.hoisted(() => ({
  keywordSearchMock: vi.fn(),
  vectorSearchMock: vi.fn(),
  hybridSearchMock: vi.fn(),
  getCachedAnswerMock: vi.fn(),
  setCachedAnswerMock: vi.fn(),
}));

vi.mock('../src/services/retrieval/keyword.js', () => ({
  keywordSearch: keywordSearchMock,
}));

vi.mock('../src/services/retrieval/vector.js', () => ({
  vectorSearch: vectorSearchMock,
}));

vi.mock('../src/services/retrieval/hybrid.js', () => ({
  hybridSearch: hybridSearchMock,
}));

vi.mock('../src/services/rag/cache.js', () => ({
  getCachedAnswer: getCachedAnswerMock,
  setCachedAnswer: setCachedAnswerMock,
}));

import {
  answerQuestion,
  type AnswerGenerator,
} from '../src/services/rag/answer.js';

const passage = {
  chunkId: 'chunk-123',
  lectureId: 'lecture-123',
  startSec: 10,
  endSec: 40,
  text: 'An operating system manages computer hardware and software resources.',
  score: 0.9,
};

const validModelResponse = JSON.stringify({
  answer: 'An operating system manages hardware and software resources [1].',
  citedPassages: [1],
  citedQuotes: [
    {
      passageNumber: 1,
      quote: 'An operating system manages computer hardware and software resources.',
    },
  ],
  answerable: true,
  confidence: 0.86,
});

function createGenerator(
  generate: AnswerGenerator['generate'],
): AnswerGenerator {
  return {
    model: 'test-model',
    generate,
  };
}

function createOptions(generator: AnswerGenerator) {
  return {
    question: 'What does an operating system do?',
    allowedLectureIds: ['lecture-123'],
    retriever: 'keyword' as const,
    generator,
  };
}

describe('RAG answer service', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    process.env.RAG_MIN_SCORE = '0.35';

    keywordSearchMock.mockResolvedValue([passage]);
    vectorSearchMock.mockResolvedValue([passage]);
    hybridSearchMock.mockResolvedValue([passage]);

    getCachedAnswerMock.mockResolvedValue(null);
    setCachedAnswerMock.mockResolvedValue(undefined);
  });

  it('abstains when no relevant passage is found without calling the generator', async () => {
    keywordSearchMock.mockResolvedValue([
      { ...passage, score: 0.2 },
    ]);

    const generate = vi.fn();

    const result = await answerQuestion(
      createOptions(createGenerator(generate)),
    );

    expect(result.answerable).toBe(false);
    expect(result.abstained).toBe(true);
    expect(result.abstainReason).toBe('NO_RELEVANT_PASSAGE');

    expect(generate).not.toHaveBeenCalled();
    expect(getCachedAnswerMock).not.toHaveBeenCalled();
  });

  it('returns a cached answer without calling the generator', async () => {
    getCachedAnswerMock.mockResolvedValue({
      response: validModelResponse,
      tokensIn: 100,
      tokensOut: 30,
    });

    const generate = vi.fn();

    const result = await answerQuestion(
      createOptions(createGenerator(generate)),
    );

    expect(result.answerable).toBe(true);
    expect(result.cached).toBe(true);
    expect(result.answer).toContain('operating system');

    expect(generate).not.toHaveBeenCalled();
    expect(setCachedAnswerMock).not.toHaveBeenCalled();
  });

  it('generates, validates, and caches a valid answer', async () => {
    const generate = vi.fn().mockResolvedValue({
      content: validModelResponse,
      model: 'test-model',
      tokensIn: 100,
      tokensOut: 30,
    });

    const result = await answerQuestion(
      createOptions(createGenerator(generate)),
    );

    expect(result.answerable).toBe(true);
    expect(result.abstained).toBe(false);
    expect(result.answer).toContain('[1]');
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0].chunkId).toBe('chunk-123');
    expect(result.citations[0].quote).toBe(
      'An operating system manages computer hardware and software resources.',
    );
    expect(result.cached).toBe(false);

    expect(generate).toHaveBeenCalledTimes(1);
    expect(setCachedAnswerMock).toHaveBeenCalledTimes(1);
  });

  it('retries exactly once when the model returns invalid JSON', async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce({
        content: 'This is not valid JSON',
        model: 'test-model',
        tokensIn: 50,
        tokensOut: 10,
      })
      .mockResolvedValueOnce({
        content: validModelResponse,
        model: 'test-model',
        tokensIn: 60,
        tokensOut: 20,
      });

    const result = await answerQuestion(
      createOptions(createGenerator(generate)),
    );

    expect(result.answerable).toBe(true);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(setCachedAnswerMock).toHaveBeenCalledTimes(1);

    // Both attempts' token counts should be cached.
    expect(setCachedAnswerMock).toHaveBeenCalledWith(
      expect.any(Object),
      validModelResponse,
      110,
      30,
    );
  });

  it('returns PARSE_FAILED when both generation attempts return invalid JSON', async () => {
    const generate = vi.fn().mockResolvedValue({
      content: 'Invalid JSON',
      model: 'test-model',
      tokensIn: 50,
      tokensOut: 10,
    });

    const result = await answerQuestion(
      createOptions(createGenerator(generate)),
    );

    expect(result.answerable).toBe(false);
    expect(result.abstained).toBe(true);
    expect(result.abstainReason).toBe('PARSE_FAILED');

    expect(generate).toHaveBeenCalledTimes(2);
    expect(setCachedAnswerMock).not.toHaveBeenCalled();
  });

  it('propagates provider errors instead of converting them into abstentions', async () => {
    const providerError = new Error('Provider unavailable');

    const generate = vi.fn().mockRejectedValue(providerError);

    await expect(
      answerQuestion(createOptions(createGenerator(generate))),
    ).rejects.toThrow('Provider unavailable');

    expect(generate).toHaveBeenCalledTimes(1);
    expect(setCachedAnswerMock).not.toHaveBeenCalled();
  });
});