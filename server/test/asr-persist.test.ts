import { describe, expect, it } from 'vitest';
import { isLowConfidence, validateSegments } from '../src/services/asr/persist.js';
import type { AsrSegment } from '../src/services/asr/types.js';

const makeSegment = (
  startSec: number,
  endSec: number,
  text = 'word',
  confidence = 0.8,
): AsrSegment => ({
  startSec,
  endSec,
  text,
  confidence,
});

describe('ASR transcript persistence validation', () => {
  it('accepts valid, chronological, non-overlapping segments', () => {
    expect(() =>
      validateSegments([
        makeSegment(0, 0.4, 'Binary'),
        makeSegment(0.5, 0.9, 'search'),
      ]),
    ).not.toThrow();
  });

  it('rejects overlapping segments', () => {
    expect(() =>
      validateSegments([
        makeSegment(0, 0.6, 'Binary'),
        makeSegment(0.5, 0.9, 'search'),
      ]),
    ).toThrow(/overlapping/i);
  });

  it('rejects timestamps that are not strictly increasing', () => {
    expect(() =>
      validateSegments([
        makeSegment(1, 1.4, 'first'),
        makeSegment(0.5, 0.9, 'second'),
      ]),
    ).toThrow(/strictly increasing/i);
  });

  it('rejects zero-length or negative timestamps', () => {
    expect(() => validateSegments([makeSegment(1, 1, 'invalid')]))
      .toThrow(/invalid timestamps/i);

    expect(() => validateSegments([makeSegment(-1, 0.5, 'invalid')]))
      .toThrow(/invalid timestamps/i);
  });

  it('rejects confidence outside the range 0 to 1', () => {
    expect(() => validateSegments([makeSegment(0, 0.4, 'word', -0.1)]))
      .toThrow(/invalid confidence/i);

    expect(() => validateSegments([makeSegment(0, 0.4, 'word', 1.1)]))
      .toThrow(/invalid confidence/i);
  });

  it('rejects empty transcript text', () => {
    expect(() => validateSegments([makeSegment(0, 0.4, '   ')]))
      .toThrow(/empty transcript text/i);
  });

  it('accepts an empty segment array', () => {
    expect(() => validateSegments([])).not.toThrow();
  });
});


// CONTRACTS.md §4.3: lowConfidence = confidence < 0.75 (the PA.1 brief said 0.70; the frozen
// contract, mocks/transcript.json — segment 29 at 0.703 is low — and the client all use 0.75).
describe('ASR confidence threshold (CONTRACTS.md §4.3: < 0.75)', () => {
  it('marks 0.69 as low confidence (low under either cutoff)', () => {
    expect(isLowConfidence(0.69)).toBe(true);
  });

  it('marks 0.71 as low confidence (the brief expected false; the contract cutoff is 0.75)', () => {
    expect(isLowConfidence(0.71)).toBe(true);
  });

  it('marks 0.749 as low and exactly 0.75 as not low', () => {
    expect(isLowConfidence(0.749)).toBe(true);
    expect(isLowConfidence(0.75)).toBe(false);
  });

  it('agrees with every segment in mocks/transcript.json', async () => {
    const { readFileSync } = await import('node:fs');
    const fixture = JSON.parse(readFileSync(new URL('../../mocks/transcript.json', import.meta.url), 'utf8')) as {
      items: Array<{ confidence: number; lowConfidence: boolean }>;
    };
    for (const s of fixture.items) expect(isLowConfidence(s.confidence)).toBe(s.lowConfidence);
  });
});
