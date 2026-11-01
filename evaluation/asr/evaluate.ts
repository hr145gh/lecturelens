/**
 * ASR evaluation: WER, CER and technical-term accuracy, glossary off vs on.
 *   npx tsx evaluation/asr/evaluate.ts [--provider=assemblyai|groq] [--fresh] [--only=c1,c2]
 *
 * For each clip in manifest.json with a typed reference: transcribe it twice with ONE provider
 * (no fallback, so "off" and "on" are comparable) — once without keyterms, once with
 * glossary.txt — normalise hypothesis and reference identically (metrics.ts) and score.
 * Transcripts are cached in hypotheses/ (re-running does not re-bill; --fresh forces new calls).
 * Writes results.csv and failure-candidates.md; prints a table.
 */
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  alignWords,
  characterErrorRate,
  normalise,
  termAccuracy,
  tokens,
  wordErrorRate,
} from './metrics.js';

process.env.LOG_LEVEL ??= 'warn'; // before the server modules load their logger

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k!, v ?? 'true'];
  }),
);

interface ClipEntry {
  id: string;
  clip: string;
  reference: string;
  condition: 'clean' | 'noisy' | 'accented';
}
interface Hypothesis {
  provider: string;
  model: string;
  modelVersion: string;
  externalId: string | null;
  glossary: 'on' | 'off';
  keyterms: number;
  createdAt: string;
  segments: Array<{ startSec: number; endSec: number; text: string; confidence: number }>;
}
interface Row {
  clip: string;
  condition: string;
  glossary: 'on' | 'off';
  wer: number;
  cer: number;
  termAccuracy: number | null;
  wordCount: number;
}

/** Reference text without the instruction comments; '' if nobody has typed it yet. */
async function readReference(file: string): Promise<string> {
  if (!existsSync(file)) return '';
  return (await readFile(file, 'utf8'))
    .split(/\r?\n/)
    .filter((l) => !l.trimStart().startsWith('#'))
    .join('\n')
    .trim();
}

const fmt = (n: number | null, digits = 3) => (n === null ? 'n/a' : n.toFixed(digits));

async function main(): Promise<number> {
  const { asrProviders } = await import('../../server/src/services/asr/index.js');
  const { loadGlossary } = await import('../../server/src/services/asr/glossary.js');
  const { env } = await import('../../server/src/config/env.js');

  const manifest = JSON.parse(await readFile(path.join(HERE, 'manifest.json'), 'utf8')) as { clips: ClipEntry[] };
  const only = args.only ? new Set(args.only.split(',')) : null;
  const clips = manifest.clips.filter((c) => !only || only.has(c.id));
  const glossary = await loadGlossary(path.join(HERE, 'glossary.txt'));
  const providerName = (args.provider ?? env.ASR_PROVIDER ?? 'assemblyai') as keyof typeof asrProviders;
  const provider = asrProviders[providerName];
  if (!provider) throw new Error(`unknown provider "${providerName}"`);

  const rows: Row[] = [];
  const skipped: string[] = [];
  const candidates: string[] = [];

  for (const clip of clips) {
    const reference = await readReference(path.join(HERE, clip.reference));
    if (!reference) {
      skipped.push(`${clip.id}: reference ${clip.reference} not typed yet`);
      continue;
    }
    const audio = path.join(HERE, clip.clip);
    if (!existsSync(audio)) {
      skipped.push(`${clip.id}: ${clip.clip} missing — run: npx tsx evaluation/asr/make-clips.ts`);
      continue;
    }

    for (const mode of ['off', 'on'] as const) {
      const cacheFile = path.join(HERE, 'hypotheses', `${clip.id}.${providerName}.glossary-${mode}.json`);
      let hyp: Hypothesis | null = null;
      if (!args.fresh && existsSync(cacheFile)) hyp = JSON.parse(await readFile(cacheFile, 'utf8')) as Hypothesis;
      if (!hyp) {
        const keyterms = mode === 'on' ? glossary : undefined;
        const result = await provider.transcribe(audio, { keyterms, lectureId: `eval:${clip.id}` });
        hyp = {
          provider: result.provider,
          model: result.model,
          modelVersion: result.modelVersion,
          externalId: result.externalId,
          glossary: mode,
          keyterms: keyterms?.length ?? 0,
          createdAt: new Date().toISOString(),
          segments: result.segments.map(({ startSec, endSec, text, confidence }) => ({ startSec, endSec, text, confidence })),
        };
        await writeFile(cacheFile, JSON.stringify(hyp, null, 2));
      }

      const hypothesis = hyp.segments.map((s) => s.text).join(' ');
      const { wer, refWords } = wordErrorRate(reference, hypothesis);
      rows.push({
        clip: clip.id,
        condition: clip.condition,
        glossary: mode,
        wer,
        cer: characterErrorRate(reference, hypothesis),
        termAccuracy: termAccuracy(reference, hypothesis, glossary).accuracy,
        wordCount: refWords,
      });

      // Raw material for FAILURES.md: every error, with the time of the hypothesis segment it is in.
      if (mode === 'off') {
        const hypWordTime: number[] = [];
        for (const s of hyp.segments) for (const _ of tokens(normalise(s.text))) hypWordTime.push(s.startSec);
        const ops = alignWords(tokens(normalise(reference)), tokens(normalise(hypothesis)));
        const errors = ops.filter((o) => o.op !== 'ok');
        candidates.push(`## ${clip.id} (${clip.condition}) — ${errors.length} word errors\n`);
        for (const o of errors.slice(0, 40)) {
          const at = hypWordTime[Math.min(o.hypIndex, hypWordTime.length - 1)] ?? 0;
          const said = o.op === 'ins' ? '—' : o.ref;
          const heard = o.op === 'del' ? '—' : o.hyp;
          candidates.push(`- ≈${at.toFixed(1)} s in clip · ${o.op} · said "${said}" · ASR "${heard}"`);
        }
        candidates.push('');
      }
    }
  }

  const header = 'clip,condition,glossary,wer,cer,termAccuracy,wordCount';
  const csv = [header, ...rows.map((r) => [r.clip, r.condition, r.glossary, fmt(r.wer, 4), fmt(r.cer, 4), fmt(r.termAccuracy, 4), r.wordCount].join(','))];
  await writeFile(path.join(HERE, 'results.csv'), `${csv.join('\n')}\n`);
  await writeFile(
    path.join(HERE, 'failure-candidates.md'),
    `# Failure candidates (generated by evaluate.ts — not a write-up)\n\nProvider: ${providerName}, glossary off. Listen at each time before documenting a case in FAILURES.md.\n\n${candidates.join('\n')}`,
  );

  console.log(`provider: ${providerName} · glossary: ${glossary.length} terms · clips scored: ${new Set(rows.map((r) => r.clip)).size}/${clips.length}\n`);
  if (rows.length) {
    console.table(rows.map((r) => ({ ...r, wer: fmt(r.wer), cer: fmt(r.cer), termAccuracy: fmt(r.termAccuracy) })));
  }
  for (const s of skipped) console.log(`not scored — ${s}`);
  if (!rows.length) {
    console.log('\nNothing was scored, so results.csv has a header only.');
    return 2;
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(`evaluation failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
