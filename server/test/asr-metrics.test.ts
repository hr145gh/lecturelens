import { describe, expect, it } from 'vitest';
import {
  alignWords,
  characterErrorRate,
  editDistance,
  expandNumbers,
  integerToWords,
  normalise,
  termAccuracy,
  tokens,
  wordErrorRate,
} from '../../evaluation/asr/metrics.js';

describe('normalisation (applied identically to reference and hypothesis)', () => {
  it('lowercases, strips punctuation, splits hyphens, drops apostrophes, collapses whitespace', () => {
    expect(normalise("  Okay,   let's use MINI-batch SGD!\n(Really?) ")).toBe('okay lets use mini batch sgd really');
  });

  it('expands digits to words, including separators, decimals and percent', () => {
    expect(integerToWords(0)).toBe('zero');
    expect(integerToWords(105)).toBe('one hundred five');
    expect(integerToWords(50_000)).toBe('fifty thousand');
    expect(integerToWords(2_000_001)).toBe('two million one');
    expect(expandNumbers('50,000 examples / 100')).toBe('fifty thousand examples / one hundred');
    expect(normalise('eta = 0.25, i.e. 25%')).toBe('eta zero point two five i e twenty five percent');
  });

  it('keeps Devanagari words (code-mixed lectures) and drops the danda like other punctuation', () => {
    expect(normalise('Class diagram जो है, वो structure diagram के अंदर आते हैं।')).toBe('class diagram जो है वो structure diagram के अंदर आते हैं');
  });

  it('makes "1.1" and "one point one" score as identical', () => {
    expect(wordErrorRate('a learning rate of one point one', 'A learning rate of 1.1.').wer).toBe(0);
  });
});

describe('WER / CER (Levenshtein)', () => {
  it('counts substitutions, deletions and insertions', () => {
    expect(editDistance(tokens('a b c d'), tokens('a x c'))).toBe(2); // sub b→x, del d
    expect(editDistance([], tokens('a b'))).toBe(2);
    expect(editDistance(tokens('kitten'.split('').join(' ')), tokens('sitting'.split('').join(' ')))).toBe(3);
  });

  it('WER = edits / reference words, and can exceed 1 with insertions', () => {
    expect(wordErrorRate('the chain rule', 'the chain rule')).toEqual({ wer: 0, errors: 0, refWords: 3 });
    expect(wordErrorRate('the chain rule', 'the train rule').wer).toBeCloseTo(1 / 3, 10);
    expect(wordErrorRate('hi', 'oh hi there you').wer).toBe(3);
  });

  it('CER is over normalised characters, spaces included', () => {
    expect(characterErrorRate('Sigmoid', 'sigmoid.')).toBe(0);
    expect(characterErrorRate('relu', 'really')).toBeCloseTo(3 / 4, 10); // relu → really: 1 sub + 2 ins
  });

  it('refuses an empty reference rather than dividing by zero', () => {
    expect(() => wordErrorRate(' !!! ', 'anything')).toThrow(/reference is empty/);
  });
});

describe('technical-term accuracy', () => {
  const glossary = ['gradient descent', 'backpropagation', 'learning rate', 'ReLU', 'sigmoid'];

  it('is the share of glossary-term occurrences in the reference found in the hypothesis', () => {
    const ref = 'Gradient descent uses a learning rate. Backpropagation computes the gradient. The learning rate matters.';
    const hyp = 'gradient descent uses a learning rate. Back propagation computes the gradient. The learning weight matters.';
    const result = termAccuracy(ref, hyp, glossary);
    // occurrences in ref: gradient descent ×1, learning rate ×2, backpropagation ×1 → 4; found: 1 + 1 + 0 = 2
    expect(result).toMatchObject({ found: 2, total: 4, accuracy: 0.5 });
    expect(result.missed.sort()).toEqual(['backpropagation', 'learning rate']);
  });

  it('is null when the reference has no glossary term (not 0, not 1)', () => {
    expect(termAccuracy('good morning everyone', 'good morning', glossary).accuracy).toBeNull();
  });
});

describe('alignment for failure analysis', () => {
  it('reports what was said versus what was heard, with hypothesis positions', () => {
    const ops = alignWords(tokens('the sigmoid function'), tokens('the sick mode function'));
    const errors = ops.filter((o) => o.op !== 'ok');
    // Two minimal scripts tie (sigmoid→sick + "mode", or "sick" + sigmoid→mode); either is correct.
    expect(errors).toHaveLength(2);
    expect(errors.map((o) => o.op).sort()).toEqual(['ins', 'sub']);
    const sub = errors.find((o) => o.op === 'sub');
    expect(sub).toMatchObject({ ref: 'sigmoid' });
    expect(['sick', 'mode']).toContain((sub as { hyp: string }).hyp);
    expect(ops.filter((o) => o.op === 'ok').map((o) => (o as { ref: string }).ref)).toEqual(['the', 'function']);
  });
});

describe('glossary file', () => {
  it('parses one term per line, skipping blanks and # comments, de-duplicating case-insensitively', async () => {
    const { parseGlossary, loadGlossary } = await import('../src/services/asr/glossary.js');
    expect(parseGlossary('# header\n\nSGD\n  learning rate \nsgd\n# note\nReLU\n')).toEqual(['SGD', 'learning rate', 'ReLU']);
    const terms = await loadGlossary();
    expect(terms.length).toBeGreaterThanOrEqual(40);
    for (const t of ['gradient', 'backpropagation', 'learning rate', 'sigmoid', 'chain rule', 'convergence']) expect(terms).toContain(t);
  });
});
