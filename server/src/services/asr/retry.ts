import { logger } from '../../utils/logger.js';
import type { AsrProviderName } from './types.js';

/** A provider answered with an HTTP error status. */
export class ProviderHttpError extends Error {
  constructor(
    readonly provider: AsrProviderName,
    readonly status: number,
    detail: string,
    /** Seconds from a Retry-After header, when the provider sent one. */
    readonly retryAfterSec: number | null = null,
  ) {
    super(`${provider} answered HTTP ${status}${detail ? `: ${detail}` : ''}`);
    this.name = 'ProviderHttpError';
  }
}

/** Only rate limiting (429) and server errors (5xx) are worth retrying — never other 4xx. */
export function isRetryable(error: unknown): boolean {
  return error instanceof ProviderHttpError && (error.status === 429 || error.status >= 500);
}

/** Mutable so tests can shorten the waits; production: 3 retries after 1 s, 2 s, 4 s. */
export const retryPolicy = {
  retries: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
};

export interface RetryContext {
  provider: AsrProviderName;
  /** What is being called, e.g. "submit transcript". */
  operation: string;
  lectureId?: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `call`, retrying up to retryPolicy.retries times with exponential backoff when it fails
 * with a 429 or 5xx (a 429's Retry-After is honoured if longer). Every attempt is logged with the
 * lecture id; any other error is rethrown at once.
 */
export async function withRetry<T>(call: () => Promise<T>, ctx: RetryContext): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    logger.debug('ASR provider call', { ...ctx, attempt });
    try {
      const result = await call();
      if (attempt > 1) logger.info('ASR provider call succeeded after retrying', { ...ctx, attempt });
      return result;
    } catch (error) {
      const status = error instanceof ProviderHttpError ? error.status : undefined;
      if (!isRetryable(error) || attempt > retryPolicy.retries) {
        logger.warn('ASR provider call failed', { ...ctx, attempt, status, retried: attempt - 1, error });
        throw error;
      }
      const backoffMs = Math.min(retryPolicy.maxDelayMs, retryPolicy.baseDelayMs * 2 ** (attempt - 1));
      const retryAfterMs = error instanceof ProviderHttpError && error.retryAfterSec ? error.retryAfterSec * 1_000 : 0;
      const waitMs = Math.min(retryPolicy.maxDelayMs, Math.max(backoffMs, retryAfterMs));
      logger.warn('ASR provider call failed; retrying', { ...ctx, attempt, status, retryInMs: waitMs });
      await sleep(waitMs);
    }
  }
}

/** Seconds from a Retry-After header (delta-seconds form only), or null. */
export function retryAfterSeconds(headers: Headers): number | null {
  const value = Number(headers.get('retry-after'));
  return Number.isFinite(value) && value > 0 ? value : null;
}
