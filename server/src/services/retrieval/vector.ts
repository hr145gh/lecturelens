
import { Types } from 'mongoose';
import { Chunk } from '../../models/index.js';
import { embed } from '../embeddings/embedder.js';

export interface VectorResult {
  chunkId: string;
  lectureId: string;
  startSec: number;
  endSec: number;
  text: string;
  score: number;
}

interface VectorSearchOptions {
  query: string;
  allowedLectureIds: string[];
  k: number;
}

export async function vectorSearch({
  query,
  allowedLectureIds,
  k,
}: VectorSearchOptions): Promise<VectorResult[]> {
  if (allowedLectureIds.length === 0 || k <= 0) {
    return [];
  }

  const [queryVector] = await embed([query]);

  if (!queryVector) {
    return [];
  }

  const chunks = await Chunk.find({
    lectureId: {
      $in: allowedLectureIds
        .filter((id) => Types.ObjectId.isValid(id))
        .map((id) => new Types.ObjectId(id)),
    },
    embedding: { $size: queryVector.length },
  })
    .select('+embedding')
    .lean()
    .exec();

  const results: VectorResult[] = chunks.map((chunk) => {
    const score = chunk.embedding.reduce(
      (sum, value, index) => sum + value * queryVector[index],
      0,
    );

    return {
      chunkId: String(chunk._id),
      lectureId: String(chunk.lectureId),
      startSec: chunk.startSec,
      endSec: chunk.endSec,
      text: chunk.text,
      score,
    };
  });

  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
