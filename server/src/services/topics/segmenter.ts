/**
 * Topic sections — NAVIGATION units for people (2–15 min, non-overlapping, labelled in the UI).
 * They are not retrieval chunks (services/chunking): both are built from the same transcript
 * segments, independently, for different purposes.
 *
 * Two methods behind one shape so they can be compared:
 *  - fixedWindow — the BASELINE ('fixed_window'). It exists to be beaten, not to ship as the answer.
 *  - embeddingSimilarity — the PROPOSED method ('embedding_similarity'): an UNSUPERVISED HEURISTIC
 *    over pretrained sentence embeddings. It is not a trained segmentation model.
 *
 * Pure functions: tuning values come in as options (the pipeline reads them from config/env.ts:
 * TOPIC_SECTION_SECONDS, TOPIC_SIM_THRESHOLD, TOPIC_MIN_SEC); the defaults are starting values.
 */

export interface TranscriptSegmentInput {
  index: number;
  startSec: number;
  endSec: number;
  text: string;
}

export interface TopicSectionOutput {
  index: number;
  startSec: number;
  endSec: number;
  segmentStart: number;
  segmentEnd: number;
  method: 'fixed_window' | 'embedding_similarity';
  boundaryScore: number | null;
}

export interface FixedWindowOptions {
  sectionSec?: number;
}

export interface EmbeddingSimilarityOptions {
  /** A gap is a boundary candidate only if the similarity across it is below this. */
  threshold?: number;
  /** No section shorter than this (seconds); closer boundaries are merged, strongest kept. */
  minSectionSec?: number;
  /** Segments per side of a gap. */
  windowSize?: number;
}

/**
 * Narrow interface for Member C's shared embedding helper (services/embeddings/). This module
 * never implements embedding inference itself.
 */
export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]> | number[][];
}

export const TOPIC_DEFAULTS = Object.freeze({
  sectionSec: 300,
  threshold: 0.45,
  minSectionSec: 120,
  windowSize: 3,
});

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

const orderedSegments = (segments: readonly TranscriptSegmentInput[]) =>
  [...segments].sort((a, b) => a.index - b.index);

/** Sections from cut positions (array offsets into `segments`; a cut at k starts a section at segment k). */
function sectionsFromBoundaries(
  segments: readonly TranscriptSegmentInput[],
  boundaries: readonly number[],
  lectureEndSec: number,
  method: TopicSectionOutput['method'],
  scores: ReadonlyMap<number, number> = new Map(),
): TopicSectionOutput[] {
  if (segments.length === 0) return [];
  const cuts = [...new Set([0, ...boundaries.filter((b) => b > 0 && b < segments.length), segments.length])].sort(
    (a, b) => a - b,
  );
  const sections: TopicSectionOutput[] = [];
  for (let i = 0; i < cuts.length - 1; i += 1) {
    const first = cuts[i]!;
    const last = cuts[i + 1]! - 1;
    sections.push({
      index: i,
      // Tiling (§4.5): first starts at 0, last ends at durationSec, internal edges at a segment start.
      startSec: i === 0 ? 0 : round3(segments[first]!.startSec),
      endSec: i === cuts.length - 2 ? round3(lectureEndSec) : round3(segments[last + 1]!.startSec),
      segmentStart: segments[first]!.index,
      segmentEnd: segments[last]!.index,
      method,
      boundaryScore: i === 0 ? null : (scores.get(first) ?? null),
    });
  }
  return sections;
}

/** BASELINE: a new section at the first segment starting after every `sectionSec`. */
export function fixedWindow(
  segments: readonly TranscriptSegmentInput[],
  lectureEndSec: number,
  options: FixedWindowOptions = {},
): TopicSectionOutput[] {
  const ordered = orderedSegments(segments);
  if (ordered.length === 0) return [];
  const sectionSec = options.sectionSec ?? TOPIC_DEFAULTS.sectionSec;
  if (!(sectionSec > 0)) throw new Error('sectionSec must be positive');

  const boundaries: number[] = [];
  for (let target = sectionSec; target < lectureEndSec; target += sectionSec) {
    const chosen = ordered.findIndex((s, i) => i > 0 && s.startSec >= target);
    if (chosen < 0) break;
    if (!boundaries.includes(chosen)) boundaries.push(chosen);
  }
  // boundaryScore is null for fixed_window (§4.5): there is no evidence of a topic change.
  return sectionsFromBoundaries(ordered, boundaries, lectureEndSec, 'fixed_window');
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  return normA === 0 || normB === 0 ? 0 : dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Cosine similarity across every gap that has a full window on both sides (diagnostics/evaluation). */
export async function gapSimilarities(
  segments: readonly TranscriptSegmentInput[],
  embedder: EmbeddingProvider,
  windowSize: number = TOPIC_DEFAULTS.windowSize,
): Promise<Array<{ gap: number; similarity: number }>> {
  const ordered = orderedSegments(segments);
  // Sliding windows of `windowSize` consecutive segments; window w covers segments w … w+size−1.
  const windows: string[] = [];
  for (let w = 0; w + windowSize <= ordered.length; w += 1) {
    windows.push(ordered.slice(w, w + windowSize).map((s) => s.text).join(' '));
  }
  if (windows.length < windowSize + 1) return []; // too short for a window on both sides of any gap
  const vectors = await embedder.embed(windows);
  if (vectors.length !== windows.length) throw new Error('Embedding provider returned an invalid vector count');

  // Gap g sits before segment g: compare the window ENDING at g−1 with the window STARTING at g —
  // consecutive, non-overlapping blocks, so the score reflects a change across the gap.
  const result: Array<{ gap: number; similarity: number }> = [];
  for (let g = windowSize; g + windowSize <= ordered.length; g += 1) {
    result.push({ gap: g, similarity: cosine(vectors[g - windowSize]!, vectors[g]!) });
  }
  return result;
}

/**
 * PROPOSED: boundaries at local minima of the cross-gap similarity that fall below `threshold`;
 * boundaries closer than `minSectionSec` to each other or to either end are merged, keeping the
 * strongest. boundaryScore = 1 − similarity at the chosen gap.
 */
export async function embeddingSimilarity(
  segments: readonly TranscriptSegmentInput[],
  lectureEndSec: number,
  embedder?: EmbeddingProvider,
  options: EmbeddingSimilarityOptions = {},
): Promise<TopicSectionOutput[]> {
  const ordered = orderedSegments(segments);
  if (ordered.length === 0) return [];
  if (!embedder) throw new Error('An embedding provider must be wired by Member C');
  const threshold = options.threshold ?? TOPIC_DEFAULTS.threshold;
  const minSectionSec = options.minSectionSec ?? TOPIC_DEFAULTS.minSectionSec;

  const gaps = await gapSimilarities(ordered, embedder, options.windowSize ?? TOPIC_DEFAULTS.windowSize);
  const candidates = gaps.filter((g, i) => {
    const before = gaps[i - 1]?.similarity ?? Infinity;
    const after = gaps[i + 1]?.similarity ?? Infinity;
    return g.similarity < threshold && g.similarity <= before && g.similarity <= after;
  });

  // Strongest first; accept a cut only if it keeps every section ≥ minSectionSec.
  const accepted: number[] = [];
  const scores = new Map<number, number>();
  for (const c of [...candidates].sort((a, b) => a.similarity - b.similarity)) {
    const at = ordered[c.gap]!.startSec;
    const farEnough =
      at >= minSectionSec &&
      lectureEndSec - at >= minSectionSec &&
      accepted.every((g) => Math.abs(ordered[g]!.startSec - at) >= minSectionSec);
    if (!farEnough) continue;
    accepted.push(c.gap);
    scores.set(c.gap, round3(Math.max(0, Math.min(1, 1 - c.similarity))));
  }

  return sectionsFromBoundaries(ordered, accepted.sort((a, b) => a - b), lectureEndSec, 'embedding_similarity', scores);
}

/**
 * Throws unless the sections tile [0, durationSec] exactly (CONTRACTS.md §4.5): index contiguous
 * from 0, first starts at 0, each starts where the previous ends, last ends at durationSec, every
 * section has positive length, and the segment ranges are contiguous, cover every segment, and
 * reference segments that exist.
 */
export function assertTopicTiling(
  sections: readonly TopicSectionOutput[],
  durationSec: number,
  segments: readonly TranscriptSegmentInput[],
): void {
  if (sections.length === 0) throw new Error('Topic sections must not be empty');
  const indexes = orderedSegments(segments).map((s) => s.index);
  const known = new Set(indexes);
  for (let i = 0; i < sections.length; i += 1) {
    const section = sections[i]!;
    const previous = sections[i - 1];
    if (section.index !== i) throw new Error('Topic section indexes must be contiguous from 0');
    if (i === 0 && section.startSec !== 0) throw new Error('Topic sections must start at 0');
    if (previous && previous.endSec !== section.startSec) throw new Error('Topic sections must tile without gaps or overlaps');
    if (!(section.endSec > section.startSec)) throw new Error(`Topic section ${i} must have positive length`);
    if (!known.has(section.segmentStart) || !known.has(section.segmentEnd)) {
      throw new Error('Every topic section must reference existing segments');
    }
    if (section.segmentEnd < section.segmentStart) throw new Error(`Topic section ${i} has an inverted segment range`);
    if (i === 0 && section.segmentStart !== indexes[0]) throw new Error('The first topic section must start at the first segment');
    if (previous && section.segmentStart !== previous.segmentEnd + 1) {
      throw new Error('Topic section segment ranges must be contiguous');
    }
  }
  const last = sections[sections.length - 1]!;
  if (last.endSec !== round3(durationSec)) throw new Error('Topic sections must end at lecture durationSec');
  if (last.segmentEnd !== indexes[indexes.length - 1]) throw new Error('Topic sections must cover every segment');
}
