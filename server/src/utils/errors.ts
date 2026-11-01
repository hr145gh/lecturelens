/**
 * Application errors. Every non-2xx response is built from an AppError by the error
 * middleware, using the envelope in docs/CONTRACTS.md §3:
 *   { error: { code, message, details, requestId } }
 */

/** Every error code in docs/CONTRACTS.md §3.1 and §3.2. Adding one is a contract change. */
export const ERROR_CODES = [
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'VALIDATION_FAILED',
  'NOT_IMPLEMENTED',
  'PROVIDER_UNAVAILABLE',
  'INTERNAL_ERROR',
  'CONFLICT',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'RATE_LIMITED',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** HTTP status for each code (§3.1, §3.2). There is no 400 in this API. */
export const ERROR_STATUS: Readonly<Record<ErrorCode, number>> = Object.freeze({
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 422,
  NOT_IMPLEMENTED: 501,
  PROVIDER_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  RATE_LIMITED: 429,
});

/** `details` is always an object — `{}` when there is nothing to add, never null. */
export type ErrorDetails = Record<string, unknown>;

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: ErrorDetails;

  constructor(
    code: ErrorCode,
    message: string,
    status: number = ERROR_STATUS[code],
    details: ErrorDetails = {},
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/** `reason: 'expired'` tells the client the token was valid but has run out (§3.1). */
export const unauthenticated = (
  message = 'You need to sign in to do that.',
  details: { reason?: 'expired' } = {},
): AppError => new AppError('UNAUTHENTICATED', message, ERROR_STATUS.UNAUTHENTICATED, details);

export const forbidden = (reason?: string): AppError =>
  new AppError(
    'FORBIDDEN',
    'You do not have permission to do that.',
    ERROR_STATUS.FORBIDDEN,
    reason ? { reason } : {},
  );

/** `resource` is a human noun, e.g. "Lecture" → "Lecture not found." */
export const notFound = (resource = 'Resource'): AppError =>
  new AppError('NOT_FOUND', `${resource} not found.`);

/** `details` is a field → message map with dotted paths, e.g. { "options.2.text": "Required" }. */
export const validationFailed = (
  details: Record<string, string>,
  message = 'Request is invalid.',
): AppError => new AppError('VALIDATION_FAILED', message, ERROR_STATUS.VALIDATION_FAILED, details);

/**
 * For contract routes whose owner has not built them yet (§7). `owner` is the member letter,
 * `prompt` the playbook prompt that implements it (e.g. "PC.2"), `feature` a human name
 * (e.g. "Grounded Q&A") → "Grounded Q&A is not yet implemented (owner: Member C)."
 */
export const notImplemented = (owner: 'A' | 'B' | 'C' | 'D', prompt: string, feature = 'This endpoint'): AppError =>
  new AppError(
    'NOT_IMPLEMENTED',
    `${feature} is not yet implemented (owner: Member ${owner}).`,
    ERROR_STATUS.NOT_IMPLEMENTED,
    { owner, prompt },
  );

/** `provider` e.g. "assemblyai", "groq", "openrouter". */
export const providerUnavailable = (provider: string): AppError =>
  new AppError(
    'PROVIDER_UNAVAILABLE',
    'An external service is unavailable right now. Please try again shortly.',
    ERROR_STATUS.PROVIDER_UNAVAILABLE,
    { provider },
  );

export const conflict = (message: string, details: ErrorDetails = {}): AppError =>
  new AppError('CONFLICT', message, ERROR_STATUS.CONFLICT, details);

export const rateLimited = (retryAfterSec: number): AppError => {
  const minutes = Math.max(1, Math.ceil(retryAfterSec / 60));
  return new AppError(
    'RATE_LIMITED',
    `Too many attempts. Please try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
    ERROR_STATUS.RATE_LIMITED,
    { retryAfterSec },
  );
};

export const internal = (): AppError =>
  new AppError('INTERNAL_ERROR', 'Something went wrong on our side. Please try again.');
