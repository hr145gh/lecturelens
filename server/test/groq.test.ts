import { describe, expect, it } from 'vitest';
import { mergeOverlappingSegments } from '../src/services/asr/groq.js';

describe('Groq ASR overlap merging', () => {
  it('removes duplicate words from overlapping chunks', () => {
    const merged = mergeOverlappingSegments([
      {
        offsetSec: 0,
        segments: [
          { startSec: 478.5, endSec: 478.9, text: 'binary', confidence: 0.8 },
          { startSec: 479.2, endSec: 479.6, text: 'search', confidence: 0.7 },
        ],
      },
      {
        offsetSec: 479,
        segments: [
          { startSec: 479.2, endSec: 479.6, text: 'search', confidence: 0.9 },
          { startSec: 480.0, endSec: 480.4, text: 'tree', confidence: 0.85 },
        ],
      },
    ]);

    expect(merged.map((segment) => segment.text)).toEqual([
      'binary',
      'search',
      'tree',
    ]);
    expect(merged.find((segment) => segment.text === 'search')?.confidence).toBe(0.9);
  });

  it('returns segments in chronological order', () => {
    const merged = mergeOverlappingSegments([
      {
        offsetSec: 0,
        segments: [
          { startSec: 2, endSec: 2.4, text: 'second', confidence: 0.8 },
          { startSec: 1, endSec: 1.4, text: 'first', confidence: 0.9 },
        ],
      },
    ]);

    expect(merged.map((segment) => segment.startSec)).toEqual([1, 2]);
  });

  it('does not merge different words with similar timestamps', () => {
    const merged = mergeOverlappingSegments([
      {
        offsetSec: 0,
        segments: [
          { startSec: 1, endSec: 1.3, text: 'binary', confidence: 0.8 },
          { startSec: 1, endSec: 1.3, text: 'tree', confidence: 0.9 },
        ],
      },
    ]);

    expect(merged).toHaveLength(2);
  });
});