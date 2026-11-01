import { z } from 'zod';
import { contentTokens, splitSentences, wordTokens } from './text.js';

export { splitSentences };

/**
 * Section summarisation. Sends a topic section's transcript to the shared LLM client
 * (services/llm/client.ts, Member D — passed in by the caller) and asks for
 * { summary, evidenceQuotes } as JSON. Invalid output → one retry with a stricter instruction →
 * extractive fallback (the 3 most central sentences by TF-IDF), marked model "extractive-tfidf".
 * The LLM is a pretrained hosted model; we only prompt it.
 */

export interface LlmClient {
  generateJson<T>(prompt: string, schema: z.ZodType<T>): Promise<T>;
}

export interface SummariserResult {
  summary: string;
  evidenceQuotes: string[];
  keyPoints: string[];
  model: string;
  promptVersion: string;
  /** Why the extractive fallback was used (absent for LLM summaries). */
  fallbackReason?: string;
}

export const EXTRACTIVE_MODEL = 'extractive-tfidf';
export const PROMPT_VERSION = 'summary-v2';
const MAX_QUOTE_WORDS = 30;

const sentenceCount = (s: string) => splitSentences(s).length;

export const summaryResponseSchema = z.object({
  summary: z
    .string()
    .trim()
    .min(1)
    .refine((s) => sentenceCount(s) >= 2 && sentenceCount(s) <= 4, 'summary must be 2–4 sentences'),
  evidenceQuotes: z
    .array(
      z
        .string()
        .trim()
        .min(1)
        .max(300)
        .refine((q) => wordTokens(q).length <= MAX_QUOTE_WORDS, `quotes must be short (≤ ${MAX_QUOTE_WORDS} words)`),
    )
    .min(2)
    .max(3),
});

export function basePrompt(text: string, strict = false): string {
  return [
    strict
      ? 'Your previous answer was not usable. Follow EVERY rule exactly and return ONLY the JSON object.'
      : 'You summarise one section of a recorded university lecture for students.',
    'Rules:',
    '1. "summary": 2–4 sentences.',
    '2. Use ONLY what is in the passage below — no outside knowledge, no inference, no examples it does not give.',
    `3. "evidenceQuotes": 2–3 SHORT quotes (at most ${MAX_QUOTE_WORDS} words each) copied VERBATIM, character for character, from the passage, that support the summary.`,
    '4. Write in the language of the passage; keep technical terms as spoken.',
    'Return exactly: {"summary": "...", "evidenceQuotes": ["...", "..."]}',
    '',
    'PASSAGE:',
    text,
  ].join('\n');
}

/**
 * Extractive summarisation: the `limit` sentences most central to the section — cosine similarity
 * of each sentence's TF-IDF vector (IDF over the section's sentences) to the section centroid —
 * returned in their original order.
 */
export function extractiveSummarise(text: string, limit = 3): string[] {
  const sentences = splitSentences(text).filter((s) => contentTokens(s).length > 0);
  if (sentences.length <= limit) return sentences;

  const bags = sentences.map((s) => new Set(contentTokens(s)));
  const df = new Map<string, number>();
  for (const bag of bags) for (const t of bag) df.set(t, (df.get(t) ?? 0) + 1);
  const vectors = sentences.map((s) => {
    const tf = new Map<string, number>();
    for (const t of contentTokens(s)) tf.set(t, (tf.get(t) ?? 0) + 1);
    return new Map([...tf].map(([t, n]) => [t, n * (Math.log((1 + sentences.length) / (1 + df.get(t)!)) + 1)]));
  });
  const centroid = new Map<string, number>();
  for (const v of vectors) for (const [t, w] of v) centroid.set(t, (centroid.get(t) ?? 0) + w);
  const norm = (v: Map<string, number>) => Math.sqrt([...v.values()].reduce((a, w) => a + w * w, 0)) || 1;
  const cos = (a: Map<string, number>, b: Map<string, number>) => {
    let dot = 0;
    for (const [t, w] of a) dot += w * (b.get(t) ?? 0);
    return dot / (norm(a) * norm(b));
  };

  return sentences
    .map((sentence, index) => ({ sentence, index, score: cos(vectors[index]!, centroid) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .sort((a, b) => a.index - b.index)
    .map(({ sentence }) => sentence);
}

/** The first `MAX_QUOTE_WORDS` words of a sentence, verbatim (so it is a substring of the passage). */
function quoteFrom(sentence: string): string {
  const words = sentence.split(/\s+/);
  return words.length <= MAX_QUOTE_WORDS ? sentence : words.slice(0, MAX_QUOTE_WORDS).join(' ');
}

/** 2–5 key points (§4.6) from the summary's sentences, topped up from the section if it is very short. */
export function keyPointsFor(summary: string, sectionText: string): string[] {
  const points = splitSentences(summary).slice(0, 5);
  for (const s of extractiveSummarise(sectionText, 5)) {
    if (points.length >= 2) break;
    if (!points.includes(s)) points.push(s);
  }
  if (points.length < 2) {
    const terms = [...new Set(contentTokens(sectionText))].slice(0, 5);
    points.push(terms.length ? `Key terms: ${terms.join(', ')}.` : 'Short section; see the transcript.');
  }
  return points;
}

export function extractiveResult(text: string, fallbackReason: string): SummariserResult {
  const sentences = extractiveSummarise(text, 3);
  const summary = sentences.join(' ');
  return {
    summary,
    evidenceQuotes: sentences.slice(0, 3).map(quoteFrom), // the summary's own sentences: always locatable
    keyPoints: keyPointsFor(summary, text),
    model: EXTRACTIVE_MODEL,
    promptVersion: 'summary-v2-extractive',
    fallbackReason,
  };
}

export async function summariseSection(text: string, llm?: LlmClient | null, modelName = 'llm'): Promise<SummariserResult> {
  if (!text.trim()) return extractiveResult(text, 'empty section');
  if (!llm) return extractiveResult(text, 'no LLM client configured');

  let lastError = '';
  for (const strict of [false, true]) {
    try {
      const parsed = await llm.generateJson(basePrompt(text, strict), summaryResponseSchema);
      return {
        summary: parsed.summary,
        evidenceQuotes: parsed.evidenceQuotes,
        keyPoints: keyPointsFor(parsed.summary, text),
        model: modelName,
        promptVersion: strict ? `${PROMPT_VERSION}-strict` : PROMPT_VERSION,
      };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  return extractiveResult(text, `LLM output unusable after a strict retry: ${lastError}`);
}

export const summariseTopicSection = summariseSection;
