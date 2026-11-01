import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

/**
 * Validated, typed, frozen environment. Owned by Member D.
 * Secrets come only from the environment — never hardcode a key or URI, and never
 * print a variable's value (only its name) when validation fails.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

// server/.env, resolved from this file so it works from src/ (tsx) and dist/ (node).
dotenv.config({ path: path.resolve(here, '../../.env') });

/** The repository root (same relative path from src/config and dist/config). */
const REPO_ROOT = path.resolve(here, '../../..');

/** Empty strings count as "not set" for optional variables. */
const optional = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), schema.optional());

const required = (explanation: string) =>
  z.string({ required_error: explanation }).trim().min(1, explanation);

const positiveInt = (explanation: string) =>
  z.coerce
    .number({ required_error: explanation, invalid_type_error: explanation })
    .int(explanation)
    .positive(explanation);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production'], {
    errorMap: () => ({ message: 'must be one of development, test, production' }),
  }),
  PORT: positiveInt('must be a positive integer port number, e.g. 5000').refine(
    (n) => n <= 65535,
    'must be a port number between 1 and 65535',
  ),
  CLIENT_ORIGIN: required('must be the client URL allowed by CORS, e.g. http://localhost:5173').url(
    'must be a full URL including the scheme, e.g. http://localhost:5173',
  ),
  MONGODB_URI: required('must be a MongoDB connection string').refine(
    (v) => v.startsWith('mongodb://') || v.startsWith('mongodb+srv://'),
    'must start with mongodb:// or mongodb+srv://',
  ),
  JWT_SECRET: required('must be set to a long random string used to sign JWTs').refine(
    (v) => v.length >= 32,
    'must be at least 32 characters long',
  ),
  JWT_EXPIRES_IN: required('must be a token lifetime such as 7d or 12h').regex(
    /^\d+\s*(ms|s|m|h|d|w|y)?$/,
    'must be a number of seconds or a duration such as 15m, 12h or 7d',
  ),
  STORAGE_DIR: required('must be the directory where uploaded media is stored, e.g. ./storage'),
  MAX_UPLOAD_MB: positiveInt('must be a positive integer number of megabytes, e.g. 512'),

  // Optional until Members A and C need them.
  ASSEMBLYAI_API_KEY: optional(z.string()),
  GROQ_API_KEY: optional(z.string()),
  ASR_PROVIDER: optional(z.enum(['assemblyai', 'groq'])),
  // Member B's tuning knobs (PB.1) — STARTING VALUES to tune, not fixed rules. Unset = the module default.
  CHUNK_SECONDS: optional(z.coerce.number().positive('must be a positive number of seconds')),
  CHUNK_OVERLAP_SECONDS: optional(z.coerce.number().min(0, 'must be 0 or more seconds')),
  TOPIC_SECTION_SECONDS: optional(z.coerce.number().positive('must be a positive number of seconds')),
  TOPIC_SIM_THRESHOLD: optional(z.coerce.number().min(0).max(1, 'must be a cosine similarity between 0 and 1')),
  TOPIC_MIN_SEC: optional(z.coerce.number().positive('must be a positive number of seconds')),
  // Member A's keyterm experiment: pass evaluation/asr/glossary.txt to the ASR provider (PA.2).
  ASR_USE_GLOSSARY: optional(
    z.enum(['true', 'false'], { errorMap: () => ({ message: 'must be true or false' }) }).transform((v) => v === 'true'),
  ),
  OPENROUTER_API_KEY: optional(z.string()),
  LLM_BASE_URL: optional(z.string().url('must be a full URL, e.g. https://api.groq.com/openai/v1')),
  LLM_MODEL: optional(z.string()),
  EMBEDDING_MODEL: optional(z.string()),
});

export type Env = Readonly<z.infer<typeof envSchema>>;

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // Messages are ours (see above) and never include the received value.
  const firstIssuePerVariable = new Map<string, string>();
  for (const issue of parsed.error.issues) {
    const name = issue.path.join('.') || '(environment)';
    if (!firstIssuePerVariable.has(name)) firstIssuePerVariable.set(name, issue.message);
  }
  const lines = [...firstIssuePerVariable].map(([name, message]) => {
    const isMissing = process.env[name] === undefined || process.env[name]?.trim() === '';
    return `  - ${name} ${isMissing ? '(missing)' : '(invalid)'}: ${message}`;
  });
  console.error(
    [
      '',
      'LectureLens server cannot start: invalid environment configuration.',
      ...lines,
      '',
      'Set these in server/.env (see server/.env.example).',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

export const env: Env = Object.freeze(parsed.data);
export const isDev = env.NODE_ENV === 'development';

/** Absolute STORAGE_DIR. A relative value is resolved from the repository root, not the cwd. */
export const storageRoot = path.resolve(REPO_ROOT, env.STORAGE_DIR);
export const isProd = env.NODE_ENV === 'production';
