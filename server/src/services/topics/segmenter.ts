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

export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]> | number[][];
}

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

const orderedSegments = (segments: readonly TranscriptSegmentInput[]) =>
  [...segments].sort((a, b) => a.index - b.index);

function sectionsFromBoundaries(
  segments: readonly TranscriptSegmentInput[],
  boundaries: readonly number[],
  lectureEndSec: number,
  method: TopicSectionOutput['method'],
  scores: ReadonlyMap<number, number> = new Map(),
): TopicSectionOutput[] {
  if (segments.length === 0) return [];
  const cuts = [0, ...boundaries.filter((boundary) => boundary > 0 && boundary < segments.length), segments.length];
  const uniqueCuts = [...new Set(cuts)].sort((a, b) => a - b);
  const sections: TopicSectionOutput[] = [];

  for (let i = 0; i < uniqueCuts.length - 1; i += 1) {
    const segmentStart = uniqueCuts[i]!;
    const segmentEnd = uniqueCuts[i + 1]! - 1;
    const startSec = i === 0 ? 0 : round3(segments[segmentStart]!.startSec);
    const endSec = i === uniqueCuts.length - 2 ? round3(lectureEndSec) : round3(segments[segmentEnd + 1]!.startSec);
    sections.push({
      index: i,
      startSec,
      endSec,
      segmentStart: segments[segmentStart]!.index,
      segmentEnd: segments[segmentEnd]!.index,
      method,
      boundaryScore: i === 0 ? null : scores.get(segmentStart) ?? null,
    });
  }
  return sections;
}

/** Fixed-window navigation is the comparison baseline, not the proposed segmentation answer. */
export function fixedWindow(
  segments: readonly TranscriptSegmentInput[],
  lectureEndSec: number,
  options: FixedWindowOptions = {},
): TopicSectionOutput[] {
  const ordered = orderedSegments(segments);
  if (ordered.length === 0) return [];
  const sectionSec =
    options.sectionSec ??
    (Number(process.env.TOPIC_SECTION_SECONDS ?? 300) || 300);

  const boundaries: number[] = [];
  let target = sectionSec;
  while (target < lectureEndSec) {
    let chosen = -1;
    for (let i = 1; i < ordered.length; i += 1) {
      if (ordered[i]!.startSec >= target) {
        chosen = i;
        break;
      }
    }
    if (chosen < 0) break;
    if (!boundaries.includes(chosen)) boundaries.push(chosen);
    target += sectionSec;
  }
  return sectionsFromBoundaries(ordered, boundaries, lectureEndSec, 'fixed_window');
}

const cosine = (a: readonly number[], b: readonly number[]): number => {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  return normA === 0 || normB === 0 ? 0 : dot / (Math.sqrt(normA) * Math.sqrt(normB));
};

/**
 * Proposed topic segmentation is an unsupervised heuristic over pretrained embeddings,
 * not a trained segmentation model.
 */
export async function embeddingSimilarity(
  segments: readonly TranscriptSegmentInput[],
  lectureEndSec: number,
  embedder?: EmbeddingProvider,
): Promise<TopicSectionOutput[]> {
  const ordered = orderedSegments(segments);
  if (ordered.length === 0) return [];
  if (!embedder) throw new Error('An embedding provider must be wired by Member C');

  const threshold = Number(process.env.TOPIC_SIM_THRESHOLD ?? 0.45) || 0.45;
  const minSectionSec = Number(process.env.TOPIC_MIN_SEC ?? 120) || 120;

  const windows: string[] = [];
  for (let i = 0; i <= ordered.length - 3; i += 1) {
    windows.push(`${ordered[i]!.text} ${ordered[i + 1]!.text} ${ordered[i + 2]!.text}`);
  }
  const vectors = await embedder.embed(windows);
  if (vectors.length !== windows.length) throw new Error('Embedding provider returned an invalid vector count');

  const similarities: Array<{ windowStart: number; similarity: number }> = [];
  for (let i = 0; i < vectors.length - 1; i += 1) {
    similarities.push({ windowStart: i + 2, similarity: cosine(vectors[i]!, vectors[i + 1]!) });
  }

  const candidates: Array<{ segmentIndex: number; boundaryScore: number }> = [];
  for (let i = 1; i < similarities.length - 1; i += 1) {
    const current = similarities[i]!;
    if (
      current.similarity < threshold &&
      current.similarity <= similarities[i - 1]!.similarity &&
      current.similarity <= similarities[i + 1]!.similarity
    ) {
      candidates.push({ segmentIndex: current.windowStart, boundaryScore: 1 - current.similarity });
    }
  }

  const boundaries: number[] = [];
  const scores = new Map<number, number>();
  let previousCutSec = 0;
  for (const candidate of candidates.sort((a, b) =>
    ordered[a.segmentIndex]!.startSec - ordered[b.segmentIndex]!.startSec,
  )) {
    const cutSec = ordered[candidate.segmentIndex]!.startSec;
    if (cutSec - previousCutSec >= minSectionSec && lectureEndSec - cutSec >= minSectionSec) {
      boundaries.push(candidate.segmentIndex);
      scores.set(candidate.segmentIndex, Math.max(0, Math.min(1, candidate.boundaryScore)));
      previousCutSec = cutSec;
    }
  }

  return sectionsFromBoundaries(ordered, boundaries, lectureEndSec, 'embedding_similarity', scores);
}

export function assertTopicTiling(
  sections: readonly TopicSectionOutput[],
  durationSec: number,
  segments: readonly TranscriptSegmentInput[],
): void {
  if (sections.length === 0) throw new Error('Topic sections must not be empty');
  for (let i = 0; i < sections.length; i += 1) {
    const section = sections[i]!;
    if (section.index !== i) throw new Error('Topic section indexes must be contiguous from 0');
    if (i === 0 && section.startSec !== 0) throw new Error('Topic sections must start at 0');
    if (i > 0 && sections[i - 1]!.endSec !== section.startSec) {
      throw new Error('Topic sections must tile without gaps or overlaps');
    }
    if (i === sections.length - 1 && section.endSec !== round3(durationSec)) {
      throw new Error('Topic sections must end at lecture durationSec');
    }
    const segmentIndexes = new Set(segments.map((segment) => segment.index));
    if (!segmentIndexes.has(section.segmentStart) || !segmentIndexes.has(section.segmentEnd)) {
      throw new Error('Every topic section must reference existing segments');
    }
  }
}
