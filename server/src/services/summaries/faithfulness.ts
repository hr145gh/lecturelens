import { contentTokens, splitSentences } from './text.js';

/**
 * Faithfulness check: for each summary sentence, the share of its content words that also occur in
 * the section text. Sentences below `threshold` go into unsupportedSentences; faithfulnessScore is
 * the share of sentences that pass. A cheap lexical signal for the reviewing teacher — it cannot
 * catch a contradiction made of the passage's own words, and it can flag a faithful paraphrase.
 */
export interface FaithfulnessResult {
  faithfulnessScore: number;
  unsupportedSentences: string[];
}

export const FAITHFULNESS_THRESHOLD = 0.5;

export function sentenceSupport(sentence: string, sectionText: string): number {
  const section = new Set(contentTokens(sectionText));
  const words = [...new Set(contentTokens(sentence))];
  if (words.length === 0) return 1; // nothing to check
  return words.filter((w) => section.has(w)).length / words.length;
}

export function checkFaithfulness(summary: string, sectionText: string, threshold = FAITHFULNESS_THRESHOLD): FaithfulnessResult {
  const sentences = splitSentences(summary);
  const unsupportedSentences = sentences.filter((s) => sentenceSupport(s, sectionText) < threshold);
  const score = sentences.length === 0 ? 0 : (sentences.length - unsupportedSentences.length) / sentences.length;
  return { faithfulnessScore: Math.round(score * 1000) / 1000, unsupportedSentences };
}
