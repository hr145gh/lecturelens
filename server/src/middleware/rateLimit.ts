import type { RequestHandler } from 'express';
import { rateLimited } from '../utils/errors.js';

interface Window {
  count: number;
  resetAt: number;
}

/** Every limiter's store, so tests can reset them. */
const stores = new Set<Map<string, Window>>();

const PRUNE_AT = 10_000;

/**
 * Fixed-window, per-IP, in-memory rate limit: at most `max` requests per `windowMs`;
 * the next one gets 429 RATE_LIMITED with a Retry-After header. Every attempt counts,
 * unless `onlyFailures` is set. Single-process only (no shared store), which fits this deployment.
 * Behind a reverse proxy, set Express `trust proxy` so req.ip is the client's address.
 */
export function rateLimit({
  windowMs,
  max,
  onlyFailures = false,
}: {
  windowMs: number;
  max: number;
  /**
   * Count only requests that end in an error status (≥ 400). For login: it throttles password
   * guessing without locking out someone who signs in and out normally.
   */
  onlyFailures?: boolean;
}): RequestHandler {
  const windows = new Map<string, Window>();
  stores.add(windows);

  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip ?? 'unknown';
    let window = windows.get(key);
    if (!window || window.resetAt <= now) {
      if (windows.size >= PRUNE_AT) {
        for (const [k, w] of windows) if (w.resetAt <= now) windows.delete(k);
      }
      window = { count: 0, resetAt: now + windowMs };
      windows.set(key, window);
    }
    window.count += 1;

    const resetSec = Math.ceil((window.resetAt - now) / 1000);
    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, max - window.count)));
    res.setHeader('RateLimit-Reset', String(resetSec));
    if (window.count > max) {
      res.setHeader('Retry-After', String(resetSec));
      return next(rateLimited(resetSec));
    }
    if (onlyFailures) {
      const counted = window;
      res.on('finish', () => {
        // A success gives its slot back (if the window it counted against is still current).
        if (res.statusCode < 400 && windows.get(key) === counted) counted.count = Math.max(0, counted.count - 1);
      });
    }
    next();
  };
}

/** Test helper: forget every recorded attempt. */
export function resetRateLimits(): void {
  for (const windows of stores) windows.clear();
}
