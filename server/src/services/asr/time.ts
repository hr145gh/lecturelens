
/**
 * Converts provider timestamps in milliseconds to seconds,
 * rounded to three decimal places.
 */
export function millisecondsToSeconds(milliseconds: number): number {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    throw new RangeError('Timestamp must be a finite, non-negative number of milliseconds.');
  }

  return Number((milliseconds / 1000).toFixed(3));
}
