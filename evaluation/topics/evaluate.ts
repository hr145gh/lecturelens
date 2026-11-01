export function boundaryMetrics(
  predicted: readonly number[],
  reference: readonly number[],
  tolerance = 1,
): { precision: number; recall: number; f1: number } {
  const matchedReference = new Set<number>();
  const matchedPredicted = new Set<number>();
  for (let p = 0; p < predicted.length; p += 1) {
    for (let r = 0; r < reference.length; r += 1) {
      if (Math.abs(predicted[p]! - reference[r]! ) <= tolerance) {
        matchedPredicted.add(p);
        matchedReference.add(r);
      }
    }
  }
  const precision = predicted.length === 0 ? 0 : matchedPredicted.size / predicted.length;
  const recall = reference.length === 0 ? 0 : matchedReference.size / reference.length;
  const f1 = precision + recall === 0 ? 0 : 2 * precision * recall / (precision + recall);
  return {
    precision: Math.round(precision * 1000) / 1000,
    recall: Math.round(recall * 1000) / 1000,
    f1: Math.round(f1 * 1000) / 1000,
  };
}

export function windowDiff(
  reference: readonly number[],
  hypothesis: readonly number[],
  windowSize: number,
): number {
  if (windowSize <= 0 || reference.length !== hypothesis.length) return 0;
  if (windowSize >= reference.length) return 0;
  let differences = 0;
  let windows = 0;
  const maxStart = reference.length - windowSize;
  const countBoundaries = (set: readonly number[], start: number, end: number) =>
    set.slice(start, end).filter((boundary) => boundary !== 0).length;
  for (let start = 0; start <= maxStart; start += 1) {
    const end = start + windowSize;
    if (countBoundaries(reference, start, end) !== countBoundaries(hypothesis, start, end)) differences += 1;
    windows += 1;
  }
  return windows === 0 ? 0 : Math.round((differences / windows) * 1000) / 1000;
}

function mask(length: number, boundaries: readonly number[]): number[] {
  const result = Array.from({ length }, () => 0);
  for (const boundary of new Set(boundaries)) {
    if (boundary > 0 && boundary < length) result[boundary] = 1;
  }
  return result;
}

export function evaluateBoundarySets(
  predicted: readonly number[],
  reference: readonly number[],
  segmentCount: number,
  tolerance = 1,
  windowSize = 3,
) {
  const metrics = boundaryMetrics(predicted, reference, tolerance);
  return {
    ...metrics,
    windowDiff: windowDiff(mask(segmentCount, reference), mask(segmentCount, predicted), windowSize),
  };
}
