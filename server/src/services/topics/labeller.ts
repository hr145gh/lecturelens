import { z } from 'zod';

export interface LlmClient {
  generateJson<T>(prompt: string, schema: z.ZodType<T>): Promise<T>;
}

const labellingSchema = z.object({
  label: z.string().trim().min(3).max(80),
  keywords: z.array(z.string().trim().min(1)).min(3).max(5),
});

export type TopicLabel = z.infer<typeof labellingSchema>;

const stopWords = new Set([
  'the', 'and', 'for', 'that', 'with', 'this', 'from', 'you', 'are', 'was',
  'have', 'has', 'but', 'not', 'its', 'into', 'we', 'our', 'they', 'about',
]);

export function topTfidfTerms(text: string, limit = 4): string[] {
  const terms = text.toLowerCase().match(/[a-z][a-z-]{3,}/g) ?? [];
  const frequencies = new Map<string, number>();
  for (const term of terms) {
    if (!stopWords.has(term)) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
  }
  return [...frequencies.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, Math.max(limit, 3))
    .map(([term]) => term)
    .slice(0, 5);
}

/** Uses the shared LLM client when Member D provides one; never invents a second provider. */
export async function labelSection(
  text: string,
  llm?: LlmClient,
): Promise<TopicLabel> {
  if (!llm) {
    const terms = topTfidfTerms(text, 4);
    return { label: terms.slice(0, 3).join(' ') || 'Lecture topic', keywords: terms };
  }

  try {
    const prompt =
      'Return only valid JSON for this lecture section. Provide a concise 3–6 word title ' +
      'and 3–5 keywords.\n' + text;
    return await llm.generateJson(prompt, labellingSchema);
  } catch {
    const terms = topTfidfTerms(text, 4);
    return { label: terms.slice(0, 3).join(' ') || 'Lecture topic', keywords: terms };
  }
}
