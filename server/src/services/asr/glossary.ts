import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../../config/env.js';

/**
 * Member A's keyterm experiment (PA.2): the course glossary in evaluation/asr/glossary.txt,
 * passed to the ASR provider as keyterms. This is PROMPTING — biasing a pretrained hosted model
 * toward these spellings — not training or fine-tuning anything.
 */

// evaluation/asr/glossary.txt — the same relative path from src/services/asr and dist/services/asr.
export const GLOSSARY_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../evaluation/asr/glossary.txt',
);

/** Whether the pipeline passes the glossary (ASR_USE_GLOSSARY). Mutable for tests. */
export const glossarySettings = { enabled: env.ASR_USE_GLOSSARY ?? false };

/** Terms from a glossary file: one per line; blank lines and `#` comments skipped; de-duplicated. */
export function parseGlossary(text: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const term = raw.trim();
    if (!term || term.startsWith('#')) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
  }
  return terms;
}

export async function loadGlossary(file = GLOSSARY_PATH): Promise<string[]> {
  return parseGlossary(await readFile(file, 'utf8'));
}

/** The keyterms the pipeline should send: the glossary when enabled, otherwise none. */
export async function pipelineKeyterms(): Promise<string[] | undefined> {
  return glossarySettings.enabled ? loadGlossary() : undefined;
}
