
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { mapAssemblyWords } from '../src/services/asr/assemblyai.js';

interface AssemblyFixture {
  words: Array<{
    text: string;
    start: number;
    end: number;
    confidence?: number;
    speaker?: string;
  }>;
  confidence: number;
}

const fixturePath = path.resolve(
  process.cwd(),
  '../evaluation/asr/fixtures/assemblyai-words.json',
);

const fixture = JSON.parse(
  readFileSync(fixturePath, 'utf8'),
) as AssemblyFixture;

describe('AssemblyAI response mapping', () => {
  it('converts millisecond timestamps to seconds rounded to 3 decimals', () => {
    const segments = mapAssemblyWords(fixture.words, fixture.confidence);

    expect(segments[0].startSec).toBe(1.234);
    expect(segments[0].endSec).toBe(1.678);
    expect(segments[1].startSec).toBe(1.7);
  });

  it('maps text, confidence, and speaker labels', () => {
    const segments = mapAssemblyWords(fixture.words, fixture.confidence);

    expect(segments.map((segment) => segment.text)).toEqual([
      'Binary',
      'search',
      'tree',
    ]);
    expect(segments[0].confidence).toBe(0.96);
    expect(segments[0].speaker).toBe('A');
    expect(segments[2].speaker).toBe('B');
  });

  it('uses transcript confidence when a word confidence is missing', () => {
    const segments = mapAssemblyWords(
      [{ text: 'example', start: 100, end: 500 }],
      0.82,
    );

    expect(segments[0].confidence).toBe(0.82);
  });

  it('rejects a word with a zero-length interval', () => {
    expect(() =>
      mapAssemblyWords([{ text: 'invalid', start: 500, end: 500 }]),
    ).toThrow(/invalid word interval/i);
  });
});
