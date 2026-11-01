import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mapAssemblyWords } from '../src/services/asr/assemblyai.js';
import { validateSegments } from '../src/services/asr/persist.js';
import { groupWordsIntoSegments } from '../src/services/asr/segments.js';
import type { AsrWord } from '../src/services/asr/types.js';

const transcript = JSON.parse(
  readFileSync(new URL('../../evaluation/asr/fixtures/assemblyai-transcript.json', import.meta.url), 'utf8'),
) as { words: Parameters<typeof mapAssemblyWords>[0]; confidence: number };

const word = (text: string, startSec: number, endSec: number, extra: Partial<AsrWord> = {}): AsrWord => ({
  text,
  startSec,
  endSec,
  confidence: 0.9,
  ...extra,
});

describe('word → utterance grouping (CONTRACTS.md §4.3: one segment per utterance)', () => {
  const segments = groupWordsIntoSegments(mapAssemblyWords(transcript.words, transcript.confidence));

  it('turns 27 AssemblyAI words into a few utterances, not one segment per word', () => {
    expect(transcript.words).toHaveLength(27);
    expect(segments.length).toBeGreaterThan(1);
    expect(segments.length).toBeLessThan(6);
  });

  it('starts a new segment when the speaker changes, and keeps speaker labels', () => {
    expect(segments.map((s) => s.speaker)).toEqual(expect.arrayContaining(['A', 'B']));
    const firstB = segments.findIndex((s) => s.speaker === 'B');
    expect(segments[firstB]!.text.startsWith('Is it convex?')).toBe(true);
  });

  it('keeps every word, in order, exactly once', () => {
    const rebuilt = segments.map((s) => s.text).join(' ');
    expect(rebuilt).toBe(transcript.words.map((w) => w.text).join(' '));
  });

  it('produces segments the persistence validator accepts (the provider\'s 2 ms overlap is clamped)', () => {
    expect(() => validateSegments(segments)).not.toThrow();
    for (const s of segments) {
      expect(Number(s.startSec.toFixed(3))).toBe(s.startSec);
      expect(Number(s.endSec.toFixed(3))).toBe(s.endSec);
    }
  });

  it('segment confidence is the mean of its words, so an uncertain stretch is flagged', () => {
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const words = mapAssemblyWords(transcript.words, transcript.confidence);
    const first = segments[0]!;
    const inFirst = words.filter((w) => w.startSec >= first.startSec && w.endSec <= first.endSec);
    expect(first.confidence).toBeCloseTo(mean(inFirst.map((w) => w.confidence)), 3);
  });

  it('breaks on a long pause, at a sentence end once a segment is long enough, and at 30 s at the latest', () => {
    expect(groupWordsIntoSegments([word('a', 0, 1), word('b', 3, 4)])).toHaveLength(2); // 2 s pause
    const longSentence = [word('One', 0, 3), word('two.', 3.1, 6.5), word('Three', 6.6, 7)];
    expect(groupWordsIntoSegments(longSentence).map((s) => s.text)).toEqual(['One two.', 'Three']);
    const hindi = [word('class', 0, 3), word('है।', 3.1, 6.5), word('अब', 6.6, 7)];
    expect(groupWordsIntoSegments(hindi).map((s) => s.text)).toEqual(['class है।', 'अब']); // danda ends a sentence
    const monologue = Array.from({ length: 80 }, (_, i) => word('w', i * 0.5, i * 0.5 + 0.4));
    for (const s of groupWordsIntoSegments(monologue)) expect(s.endSec - s.startSec).toBeLessThanOrEqual(30);
  });
});
