
import {
  keywordSearch,
  type KeywordResult,
} from './keyword.js';
import {
  vectorSearch,
  type VectorResult,
} from './vector.js';

const RRF_K = 60;

export type HybridResult = {
  chunkId: string;
  lectureId: string;
  startSec: number;
  endSec: number;
  text: string;
  score: number;
};

interface HybridSearchOptions {
  query: string;
  allowedLectureIds: string[];
  k: number;
}

/**
 * Combine ranked vector and keyword results using Reciprocal Rank Fusion.
 * RRF score = sum(1 / (60 + rank)), where rank starts at 1.
 */
export function fuseHybridResults(
  vectorResults: VectorResult[],
  keywordResults: KeywordResult[],
  k: number,
): HybridResult[] {
  const fused = new Map<string, HybridResult>();

  function addResults(
    results: Array<VectorResult | KeywordResult>,
  ): void {
    results.forEach((result, index) => {
      const rank = index + 1;
      const rrfScore = 1 / (RRF_K + rank);
      const existing = fused.get(result.chunkId);

      if (existing) {
        existing.score += rrfScore;
      } else {
        fused.set(result.chunkId, {
          chunkId: result.chunkId,
          lectureId: result.lectureId,
          startSec: result.startSec,
          endSec: result.endSec,
          text: result.text,
          score: rrfScore,
        });
      }
    });
  }

  addResults(vectorResults);
  addResults(keywordResults);

  return [...fused.values()]
  .sort((a, b) => b.score - a.score || a.chunkId.localeCompare(b.chunkId))
  .slice(0, Math.max(0, k));
}

export async function hybridSearch({
  query,
  allowedLectureIds,
  k,
}: HybridSearchOptions): Promise<HybridResult[]> {
  if (allowedLectureIds.length === 0 || k <= 0) {
    return [];
  }

  const [vectorResults, keywordResults] = await Promise.all([
    vectorSearch({ query, allowedLectureIds, k }),
    keywordSearch({ query, allowedLectureIds, k }),
  ]);

  return fuseHybridResults(vectorResults, keywordResults, k);
}
