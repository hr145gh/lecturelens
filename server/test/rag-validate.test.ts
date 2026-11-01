
import { describe, expect, it } from 'vitest';
import {
  validateModelAnswer,
  type ValidatedCitation,
} from '../src/services/rag/validate.js';
import type { NumberedPassage } from '../src/services/rag/prompt.js';

const passages: NumberedPassage[] = [
  {
    number: 1,
    chunkId: 'chunk-001',
    lectureId: 'lecture-001',
    startSec: 120,
    endSec: 180,
    text: 'The learning rate controls how large each optimization step is.',
    score: 0.85,
  },
  {
    number: 2,
    chunkId: 'chunk-002',
    lectureId: 'lecture-001',
    startSec: 180,
    endSec: 240,
    text: 'A very large learning rate can cause the loss to diverge.',
    score: 0.78,
  },
];

function modelAnswer(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    answer: 'The learning rate controls the optimization step [1].',
    citedPassages: [1],
    citedQuotes: [
      {
        passageNumber: 1,
        quote: 'The learning rate controls how large each optimization step is.',
      },
    ],
    answerable: true,
    confidence: 0.86,
    ...overrides,
  });
}

describe('validateModelAnswer', () => {
  it('returns PARSE_FAILED when the model output is invalid JSON', () => {
    const result = validateModelAnswer('This is not JSON', passages);

    expect(result).toEqual({
      answerable: false,
      abstainReason: 'PARSE_FAILED',
      answer: null,
      citations: [],
      confidence: null,
    });
  });

  it('drops hallucinated citation indexes', () => {
    const raw = modelAnswer({
      answer: 'The learning rate controls the optimization step [1] [99].',
      citedPassages: [1, 99],
    });

    const result = validateModelAnswer(raw, passages);

    expect(result.answerable).toBe(true);

    if (!result.answerable) {
      throw new Error('Expected an answerable result');
    }

    expect(result.citations).toHaveLength(1);
    expect(result.citations[0].marker).toBe(1);
    expect(result.answer).toContain('[1]');
    expect(result.answer).not.toContain('[99]');
    expect(result.confidence).toBe(0.86);
  });

  it('abstains when no valid citations survive', () => {
    const raw = modelAnswer({
      answer: 'The answer is supported by passage [99].',
      citedPassages: [99],
    });

    const result = validateModelAnswer(raw, passages);

    expect(result).toEqual({
      answerable: false,
      abstainReason: 'LOW_CONFIDENCE',
      answer: null,
      citations: [],
      confidence: null,
    });
  });

  it('builds citation timestamps and deep links from the retrieved passage', () => {
    const raw = modelAnswer({
      answer: 'A large learning rate can cause divergence.',
      citedPassages: [2],
      citedQuotes: [
        {
          passageNumber: 2,
          quote: 'A very large learning rate can cause the loss to diverge.',
        },
      ],
    });

    const result = validateModelAnswer(raw, passages);

    expect(result.answerable).toBe(true);

    if (!result.answerable) {
      throw new Error('Expected an answerable result');
    }

    const citation: ValidatedCitation = result.citations[0];

    expect(citation).toEqual({
      marker: 2,
      chunkId: 'chunk-002',
      lectureId: 'lecture-001',
      startSec: 180,
      endSec: 240,
      quote: 'A very large learning rate can cause the loss to diverge.',
      deepLink: '/lectures/lecture-001/play?t=180',
    });

    expect(result.confidence).toBe(0.86);
    expect(citation.startSec).toBeGreaterThanOrEqual(180);
    expect(citation.startSec).toBeLessThanOrEqual(240);
  });

  it('abstains when the model declares the question unanswerable', () => {
    const raw = modelAnswer({
      answer: '',
      citedPassages: [],
      citedQuotes: [],
      answerable: false,
      confidence: 0,
    });

    const result = validateModelAnswer(raw, passages);

    expect(result).toEqual({
      answerable: false,
      abstainReason: 'LOW_CONFIDENCE',
      answer: null,
      citations: [],
      confidence: null,
    });
  });

  it('rejects confidence below zero', () => {
    expect(
      validateModelAnswer(modelAnswer({ confidence: -0.1 }), passages)
        .abstainReason,
    ).toBe('PARSE_FAILED');
  });

  it('rejects confidence above one', () => {
    expect(
      validateModelAnswer(modelAnswer({ confidence: 1.1 }), passages)
        .abstainReason,
    ).toBe('PARSE_FAILED');
  });

  it('rejects missing confidence', () => {
    const raw = JSON.stringify({
      answer: 'Some answer [1].',
      citedPassages: [1],
      citedQuotes: [
        {
          passageNumber: 1,
          quote: 'The learning rate controls how large each optimization step is.',
        },
      ],
      answerable: true,
    });

    expect(
      validateModelAnswer(raw, passages).abstainReason,
    ).toBe('PARSE_FAILED');
  });

  it('rejects a successful answer with empty answer text', () => {
    const result = validateModelAnswer(
      modelAnswer({ answer: '' }),
      passages,
    );

    expect(result.answerable).toBe(false);
    expect(result.abstainReason).toBe('LOW_CONFIDENCE');
  });

  it('rejects a successful answer with zero confidence', () => {
    const result = validateModelAnswer(
      modelAnswer({ confidence: 0 }),
      passages,
    );

    expect(result.answerable).toBe(false);
    expect(result.abstainReason).toBe('LOW_CONFIDENCE');
  });

  it('rejects a quotation that is not an exact transcript substring', () => {
    const raw = modelAnswer({
      citedQuotes: [
        {
          passageNumber: 1,
          quote: 'The learning rate always controls the optimization speed.',
        },
      ],
    });

    const result = validateModelAnswer(raw, passages);

    expect(result.answerable).toBe(false);
    expect(result.abstainReason).toBe('LOW_CONFIDENCE');
  });

  it('rejects quotations longer than 300 characters', () => {
    const raw = modelAnswer({
      citedQuotes: [
        {
          passageNumber: 1,
          quote: 'a'.repeat(301),
        },
      ],
    });

    const result = validateModelAnswer(raw, passages);

    expect(result.answerable).toBe(false);
    expect(result.abstainReason).toBe('LOW_CONFIDENCE');
  });

  it('keeps valid citations and drops citations with invalid quotations', () => {
    const raw = modelAnswer({
      answer: 'The learning rate controls optimization [1] [2].',
      citedPassages: [1, 2],
      citedQuotes: [
        {
          passageNumber: 1,
          quote: 'The learning rate controls how large each optimization step is.',
        },
        {
          passageNumber: 2,
          quote: 'The loss always decreases with a large learning rate.',
        },
      ],
    });

    const result = validateModelAnswer(raw, passages);

    expect(result.answerable).toBe(true);

    if (!result.answerable) {
      throw new Error('Expected an answerable result');
    }

    expect(result.citations).toHaveLength(1);
    expect(result.citations[0].marker).toBe(1);
    expect(result.answer).toContain('[1]');
    expect(result.answer).not.toContain('[2]');
  });

  it('rejects a successful response without cited quotes', () => {
    const raw = modelAnswer({
      citedQuotes: [],
    });

    const result = validateModelAnswer(raw, passages);

    expect(result.answerable).toBe(false);
    expect(result.abstainReason).toBe('LOW_CONFIDENCE');
  });
});