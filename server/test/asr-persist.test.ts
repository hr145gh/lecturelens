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


describe('ASR confidence threshold', () => {
  it('marks confidence 0.69 as low confidence', () => {
    expect(isLowConfidence(0.69)).toBe(true);
  });

  it('does not mark confidence 0.71 as low confidence', () => {
    expect(isLowConfidence(0.71)).toBe(false);
  });

  it('does not mark confidence exactly 0.70 as low confidence', () => {
    expect(isLowConfidence(0.70)).toBe(false);
  });
});
