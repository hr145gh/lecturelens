import { describe, expect, it } from 'vitest';
import { boundaryFlags, boundaryMetrics, defaultK, evaluateBoundarySets, windowDiff } from './evaluate.js';

const seq = (s: string) => [...s].map(Number);

describe('WindowDiff (Pevzner & Hearst, 2002)', () => {
  // The worked example in NLTK's documentation of nltk.metrics.segmentation.windowdiff:
  //   s1 = "000100000010", s2 = "000010000100", s3 = "100000010000", k = 3
  //   windowdiff(s1, s1, 3) = 0.00 · windowdiff(s1, s2, 3) = 0.30 · windowdiff(s2, s3, 3) = 0.80
  // (values checked against an independent re-implementation; NLTK itself is not a dependency here).
  const [s1, s2, s3] = ['000100000010', '000010000100', '100000010000'].map(seq);

  it('matches the published worked example', () => {
    expect(windowDiff(s1!, s1!, 3)).toBe(0);
    expect(windowDiff(s1!, s2!, 3)).toBe(0.3);
    expect(windowDiff(s2!, s3!, 3)).toBe(0.8);
  });

  it('rejects invalid input instead of silently returning 0', () => {
    expect(() => windowDiff(s1!, s1!.slice(1), 3)).toThrow(/same length/);
    expect(() => windowDiff(s1!, s1!, 0)).toThrow(/k must be/);
    expect(() => windowDiff(s1!, s1!, 13)).toThrow(/k must be/);
  });
});

describe('boundary precision / recall / F1 (±1 tolerance)', () => {
  it('matches one-to-one: one prediction cannot satisfy two reference boundaries', () => {
    expect(boundaryMetrics([5], [4, 6], 1)).toEqual({ precision: 1, recall: 0.5, f1: 0.667 });
    expect(boundaryMetrics([4, 5], [4], 1)).toEqual({ precision: 0.5, recall: 1, f1: 0.667 });
  });

  it('counts a boundary within the tolerance, not beyond it', () => {
    expect(boundaryMetrics([3, 7], [4, 9], 1)).toEqual({ precision: 0.5, recall: 0.5, f1: 0.5 });
    expect(boundaryMetrics([], [4], 1)).toEqual({ precision: 0, recall: 0, f1: 0 });
  });

  it('reproduces the reported fixed_window numbers by hand (Gate Smashers: 1 of 6 boundaries found)', () => {
    const m = evaluateBoundarySets([11], [1, 4, 7, 11, 14, 19], 23, 1);
    expect(m).toMatchObject({ precision: 1, recall: 0.167, f1: 0.286, k: 2 });
  });
});

describe('helpers', () => {
  it('boundary flags live on the n − 1 gaps; k is half the mean reference section length', () => {
    expect(boundaryFlags(5, [1, 3])).toEqual([0, 1, 0, 1]);
    expect(defaultK(45, [7, 16, 24, 35])).toBe(5); // 45 segments / 5 sections / 2 = 4.5 → 5
  });
});
