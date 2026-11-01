import type { z } from 'zod';
import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';

/**
 * The shared LLM client — owned by Member D (CLAUDE.md). Modules use this; they never call an
 * LLM provider themselves. OpenAI-compatible chat completions at LLM_BASE_URL (Groq by default),
 * JSON output validated with zod. The model is a PRETRAINED HOSTED SERVICE: we only prompt it.
 */

export interface LlmClient {
  /** Ask for a JSON object; resolves only with output that passes `schema`, else rejects. */
  generateJson<T>(prompt: string, schema: z.ZodType<T>): Promise<T>;
}

export class LlmError extends Error {
  constructor(message: string, readonly status: number | null = null) {
    super(message);
    this.name = 'LlmError';
  }
}

const DEFAULT_BASE_URL = 'https://api.groq.com/openai/v1';
const DEFAULT_MODEL = 'openai/gpt-oss-120b'; // overridden by LLM_MODEL
const TIMEOUT_MS = 60_000;

/** Mutable so tests can shorten the waits. Retries are for 429 / 5xx only. */
export const llmRetryPolicy = { retries: 3, baseDelayMs: 1_000, maxDelayMs: 20_000 };

/** The API key that belongs to the configured base URL; null when none is configured. */
function apiKeyFor(baseUrl: string): string | null {
  if (/groq\.com/.test(baseUrl)) return env.GROQ_API_KEY ?? null;
  if (/openrouter\.ai/.test(baseUrl)) return env.OPENROUTER_API_KEY ?? null;
  return env.GROQ_API_KEY ?? env.OPENROUTER_API_KEY ?? null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createLlmClient(opts: { baseUrl: string; apiKey: string; model: string }): LlmClient {
  const url = `${opts.baseUrl.replace(/\/$/, '')}/chat/completions`;

  async function complete(messages: Array<{ role: 'system' | 'user'; content: string }>): Promise<string> {
    for (let attempt = 1; ; attempt++) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: opts.model, messages, temperature: 0, response_format: { type: 'json_object' } }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (response.ok) {
        const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
        const content = body.choices?.[0]?.message?.content;
        if (typeof content !== 'string') throw new LlmError('LLM response had no message content');
        return content;
      }
      const retryable = response.status === 429 || response.status >= 500;
      const detail = (await response.text()).slice(0, 300);
      if (!retryable || attempt > llmRetryPolicy.retries) {
        throw new LlmError(`LLM request failed (HTTP ${response.status}): ${detail}`, response.status);
      }
      const waitMs = Math.min(llmRetryPolicy.maxDelayMs, llmRetryPolicy.baseDelayMs * 2 ** (attempt - 1));
      logger.warn('LLM request failed; retrying', { status: response.status, attempt, retryInMs: waitMs });
      await sleep(waitMs);
    }
  }

  return {
    async generateJson<T>(prompt: string, schema: z.ZodType<T>): Promise<T> {
      const messages: Array<{ role: 'system' | 'user'; content: string }> = [
        { role: 'system', content: 'Reply with a single JSON object only, no prose and no code fences.' },
        { role: 'user', content: prompt },
      ];
      let lastProblem = '';
      // One extra try when the output is not valid JSON or does not match the schema.
      for (let attempt = 1; attempt <= 2; attempt++) {
        const content = await complete(messages);
        let parsed: unknown;
        try {
          parsed = JSON.parse(content);
        } catch {
          lastProblem = 'output was not valid JSON';
          continue;
        }
        const result = schema.safeParse(parsed);
        if (result.success) return result.data;
        lastProblem = `output did not match the schema: ${result.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`;
      }
      throw new LlmError(`LLM ${lastProblem}`);
    },
  };
}

let shared: LlmClient | null | undefined;

/** The configured client, or null when no API key is set (callers then use their fallback). */
export function getLlmClient(): LlmClient | null {
  if (shared === undefined) {
    const baseUrl = env.LLM_BASE_URL ?? DEFAULT_BASE_URL;
    const apiKey = apiKeyFor(baseUrl);
    shared = apiKey ? createLlmClient({ baseUrl, apiKey, model: env.LLM_MODEL ?? DEFAULT_MODEL }) : null;
  }
  return shared;
}

export const llmModelName = (): string => env.LLM_MODEL ?? DEFAULT_MODEL;
