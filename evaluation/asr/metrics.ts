/**
 * ASR evaluation metrics — Member A (PA.2). No dependencies.
 *
 * normalise() is applied IDENTICALLY to reference and hypothesis before any metric:
 *   1. Unicode NFKC, lowercase.
 *   2. Numbers to words: thousands separators dropped ("50,000" → "fifty thousand"), decimals read
 *      digit by digit after "point" ("0.25" → "zero point two five"), "%" → "percent".
 *   3. Hyphens, dashes and slashes → space ("mini-batch" → "mini batch").
 *   4. Apostrophes removed ("let's" → "lets").
 *   5. Every other character that is not a letter, combining mark or digit → space (marks are kept:
 *      Devanagari vowel signs such as the ैं in "हैं" are marks, and code-mixed lectures need them).
 *   6. Whitespace collapsed to single spaces, trimmed.
 */

const ONES = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen',
];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const SCALES: Array<[number, string]> = [[1e9, 'billion'], [1e6, 'million'], [1e3, 'thousand']];

/** 0 ≤ n < 10^12, American style without "and": 105 → "one hundred five". */
export function integerToWords(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n >= 1e12) throw new RangeError(`unsupported number ${n}`);
  if (n < 20) return ONES[n]!;
  if (n < 100) return TENS[Math.floor(n / 10)]! + (n % 10 ? ` ${ONES[n % 10]}` : '');
  if (n < 1000) return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${integerToWords(n % 100)}` : ''}`;
  for (const [size, name] of SCALES) {
    if (n >= size) {
      const rest = n % size;
      return `${integerToWords(Math.floor(n / size))} ${name}${rest ? ` ${integerToWords(rest)}` : ''}`;
    }
  }
  return ''; // unreachable
}

export function expandNumbers(text: string): string {
  return text
    .replace(/(\d)%/g, '$1 percent')
    .replace(/\d{1,3}(?:,\d{3})+(?![\d,])|\d+(?:\.\d+)?/g, (match) => {
      const [whole, fraction] = match.replace(/,/g, '').split('.');
      const words = integerToWords(Number(whole));
      return fraction ? `${words} point ${[...fraction].map((d) => ONES[Number(d)]).join(' ')}` : words;
    });
}

export function normalise(text: string): string {
  return expandNumbers(text.normalize('NFKC').toLowerCase())
    .replace(/[-‐-―/\\]/g, ' ')
    .replace(/['’‘`]/g, '')
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export const tokens = (normalised: string): string[] => (normalised ? normalised.split(' ') : []);

/** Levenshtein distance (substitutions + deletions + insertions), two-row DP. */
export function editDistance<T>(ref: readonly T[], hyp: readonly T[]): number {
  let prev = Array.from({ length: hyp.length + 1 }, (_, j) => j);
  for (let i = 1; i <= ref.length; i++) {
    const cur = [i];
    for (let j = 1; j <= hyp.length; j++) {
      const substitution = prev[j - 1]! + (ref[i - 1] === hyp[j - 1] ? 0 : 1);
      cur[j] = Math.min(substitution, prev[j]! + 1, cur[j - 1]! + 1);
    }
    prev = cur;
  }
  return prev[hyp.length]!;
}

/** Word error rate = word edits / reference words. Inputs are raw text; both are normalised. */
export function wordErrorRate(reference: string, hypothesis: string): { wer: number; errors: number; refWords: number } {
  const ref = tokens(normalise(reference));
  if (ref.length === 0) throw new Error('reference is empty after normalisation');
  const errors = editDistance(ref, tokens(normalise(hypothesis)));
  return { wer: errors / ref.length, errors, refWords: ref.length };
}

/** Character error rate over the normalised text (single spaces between words are counted). */
export function characterErrorRate(reference: string, hypothesis: string): number {
  const ref = [...normalise(reference)];
  if (ref.length === 0) throw new Error('reference is empty after normalisation');
  return editDistance(ref, [...normalise(hypothesis)]) / ref.length;
}

function countPhrase(haystack: string[], phrase: string[]): number {
  let count = 0;
  for (let i = 0; i + phrase.length <= haystack.length; i++) {
    if (phrase.every((t, k) => haystack[i + k] === t)) {
      count++;
      i += phrase.length - 1; // non-overlapping
    }
  }
  return count;
}

/**
 * Technical-term accuracy: of the glossary-term occurrences in the reference, the share also
 * present in the hypothesis — Σ_t min(refCount_t, hypCount_t) / Σ_t refCount_t, matching whole
 * normalised word sequences. null when the reference contains no glossary term.
 */
export function termAccuracy(
  reference: string,
  hypothesis: string,
  glossary: readonly string[],
): { accuracy: number | null; found: number; total: number; missed: string[] } {
  const ref = tokens(normalise(reference));
  const hyp = tokens(normalise(hypothesis));
  const terms = [...new Set(glossary.map((t) => normalise(t)).filter(Boolean))].map(tokens);
  let total = 0;
  let found = 0;
  const missed: string[] = [];
  for (const term of terms) {
    const inRef = countPhrase(ref, term);
    if (!inRef) continue;
    const hit = Math.min(inRef, countPhrase(hyp, term));
    total += inRef;
    found += hit;
    if (hit < inRef) missed.push(term.join(' '));
  }
  return { accuracy: total ? found / total : null, found, total, missed };
}

export type AlignmentOp =
  | { op: 'ok' | 'sub'; ref: string; hyp: string; hypIndex: number }
  | { op: 'del'; ref: string; hypIndex: number }
  | { op: 'ins'; hyp: string; hypIndex: number };

/** One minimal edit script turning ref into hyp (for finding failure cases). */
export function alignWords(ref: readonly string[], hyp: readonly string[]): AlignmentOp[] {
  const d: number[][] = Array.from({ length: ref.length + 1 }, (_, i) =>
    Array.from({ length: hyp.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= ref.length; i++) {
    for (let j = 1; j <= hyp.length; j++) {
      d[i]![j] = Math.min(d[i - 1]![j - 1]! + (ref[i - 1] === hyp[j - 1] ? 0 : 1), d[i - 1]![j]! + 1, d[i]![j - 1]! + 1);
    }
  }
  const ops: AlignmentOp[] = [];
  let i = ref.length;
  let j = hyp.length;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && d[i]![j] === d[i - 1]![j - 1]! + (ref[i - 1] === hyp[j - 1] ? 0 : 1)) {
      ops.push({ op: ref[i - 1] === hyp[j - 1] ? 'ok' : 'sub', ref: ref[i - 1]!, hyp: hyp[j - 1]!, hypIndex: j - 1 });
      i--;
      j--;
    } else if (i > 0 && d[i]![j] === d[i - 1]![j]! + 1) {
      ops.push({ op: 'del', ref: ref[i - 1]!, hypIndex: j });
      i--;
    } else {
      ops.push({ op: 'ins', hyp: hyp[j - 1]!, hypIndex: j - 1 });
      j--;
    }
  }
  return ops.reverse();
}
