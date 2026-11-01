import { normaliseText, wordTokens } from './text.js';

/**
 * Evidence linking: turn the model's quotes into { chunkId, startSec, endSec, quote } items the UI
 * shows as clickable timestamp chips. A quote is located in ONE of the section's segments:
 *  1. exact match on normalised text (lowercase, collapsed whitespace) → stored verbatim from the segment;
 *  2. otherwise the segment sharing the longest run of consecutive words with the quote, and the stored
 *     quote is SHORTENED to exactly that run (still verbatim transcript text) — if the run is long enough.
 * Anything that cannot be located is DISCARDED: we never emit a timestamp we cannot justify.
 * Timing is the containing segment's span; chunkId is a chunk covering that segment whose text holds the quote.
 */

export interface EvidenceSegment {
  id?: unknown;
  index: number;
  startSec: number;
  endSec: number;
  text: string;
}

export interface EvidenceChunk {
  id?: unknown;
  _id?: unknown;
  segmentStart: number;
  segmentEnd: number;
  text: string;
}

export interface LinkedEvidence {
  chunkId: string;
  startSec: number;
  endSec: number;
  quote: string;
}

export { normaliseText };

/** A fuzzy match must keep at least this many consecutive words, and at least this share of the quote. */
export const MIN_MATCH_WORDS = 4;
export const MIN_MATCH_SHARE = 0.5;
const MAX_QUOTE = 300;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Word tokens of `text` with their character spans, so a token run maps back to verbatim text. */
function spannedTokens(text: string): Array<{ token: string; start: number; end: number }> {
  const out: Array<{ token: string; start: number; end: number }> = [];
  const re = /[\p{L}\p{N}][\p{L}\p{M}\p{N}]*(?:['’-][\p{L}\p{M}\p{N}]+)*/gu;
  for (let m = re.exec(text); m; m = re.exec(text)) out.push({ token: m[0].toLowerCase(), start: m.index, end: m.index + m[0].length });
  return out;
}

/** Longest run of consecutive words shared by quote and segment → the verbatim segment substring. */
export function longestSharedRun(quote: string, segmentText: string): { text: string; words: number } {
  const q = wordTokens(quote);
  const s = spannedTokens(segmentText);
  let best = { end: -1, len: 0 };
  let prev = new Array<number>(q.length + 1).fill(0);
  for (let i = 1; i <= s.length; i++) {
    const cur = new Array<number>(q.length + 1).fill(0);
    for (let j = 1; j <= q.length; j++) {
      if (s[i - 1]!.token === q[j - 1]) {
        cur[j] = prev[j - 1]! + 1;
        if (cur[j]! > best.len) best = { end: i - 1, len: cur[j]! };
      }
    }
    prev = cur;
  }
  if (best.len === 0) return { text: '', words: 0 };
  const from = s[best.end - best.len + 1]!.start;
  const to = s[best.end]!.end;
  return { text: segmentText.slice(from, to), words: best.len };
}

/** Exact (normalised) occurrence of `quote` in `segmentText`, returned as the segment's own characters. */
function exactMatch(quote: string, segmentText: string): string | null {
  const wanted = normaliseText(quote);
  if (!wanted || !normaliseText(segmentText).includes(wanted)) return null;
  const pattern = wanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
  return segmentText.match(new RegExp(pattern, 'iu'))?.[0] ?? null;
}

export function linkEvidence(
  quotes: readonly string[],
  segments: readonly EvidenceSegment[],
  chunks: readonly EvidenceChunk[] = [],
  max = 3,
): LinkedEvidence[] {
  const ordered = [...segments].sort((a, b) => a.index - b.index);
  const evidence: LinkedEvidence[] = [];

  for (const raw of quotes) {
    const quote = raw.trim();
    if (!quote) continue;

    let segment: EvidenceSegment | undefined;
    let matched: string | null = null;
    for (const s of ordered) {
      matched = exactMatch(quote, s.text);
      if (matched) {
        segment = s;
        break;
      }
    }
    if (!segment) {
      const quoteWords = wordTokens(quote).length;
      let best = { words: 0, text: '', seg: undefined as EvidenceSegment | undefined };
      for (const s of ordered) {
        const run = longestSharedRun(quote, s.text);
        if (run.words > best.words) best = { ...run, seg: s };
      }
      if (best.seg && best.words >= MIN_MATCH_WORDS && best.words >= quoteWords * MIN_MATCH_SHARE) {
        segment = best.seg;
        matched = best.text;
      }
    }
    if (!segment || !matched) continue; // cannot justify a timestamp: discard

    // Verbatim transcript words; runs of whitespace collapsed (whitespace never decides a match).
    const collapse = (t: string) => t.replace(/\s+/g, ' ').trim();
    const stored = collapse(matched).slice(0, MAX_QUOTE).trim();
    const chunk = chunks.find(
      (c) => segment!.index >= c.segmentStart && segment!.index <= c.segmentEnd && collapse(c.text).includes(stored),
    );
    const chunkId = chunk ? String(chunk.id ?? chunk._id ?? '') : '';
    if (!chunkId) continue; // the contract ties every quote to a chunk that contains it

    const startSec = round3(segment.startSec);
    if (evidence.some((e) => e.startSec === startSec && e.quote === stored)) continue; // same evidence twice
    evidence.push({ chunkId, startSec, endSec: round3(segment.endSec), quote: stored });
    if (evidence.length === max) break;
  }
  return evidence;
}
