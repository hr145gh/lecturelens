import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';
import { defineConfig } from 'vitest/config';

const here = path.dirname(fileURLToPath(import.meta.url));

/** server/.env's MONGODB_URI, used only if mongodb-memory-server cannot start (→ "<db>_test"). */
function fallbackMongoUri(): string {
  try {
    return parse(readFileSync(path.join(here, '.env'))).MONGODB_URI ?? '';
  } catch {
    return '';
  }
}

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/resetModels.ts', 'test/setup.ts'],
    // One file at a time in one process: suites never race on the database.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    // Tests never read server/.env directly or touch Atlas: these win over .env (dotenv does
    // not override variables that are already set).
    env: {
      NODE_ENV: 'test',
      PORT: '5000',
      CLIENT_ORIGIN: 'http://localhost:5173',
      MONGODB_URI: 'mongodb://127.0.0.1:1/unused-tests-use-test-setup',
      FALLBACK_MONGODB_URI: fallbackMongoUri(),
      JWT_SECRET: 'test-only-secret-that-is-at-least-32-characters',
      JWT_EXPIRES_IN: '1h',
      STORAGE_DIR: path.join(os.tmpdir(), 'lecturelens-test-storage'),
      MAX_UPLOAD_MB: '512',
      // Optional variables are blanked too: otherwise dotenv fills them from server/.env and tests
      // would call real providers with real keys (empty = unset for these; see config/env.ts).
      ASSEMBLYAI_API_KEY: '',
      GROQ_API_KEY: '',
      OPENROUTER_API_KEY: '',
      ASR_PROVIDER: '',
      ASR_USE_GLOSSARY: '',
      LLM_BASE_URL: '',
      LLM_MODEL: '',
      EMBEDDING_MODEL: '',
      LOG_LEVEL: '',
    },
    hookTimeout: 120_000, // the first run downloads the mongod binary
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/index.ts', 'src/db/seed.ts'],
      reporter: ['text-summary', 'text'],
    },
  },
});
