import type { AsrSegment, AsrWord } from './types.js';

/**
 * Groups word timings into utterance segments (CONTRACTS.md §4.3: one segment = one ASR
 * utterance, not one word). Both providers return words; this keeps their output identical
 * in shape and gives the review UI, chunking (Member B) and search sentence-sized units.
 *
 * A new segment starts when the speaker changes, after a pause, at a sentence end once the
 * segment is long enough, or when it reaches the hard maximum length.
 */

export const SEGMENT_RULES = Object.freeze({
  /** A silence longer than this always starts a new segment. */
  pauseSec: 1.2,
  /** End at the first sentence end after this many seconds. */
  minSentenceSec: 6,
  /** Never let a segment grow past this. */
  maxSec: 30,
});

// Latin sentence ends, plus the Devanagari danda (।, ॥) for Hindi–English lectures.
const SENTENCE_END = /[.?!।॥]["')\]]?$/;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

export function groupWordsIntoSegments(words: readonly AsrWord[], rules = SEGMENT_RULES): AsrSegment[] {
  const ordered = words
    .filter((w) => w.text.trim() && w.endSec > w.startSec)
    .slice()
    .sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec);

  const segments: AsrSegment[] = [];
  let current: AsrWord[] = [];

  const flush = () => {
    if (current.length === 0) return;
    const first = current[0]!;
    const last = current[current.length - 1]!;
    const previous = segments[segments.length - 1];
    // Providers occasionally report a word starting a few ms before the previous one ends;
    // segments must never overlap (§4.3), so start no earlier than the previous segment ends.
    const startSec = round3(Math.max(first.startSec, previous?.endSec ?? 0));
    const endSec = round3(Math.max(last.endSec, startSec + 0.001));
    const confidence = current.reduce((sum, w) => sum + w.confidence, 0) / current.length;
    segments.push({
      startSec,
      endSec,
      text: current.map((w) => w.text.trim()).join(' '),
      confidence: round3(Math.min(1, Math.max(0, confidence))),
      ...(first.speaker ? { speaker: first.speaker } : {}),
    });
    current = [];
  };

  for (const word of ordered) {
    const first = current[0];
    const last = current[current.length - 1];
    if (first && last) {
      const length = word.endSec - first.startSec;
      const breakHere =
        (word.speaker ?? null) !== (first.speaker ?? null) ||
        word.startSec - last.endSec > rules.pauseSec ||
        (SENTENCE_END.test(last.text.trim()) && last.endSec - first.startSec >= rules.minSentenceSec) ||
        length > rules.maxSec;
      if (breakHere) flush();
    }
    current.push(word);
  }
  flush();
  return segments;
}
