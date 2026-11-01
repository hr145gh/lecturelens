export interface FaithfulnessResult {
  faithfulnessScore: number;
  unsupportedSentences: string[];
}

function sentenceTokens(text: string): Set<string> {
  const stopWords = new Set(['the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'is', 'are', 'was', 'were', 'that', 'this', 'with']);
  return new Set(
    (text.toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) ?? [])
      .filter((token) => !stopWords.has(token)),
  );
}

function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / a.size;
}

export function checkFaithfulness(
  summary: string,
  sectionText: string,
  threshold = 0.5,
): FaithfulnessResult {
  const sectionTokens = sentenceTokens(sectionText);
  const sentences = summary.match(/[^.!?]+(?:[.!?]+|$)/g)?.map((sentence) => sentence.trim()).filter(Boolean) ?? [];
  const unsupportedSentences: string[] = [];

  for (const sentence of sentences) {
    if (overlap(sentenceTokens(sentence), sectionTokens) < threshold) unsupportedSentences.push(sentence);
  }

  const score = sentences.length === 0 ? 0 : (sentences.length - unsupportedSentences.length) / sentences.length;
  return {
    faithfulnessScore: Math.round(score * 1000) / 1000,
    unsupportedSentences,
  };
}
