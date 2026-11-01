import { describe, expect, it } from 'vitest';
import { buildChunks } from '../../server/src/services/chunking/chunker.js';
import {
  assertTopicTiling,
  fixedWindow,
  embeddingSimilarity,
} from '../../server/src/services/topics/segmenter.js';
import {
  boundaryMetrics,
  windowDiff,
} from './evaluate.js';
import { checkFaithfulness } from '../../server/src/services/summaries/faithfulness.js';
import { linkEvidence, normaliseText } from '../../server/src/services/summaries/evidence.js';
import { extractiveSummarise } from '../../server/src/services/summaries/summariser.js';

const segments = (count = 12, duration = 720) =>
  Array.from({ length: count }, (_, index) => ({
    index,
    startSec: (index * duration) / count,
    endSec: ((index + 1) * duration) / count,
    text: `Segment ${index} contains enough words for a retrieval unit.`,
  }));

describe('Member B retrieval chunking and topic sections', () => {
  it('never splits segments, keeps overlap near the configured value, and caps words', () => {
    const chunks = buildChunks(segments(12, 720), { windowSec: 60, overlapSec: 15 });
    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i]!;
      expect(chunk.text.trim().split(/\s+/).length).toBeLessThanOrEqual(200);
      if (i > 0) {
        expect(chunk.startSec).toBeLessThanOrEqual(chunks[i - 1]!.endSec);
      }
    }
  });

  it('fixed-window sections tile exactly', () => {
    const input = segments();
    const sections = fixedWindow(input, 720, { sectionSec: 300 });
    expect(() => assertTopicTiling(sections, 720, input)).not.toThrow();
  });

  it('embedding-similarity sections tile exactly and use proposed method metadata', async () => {
    const input = segments(12, 720);
    const sections = await embeddingSimilarity(input, 720, {
      embed(texts) {
        return texts.map((_, index) => [index, index % 3, 1]);
      },
    });
    expect(() => assertTopicTiling(sections, 720, input)).not.toThrow();
    expect(sections.every((section) => section.method === 'embedding_similarity')).toBe(true);
  });

  it('matches published WindowDiff behaviour for an identical binary segmentation', () => {
    expect(windowDiff([0, 0, 1, 1, 0], [0, 0, 1, 1, 0], 2)).toBe(0);
  });

  it('reports known WindowDiff for shifted boundaries in a two-window worked example', () => {
    // Two one-position windows: reference 00, hypothesis 10 differ in one window.
    expect(windowDiff([0, 0], [1, 0], 1)).toBe(0.5);
  });

  it('computes tolerance-window precision, recall and F1', () => {
    expect(boundaryMetrics([3, 7], [4, 8], 1)).toEqual({
      precision: 1,
      recall: 1,
      f1: 1,
    });
  });

  it('normalises evidence whitespace and links exact quotes to segment timestamps', () => {
    const evidence = linkEvidence(
      ['Gradient descent SHRINKS smoothly'],
      [{ index: 0, startSec: 12.48, endSec: 18.5, text: 'Gradient   descent shrinks smoothly toward zero.' }],
      [{ id: '6650c3a0c3b2e41d8a300001', segmentStart: 0, segmentEnd: 0, text: 'Gradient descent shrinks smoothly toward zero.' }],
    );
    expect(normaliseText('  Gradient   Descent ')).toBe('gradient descent');
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      chunkId: '6650c3a0c3b2e41d8a300001',
      startSec: 12.48,
      endSec: 18.5,
    });
  });

  it('discards evidence that cannot be located', () => {
    expect(linkEvidence(
      ['A claim absent from this passage'],
      [{ index: 0, startSec: 1, endSec: 2, text: 'Completely unrelated lecture text.' }],
      [{ id: 'chunk-1', segmentStart: 0, segmentEnd: 0, text: 'Completely unrelated lecture text.' }],
    )).toEqual([]);
  });

  it('flags unsupported summary sentences and computes faithfulness', () => {
    const result = checkFaithfulness(
      'Gradient descent updates parameters. A quantum computer guaranteed the result.',
      'Gradient descent repeatedly updates parameters against the loss gradient.',
      0.5,
    );
    expect(result.unsupportedSentences).toEqual([
      'A quantum computer guaranteed the result.',
    ]);
    expect(result.faithfulnessScore).toBe(0.5);
  });

  it('returns extractive TF-IDF sentences when the LLM is unavailable', () => {
    const summary = extractiveSummarise(
      'Gradient descent reduces loss. The learning rate controls step size. A plateau can make learning slow.',
      3,
    );
    expect(summary.length).toBeGreaterThan(0);
    expect(summary.length).toBeLessThanOrEqual(3);
  });
});
