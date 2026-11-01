import { z } from 'zod';
import { logger } from '../../utils/logger.js';

/**
 * Section labels: a 3–6 word title and 3–5 keywords per topic section. Asks the shared LLM client
 * (services/llm/client.ts, Member D — passed in by the pipeline; this module never calls a
 * provider itself) for JSON, validated with zod. Any failure — no client, provider error, invalid
 * JSON — falls back to the section's top TF-IDF terms, so labelling never fails the pipeline.
 */

export interface LlmClient {
  generateJson<T>(prompt: string, schema: z.ZodType<T>): Promise<T>;
}

const wordsIn = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

export const labellingSchema = z.object({
  label: z
    .string()
    .trim()
    .min(3)
    .max(80)
    .refine((s) => wordsIn(s) >= 3 && wordsIn(s) <= 6, 'must be 3–6 words'),
  keywords: z.array(z.string().trim().min(1).max(40)).min(3).max(5),
});

export type TopicLabel = z.infer<typeof labellingSchema> & { source: 'llm' | 'tfidf' };

const stopWords = new Set([
  'the', 'and', 'for', 'that', 'with', 'this', 'from', 'you', 'are', 'was', 'were', 'have', 'has',
  'but', 'not', 'its', 'into', 'we', 'our', 'they', 'about', 'what', 'when', 'which', 'there',
  'then', 'than', 'them', 'these', 'those', 'will', 'would', 'could', 'should', 'just', 'like',
  'some', 'also', 'very', 'here', 'your', 'okay', 'right', 'going', 'because', 'actually', 'really',
  // Spoken numbers and maths filler say nothing about a section's topic.
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'hundred',
  'thousand', 'point', 'equals', 'equal', 'times', 'plus', 'minus', 'negative', 'positive', 'half',
  'quarter', 'first', 'second', 'third', 'next', 'last', 'question', 'example', 'thing', 'things',
  'let', 'lets', "let's", 'say', 'see', 'look', 'know', 'think', 'want', 'get', 'got', 'make', 'way',
  'something', 'kind', 'sort', 'mean', 'means', 'can', 'just', 'now', 'well', 'good', 'great',
]);

/** Lower-case word tokens (Unicode letters incl. combining marks, so Devanagari words survive). */
function terms(text: string): string[] {
  return (text.toLowerCase().match(/\p{L}[\p{L}\p{M}'-]{2,}/gu) ?? []).filter((t) => !stopWords.has(t));
}

/**
 * Top TF-IDF terms of `text`: term frequency in this section × log((1 + N) / (1 + df)) + 1, where
 * df counts the lecture's sections (`corpus`, N of them) containing the term — so words common to
 * the whole lecture rank below words that distinguish this section. Ties break alphabetically.
 */
export function topTfidfTerms(text: string, limit = 5, corpus: readonly string[] = [text]): string[] {
  const docs = corpus.map((d) => new Set(terms(d)));
  const tf = new Map<string, number>();
  for (const t of terms(text)) tf.set(t, (tf.get(t) ?? 0) + 1);
  const idf = (t: string) => Math.log((1 + docs.length) / (1 + docs.filter((d) => d.has(t)).length)) + 1;
  return [...tf.entries()]
    .map(([t, n]) => [t, n * idf(t)] as const)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([t]) => t);
}

/** Fallback label from TF-IDF: always 3–5 keywords and a 3–6 word title. */
export function tfidfLabel(text: string, corpus: readonly string[] = [text]): TopicLabel {
  const keywords = topTfidfTerms(text, 5, corpus);
  for (const filler of ['lecture', 'section', 'topic']) if (keywords.length < 3 && !keywords.includes(filler)) keywords.push(filler);
  const title = keywords.slice(0, 3).join(' ');
  return {
    label: wordsIn(title) >= 3 ? title : `${title} lecture section`.split(/\s+/).slice(0, 6).join(' '),
    keywords,
    source: 'tfidf',
  };
}

export async function labelSection(
  text: string,
  { llm, corpus }: { llm?: LlmClient | null; corpus?: readonly string[] } = {},
): Promise<TopicLabel> {
  const fallback = () => tfidfLabel(text, corpus ?? [text]);
  if (!llm || !text.trim()) return fallback();
  try {
    const prompt =
      'You label sections of a recorded university lecture for students navigating it.\n' +
      'Return JSON {"label": string, "keywords": string[]}: "label" is a 3–6 word title for what this section ' +
      'teaches; "keywords" are 3–5 technical terms that actually appear in it. Use the lecture\'s language.\n\n' +
      `Section transcript:\n${text.slice(0, 12_000)}`;
    const result = await llm.generateJson(prompt, labellingSchema);
    return { ...result, source: 'llm' };
  } catch (err) {
    // Visible, not silent: a wrong LLM_MODEL or an outage should not hide behind fallback labels.
    logger.warn('LLM section labelling failed; using TF-IDF terms', { error: err instanceof Error ? err.message : String(err) });
    return fallback();
  }
}
