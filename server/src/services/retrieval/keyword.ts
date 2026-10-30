
import { Types } from 'mongoose';
import { Chunk } from '../../models/index.js';

export interface KeywordResult {
  chunkId: string;
  lectureId: string;
  startSec: number;
  endSec: number;
  text: string;
  score: number;
}

interface KeywordSearchOptions {
  query: string;
  allowedLectureIds: string[];
  k: number;
}

const K1 = 1.5;
const B = 0.75;

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

export async function keywordSearch({
  query,
  allowedLectureIds,
  k,
}: KeywordSearchOptions): Promise<KeywordResult[]> {
  if (allowedLectureIds.length === 0 || k <= 0) {
    return [];
  }

  const lectureIds = allowedLectureIds
    .filter((id) => Types.ObjectId.isValid(id))
    .map((id) => new Types.ObjectId(id));

  if (lectureIds.length === 0) {
    return [];
  }

  const queryTerms = tokenize(query);

  if (queryTerms.length === 0) {
    return [];
  }

  const chunks = await Chunk.find({
    lectureId: { $in: lectureIds },
  })
    .select('lectureId startSec endSec text')
    .lean()
    .exec();

  if (chunks.length === 0) {
    return [];
  }

  const documents = chunks.map((chunk) => ({
    chunk,
    terms: tokenize(chunk.text),
  }));

  const documentFrequency = new Map<string, number>();

  for (const document of documents) {
    for (const term of new Set(document.terms)) {
      documentFrequency.set(
        term,
        (documentFrequency.get(term) ?? 0) + 1,
      );
    }
  }

  const totalDocuments = documents.length;
  const averageLength =
    documents.reduce((sum, document) => sum + document.terms.length, 0) /
    totalDocuments;

  const results: KeywordResult[] = [];

  for (const document of documents) {
    const termFrequency = new Map<string, number>();

    for (const term of document.terms) {
      termFrequency.set(term, (termFrequency.get(term) ?? 0) + 1);
    }

    let score = 0;
    const documentLength = document.terms.length;

    for (const term of queryTerms) {
      const frequency = termFrequency.get(term) ?? 0;

      if (frequency === 0) {
        continue;
      }

      const df = documentFrequency.get(term) ?? 0;
      const idf = Math.log(
        1 + (totalDocuments - df + 0.5) / (df + 0.5),
      );

      const denominator =
        frequency +
        K1 * (1 - B + B * documentLength / (averageLength || 1));

      score +=
        idf *
        (frequency * (K1 + 1)) /
        denominator;
    }

    if (score > 0) {
      results.push({
        chunkId: String(document.chunk._id),
        lectureId: String(document.chunk.lectureId),
        startSec: document.chunk.startSec,
        endSec: document.chunk.endSec,
        text: document.chunk.text,
        score,
      });
    }
  }

  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
