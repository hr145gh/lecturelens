import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mergeOverlappingChunks, normalizeGroqWords, type TimedChunk } from '../src/services/asr/groq.js';
import { groupWordsIntoSegments } from '../src/services/asr/segments.js';
import { validateSegments } from '../src/services/asr/persist.js';

/** Two overlapping Groq verbose_json responses: chunk 0 = 0–10 s, chunk 1 = 8–18 s (midpoint 9 s). */
const fixture = JSON.parse(
  readFileSync(new URL('../../evaluation/asr/fixtures/groq-split-chunks.json', import.meta.url), 'utf8'),
) as { chunks: Array<{ offsetSec: number; durationSec: number; response: Parameters<typeof normalizeGroqWords>[0] }> };

const chunks: TimedChunk[] = fixture.chunks.map((c) => ({
  offsetSec: c.offsetSec,
  durationSec: c.durationSec,
  words: normalizeGroqWords(c.response, c.offsetSec),
}));

describe('Groq chunk merge (deliberately split fixture)', () => {
  const merged = mergeOverlappingChunks(chunks);
  const texts = merged.map((w) => w.text);

  it('a word heard by both chunks in the overlap appears exactly once', () => {
    expect(texts.filter((t) => t === 'gradient')).toHaveLength(1);
  });

  it('a word cut off at a chunk edge is taken whole from the next chunk', () => {
    expect(texts).not.toContain('des');
    expect(texts).toContain('descent,');
    expect(texts.join(' ')).toBe('We minimise the loss with gradient descent, step by step.');
  });

  it('adds each chunk\'s start offset to every timestamp', () => {
    const descent = merged.find((w) => w.text === 'descent,');
    expect(descent).toMatchObject({ startSec: 9.25, endSec: 9.9 }); // 8 s + 1.25 s, 8 s + 1.9 s
  });

  it('timestamps are monotonic across the join, and grouped segments pass the persistence validator', () => {
    for (let i = 1; i < merged.length; i++) expect(merged[i]!.startSec).toBeGreaterThan(merged[i - 1]!.startSec);
    const segments = groupWordsIntoSegments(merged);
    expect(() => validateSegments(segments)).not.toThrow();
  });

  it('works regardless of the order chunks are given in', () => {
    expect(mergeOverlappingChunks([...chunks].reverse()).map((w) => w.text)).toEqual(texts);
  });
});

describe('Groq response normalisation', () => {
  it('derives word confidence from the segment avg_logprob (Whisper has no per-word confidence)', () => {
    const [first] = chunks[0]!.words;
    expect(first!.confidence).toBe(Math.round(Math.exp(-0.105) * 1000) / 1000); // 0.9
  });

  it('drops empty or zero-length tokens instead of failing the whole transcript', () => {
    expect(chunks[1]!.words.map((w) => w.text)).not.toContain('');
  });

  it('rounds shifted timestamps to 3 decimals', () => {
    const words = normalizeGroqWords({ words: [{ word: 'hi', start: 0.1234, end: 0.5678 }], segments: [] }, 479.0001);
    expect(words[0]).toMatchObject({ startSec: 479.124, endSec: 479.568 });
  });
});
