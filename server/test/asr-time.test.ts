
import { describe, expect, it } from 'vitest';
import { millisecondsToSeconds } from '../src/services/asr/time.js';

describe('millisecondsToSeconds', () => {
  it('converts milliseconds to seconds rounded to three decimals', () => {
    expect(millisecondsToSeconds(1234)).toBe(1.234);
    expect(millisecondsToSeconds(12345.67)).toBe(12.346);
    expect(millisecondsToSeconds(1000)).toBe(1);
    expect(millisecondsToSeconds(0)).toBe(0);
  });

  it('rejects invalid timestamps', () => {
    expect(() => millisecondsToSeconds(-1)).toThrow(RangeError);
    expect(() => millisecondsToSeconds(Number.NaN)).toThrow(RangeError);
    expect(() => millisecondsToSeconds(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});
