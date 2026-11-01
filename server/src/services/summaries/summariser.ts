import { z } from 'zod';

export interface LlmClient {
  generateJson<T>(prompt: string, schema: z.ZodType<T>): Promise<T>;
}

export interface SummariserResult {
  summary: string;
  evidenceQuotes: string[];
  keyPoints: string[];
  model: string;
  promptVersion: string;
}

export const summaryResponseSchema = z.object({
  summary: z.string().trim().min(1),
  evidenceQuotes: z.array(z.string().trim().min(1).max(300)).min(2).max(3),
});

const stopWords = new Set([
  'the', 'and', 'for', 'that', 'with', 'this', 'from', 'you', 'are', 'was',
  'have', 'has', 'but', 'not', 'its', 'into', 'our', 'they', 'about', 'which',
]);

export function splitSentences(text: string): string[] {
  return text.match(/[^.!?]+(?:[.!?]+|$)/g)?.map((sentence) => sentence.trim()).filter(Boolean) ?? [];
}

function tokens(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g)?.filter((token) => !stopWords.has(token)) ?? [];
}

export function extractiveSummarise(text: string, limit = 3): string[] {
  const sentences = splitSentences(text).filter((sentence) => tokens(sentence).length > 0);
  if (sentences.length === 0) return [];
  if (sentences.length <= limit) return sentences;

  const documentFrequency = new Map<string, number>();
  const sentenceTokens = sentences.map((sentence) => {
    const counts = new Map<string, number>();
    for (const token of new Set(tokens(sentence))) counts.set(token, 1);
    return counts;
  });
  for (const counts of sentenceTokens) {
    for (const token of counts.keys()) documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
  }

  const vector = sentenceTokens.map((counts) => {
    const values = new Map<string, number>();
    for (const [token, count] of counts) {
      const idf = Math.log((sentences.length + 1) / ((documentFrequency.get(token) ?? 0) + 1)) + 1;
      values.set(token, count * idf);
    }
    return values;
  });
  const centroid = new Map<string, number>();
  for (const values of vector) {
    for (const [token, value] of values) centroid.set(token, (centroid.get(token) ?? 0) + value);
  }

  const similarity = (a: Map<string, number>, b: Map<string, number>) => {
    let dot = 0;
    let aNorm = 0;
    let bNorm = 0;
    for (const value of a.values()) aNorm += value * value;
    for (const value of b.values()) bNorm += value * value;
    for (const [token, value] of a) dot += value * (b.get(token) ?? 0);
    return dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm) || 1);
  };

  return sentences
    .map((sentence, index) => ({ sentence, index, score: similarity(vector[index]!, centroid) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .sort((a, b) => a.index - b.index)
    .map(({ sentence }) => sentence);
}

const basePrompt = (text: string, strict = false) =>
  `${strict ? 'STRICT OUTPUT REQUIREMENTS. ' : ''}Summarise the passage in 2-4 sentences. Use only what is in the passage; do not add knowledge or inference. Return 2-3 SHORT verbatim quotes from the passage that support the summary. Each quote must be an exact substring of the passage and at most 300 characters. Return only valid JSON with this exact shape: {"summary":"...","evidenceQuotes":["...","..."]}\n\nPASSAGE:\n${text}`;

export async function summariseSection(
  text: string,
  llm?: LlmClient,
): Promise<SummariserResult> {
  if (!text.trim()) {
    return {
      summary: '',
      evidenceQuotes: [],
      keyPoints: [],
      model: 'extractive-tfidf',
      promptVersion: 'summary-v1-fallback',
    };
  }

  if (llm) {
    try {
      const parsed = await llm.generateJson(basePrompt(text), summaryResponseSchema);
      return {
        summary: parsed.summary,
        evidenceQuotes: parsed.evidenceQuotes,
        keyPoints: splitSentences(parsed.summary).slice(0, 5),
        model: process.env.LLM_MODEL ?? 'llm',
        promptVersion: 'summary-v1',
      };
    } catch {
      try {
        const parsed = await llm.generateJson(basePrompt(text, true), summaryResponseSchema);
        return {
          summary: parsed.summary,
          evidenceQuotes: parsed.evidenceQuotes,
          keyPoints: splitSentences(parsed.summary).slice(0, 5),
          model: process.env.LLM_MODEL ?? 'llm',
          promptVersion: 'summary-v1-strict-retry',
        };
      } catch {
        // Fall through to extractive summarisation.
      }
    }
  }

  const sentences = extractiveSummarise(text, 3);
  const quoteSource = splitSentences(text);
  return {
    summary: sentences.join(' '),
    evidenceQuotes: quoteSource.slice(0, Math.min(3, quoteSource.length)),
    keyPoints: sentences.slice(0, 5),
    model: 'extractive-tfidf',
    promptVersion: 'summary-v1-fallback',
  };
}

export const summariseTopicSection = summariseSection;
