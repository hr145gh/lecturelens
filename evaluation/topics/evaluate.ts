/**
 * Topic-segmentation evaluation (Member B, PB.2).
 *   npx tsx evaluation/topics/evaluate.ts
 * For every annotation in annotations/*.json: run each segmentation method on that lecture's
 * transcript and score its boundaries against the hand annotation — boundary precision / recall / F1
 * with a ±1-segment tolerance, and WindowDiff. Writes results.csv; prints a table.
 *
 * Boundaries are "after segment i" positions. The proposed method (embedding_similarity) is an
 * UNSUPERVISED HEURISTIC over pretrained embeddings, not a trained model; it runs only when Member
 * C's embedder (server/src/services/embeddings) exists, and is reported as not run otherwise.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Precision / recall / F1 with a tolerance window, matching ONE-TO-ONE: each reference boundary can
 * be claimed by at most one prediction (closest pairs first), so one prediction cannot cover two.
 */
export function boundaryMetrics(
  predicted: readonly number[],
  reference: readonly number[],
  tolerance = 1,
): { precision: number; recall: number; f1: number } {
  const pairs: Array<[number, number, number]> = [];
  predicted.forEach((p, i) => reference.forEach((r, j) => Math.abs(p - r) <= tolerance && pairs.push([Math.abs(p - r), i, j])));
  pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  const usedP = new Set<number>();
  const usedR = new Set<number>();
  for (const [, i, j] of pairs) {
    if (usedP.has(i) || usedR.has(j)) continue;
    usedP.add(i);
    usedR.add(j);
  }
  const precision = predicted.length ? usedP.size / predicted.length : 0;
  const recall = reference.length ? usedR.size / reference.length : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { precision: round3(precision), recall: round3(recall), f1: round3(f1) };
}

/**
 * WindowDiff (Pevzner & Hearst, 2002): slide a window of k units over both boundary sequences and
 * count the windows whose number of boundaries differs; divide by the number of windows (n − k + 1).
 * 0 = identical, higher = worse. `reference` / `hypothesis`: equal-length arrays, 1 = boundary.
 */
export function windowDiff(reference: readonly number[], hypothesis: readonly number[], k: number): number {
  if (reference.length !== hypothesis.length) throw new Error('windowDiff: sequences must have the same length');
  if (!Number.isInteger(k) || k < 1 || k > reference.length) throw new Error(`windowDiff: k must be an integer in 1..${reference.length}`);
  const count = (s: readonly number[], i: number) => s.slice(i, i + k).filter((b) => b !== 0).length;
  let differing = 0;
  const windows = reference.length - k + 1;
  for (let i = 0; i < windows; i++) if (count(reference, i) !== count(hypothesis, i)) differing += 1;
  return round3(differing / windows);
}

/** Boundary flags over the n − 1 gaps between n segments: flag i = boundary after segment i. */
export function boundaryFlags(segmentCount: number, afterSegment: readonly number[]): number[] {
  const flags = new Array<number>(Math.max(0, segmentCount - 1)).fill(0);
  for (const b of afterSegment) if (b >= 0 && b < segmentCount - 1) flags[b] = 1;
  return flags;
}

/** k = half the mean reference section length in segments (Pevzner & Hearst's convention), ≥ 1. */
export function defaultK(segmentCount: number, referenceBoundaries: readonly number[]): number {
  return Math.max(1, Math.round(segmentCount / (referenceBoundaries.length + 1) / 2));
}

export function evaluateBoundarySets(predicted: readonly number[], reference: readonly number[], segmentCount: number, tolerance = 1) {
  const k = defaultK(segmentCount, reference);
  return {
    ...boundaryMetrics(predicted, reference, tolerance),
    windowDiff: windowDiff(boundaryFlags(segmentCount, reference), boundaryFlags(segmentCount, predicted), k),
    k,
  };
}

/* ------------------------------------------------------------------------------ run ---- */

interface Annotation {
  lectureId: string;
  annotator: string;
  /** Path (relative to this folder) of the transcript: { durationSec, segments } or a fixture { items }. */
  transcript: string;
  /** Needed when the transcript file has no durationSec (mocks/transcript.json). */
  durationSec?: number;
  boundaries: Array<{ afterSegmentIndex: number; note?: string }>;
}
interface Transcript {
  durationSec: number;
  segments: Array<{ index: number; startSec: number; endSec: number; text: string }>;
}

function loadTranscript(here: string, a: Annotation): Transcript {
  const raw = JSON.parse(readFileSync(path.resolve(here, a.transcript), 'utf8')) as Partial<Transcript> & { items?: Transcript['segments'] };
  const segments = raw.segments ?? raw.items;
  const durationSec = raw.durationSec ?? a.durationSec;
  if (!segments || durationSec == null) throw new Error(`${a.transcript}: need segments (or items) and a durationSec`);
  return { segments, durationSec };
}

async function main(): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(here, '../..');
  const { fixedWindow, embeddingSimilarity } = await import('../../server/src/services/topics/segmenter.js');

  // Member C's embedder, if it has landed. Never a substitute implementation here.
  const embeddingsModule = path.join(root, 'server/src/services/embeddings/index.ts');
  const embedder = existsSync(embeddingsModule)
    ? ((await import(pathToFileURL(embeddingsModule).href)) as { embedder?: { embed(t: string[]): Promise<number[][]> } }).embedder
    : undefined;

  const annotations = readdirSync(path.join(here, 'annotations'))
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(path.join(here, 'annotations', f), 'utf8')) as Annotation);

  // A transcript may be kept out of the repo (third-party content, see README). Its lecture is then
  // not re-scored: the rows recorded in results.csv by the last run that had it are kept as they are.
  const cols = ['method', 'lecture', 'annotator', 'segments', 'reference', 'predicted', 'tolerance', 'precision', 'recall', 'f1', 'windowDiff', 'k'];
  const csvPath = path.join(here, 'results.csv');
  const recorded = existsSync(csvPath)
    ? readFileSync(csvPath, 'utf8').trim().split('\n').slice(1).map((line) => Object.fromEntries(line.split(',').map((v, i) => [cols[i]!, v])))
    : [];
  const available = (a: Annotation) => existsSync(path.resolve(here, a.transcript));

  const rows: Array<Record<string, string | number>> = [];
  const detail: string[] = [];
  for (const a of annotations) {
    if (!available(a)) {
      const kept = recorded.filter((r) => r.lecture === a.lectureId && r.annotator === a.annotator);
      rows.push(...kept);
      detail.push(`${a.lectureId}: NOT re-scored — ${a.transcript} is not in this checkout; kept ${kept.length} recorded row(s) from results.csv`);
      continue;
    }
    const t = loadTranscript(here, a);
    const n = t.segments.length;
    const reference = a.boundaries.map((b) => b.afterSegmentIndex).sort((x, y) => x - y);
    const methods: Array<[string, number[] | null]> = [
      ['fixed_window', fixedWindow(t.segments, t.durationSec).slice(0, -1).map((s) => s.segmentEnd)],
      ['embedding_similarity', embedder ? (await embeddingSimilarity(t.segments, t.durationSec, embedder)).slice(0, -1).map((s) => s.segmentEnd) : null],
    ];
    for (const [method, predicted] of methods) {
      const base = { method, lecture: a.lectureId, annotator: a.annotator, segments: n, reference: reference.join(' ') };
      if (!predicted) {
        rows.push({ ...base, predicted: 'not run', tolerance: 1, precision: 'n/a', recall: 'n/a', f1: 'n/a', windowDiff: 'n/a', k: 'n/a' });
        continue;
      }
      const m = evaluateBoundarySets(predicted, reference, n, 1);
      rows.push({ ...base, predicted: predicted.join(' '), tolerance: 1, ...m });
      const at = (i: number) => `${i}@${t.segments[i + 1]?.startSec.toFixed(0) ?? '?'}s`;
      detail.push(`${method} · ${a.lectureId}: predicted ${predicted.map(at).join(', ') || '(none)'} · reference ${reference.map(at).join(', ')}`);
    }
  }

  // Inter-annotator agreement: only where one lecture has two or more annotators.
  const byLecture = new Map<string, Annotation[]>();
  for (const a of annotations) byLecture.set(a.lectureId, [...(byLecture.get(a.lectureId) ?? []), a]);
  const agreement: string[] = [];
  for (const [lecture, list] of byLecture) {
    if (!available(list[0]!)) {
      agreement.push(`${lecture}: not computed — transcript not in this checkout`);
      continue;
    }
    if (list.length < 2) {
      agreement.push(`${lecture}: n/a — one annotator (${list[0]!.annotator}); a second, independent annotation is needed`);
      continue;
    }
    const t = loadTranscript(here, list[0]!);
    const [x, y] = list.map((a) => a.boundaries.map((b) => b.afterSegmentIndex));
    const m = evaluateBoundarySets(y!, x!, t.segments.length, 1);
    agreement.push(`${lecture}: ${list[0]!.annotator} vs ${list[1]!.annotator} — F1 ${m.f1}, WindowDiff ${m.windowDiff} (k=${m.k})`);
  }

  writeFileSync(csvPath, `${[cols.join(','), ...rows.map((r) => cols.map((c) => r[c]).join(','))].join('\n')}\n`);
  console.table(rows.map(({ reference: _r, predicted: _p, ...r }) => r));
  console.log(detail.join('\n'));
  console.log(`\nembedder: ${embedder ? 'Member C\'s services/embeddings' : 'none (Member C not merged) — embedding_similarity not run'}`);
  console.log(`inter-annotator agreement:\n  ${agreement.join('\n  ')}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
