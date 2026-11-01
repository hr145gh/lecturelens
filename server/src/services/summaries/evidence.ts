export interface EvidenceSegment {
  id?: unknown;
  index: number;
  startSec: number;
  endSec: number;
  text: string;
  chunkId?: unknown;
}

export interface EvidenceChunk {
  id?: unknown;
  _id?: unknown;
  segmentStart: number;
  segmentEnd: number;
  text: string;
}

export interface LinkedEvidence {
  chunkId: string;
  startSec: number;
  endSec: number;
  quote: string;
}

export function normaliseText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function overlapScore(a: string, b: string): number {
  const left = new Set(normaliseText(a).split(/[^a-z0-9]+/).filter((word) => word.length > 1));
  const right = new Set(normaliseText(b).split(/[^a-z0-9]+/).filter((word) => word.length > 1));
  if (left.size === 0 || right.size === 0) return 0;
  let overlap = 0;
  for (const word of left) if (right.has(word)) overlap += 1;
  return overlap / Math.sqrt(left.size * right.size);
}

function longestMatchedWords(quote: string, segmentText: string): string {
  const quoteWords: string[] =
    normaliseText(quote).match(/[a-z0-9]+(?:['-][a-z0-9]+)?/g) ?? [];
  const originalWords = segmentText.match(/\S+/g) ?? [];
  if (quoteWords.length === 0 || originalWords.length === 0) return '';
  const normalisedOriginal = originalWords.map((word) => normaliseText(word).replace(/[^a-z0-9'-]/g, ''));
  let bestStart = 0;
  let bestLength = 0;
  for (let start = 0; start < normalisedOriginal.length; start += 1) {
    for (let length = 1; start + length <= normalisedOriginal.length; length += 1) {
      const candidate = new Set(normalisedOriginal.slice(start, start + length));
      let matched = 0;
      for (const word of quoteWords) if (candidate.has(word.replace(/[^a-z0-9'-]/g, ''))) matched += 1;
      const overlap = matched / Math.sqrt(candidate.size * quoteWords.length);
      if (length > 1 && overlap === 1 && length > bestLength) {
        bestStart = start;
        bestLength = length;
      }
    }
  }
  if (bestLength === 0) {
    let bestWordStart = 0;
    let bestWordScore = 0;
    for (let index = 0; index < normalisedOriginal.length; index += 1) {
      if (quoteWords.includes(normalisedOriginal[index]!)) {
        const score = normalisedOriginal[index]!.length;
        if (score > bestWordScore) {
          bestWordScore = score;
          bestWordStart = index;
        }
      }
    }
    return originalWords.slice(bestWordStart, bestWordStart + 1).join(' ');
  }
  return originalWords.slice(bestStart, bestStart + bestLength).join(' ').slice(0, 300);
}

export function linkEvidence(
  quotes: readonly string[],
  segments: readonly EvidenceSegment[],
  chunks: readonly EvidenceChunk[] = [],
): LinkedEvidence[] {
  const evidence: LinkedEvidence[] = [];
  const orderedSegments = [...segments].sort((a, b) => a.index - b.index);

  for (const quote of quotes) {
    const normalisedQuote = normaliseText(quote);
    let matchedSegment: EvidenceSegment | undefined;
    let matchedQuote = '';
    let bestScore = -1;

    for (const segment of orderedSegments) {
      const normalisedSegment = normaliseText(segment.text);
      if (normalisedSegment.includes(normalisedQuote)) {
        matchedSegment = segment;
        const quotePattern = normalisedQuote
          .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          .replace(/\s+/g, '\\s+');
        const direct = segment.text.match(new RegExp(quotePattern, 'i'));
        matchedQuote = direct?.[0]?.slice(0, 300) ?? quote.trim().slice(0, 300);
        break;
      }
    }

    if (!matchedSegment) {
      for (const segment of orderedSegments) {
        const score = overlapScore(normalisedQuote, segment.text);
        if (score > bestScore) {
          bestScore = score;
          matchedSegment = segment;
        }
      }
      if (matchedSegment && bestScore > 0) matchedQuote = longestMatchedWords(normalisedQuote, matchedSegment.text);
    }

    if (!matchedSegment || !matchedQuote) continue;
    const chunk = chunks.find((candidate) =>
      matchedSegment!.index >= candidate.segmentStart && matchedSegment!.index <= candidate.segmentEnd,
    );
    const chunkId = chunk
      ? String(chunk.id ?? chunk._id ?? '')
      : matchedSegment.chunkId != null ? String(matchedSegment.chunkId) : '';
    if (!chunkId) continue;

    evidence.push({
      chunkId,
      startSec: Math.round(matchedSegment.startSec * 1000) / 1000,
      endSec: Math.round(matchedSegment.endSec * 1000) / 1000,
      quote: matchedQuote.slice(0, 300),
    });
  }

  return evidence.slice(0, 3);
}
