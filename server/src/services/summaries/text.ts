/**
 * Text helpers shared by the summariser, evidence linking and the faithfulness check, so all three
 * read text the same way. Unicode-aware: Devanagari words (with their vowel-sign marks) count as
 * words, for code-mixed Hindi–English lectures.
 */

/** Lowercase, collapse whitespace (the matching normalisation evidence linking uses). */
export function normaliseText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Word tokens: letters, combining marks and digits (apostrophes and inner hyphens kept). */
export function wordTokens(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}]*(?:['’-][\p{L}\p{M}\p{N}]+)*/gu) ?? [];
}

const STOP = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'to', 'of', 'in', 'on', 'for', 'is', 'are', 'was', 'were', 'be',
  'been', 'that', 'this', 'these', 'those', 'with', 'from', 'by', 'as', 'at', 'it', 'its', 'we', 'you',
  'they', 'he', 'she', 'our', 'their', 'not', 'so', 'if', 'then', 'than', 'which', 'what', 'how', 'can',
  'will', 'into', 'about', 'also', 'such', 'has', 'have', 'had', 'do', 'does', 'one', 'there', 'here',
]);

/** Content tokens: word tokens without common function words. */
export const contentTokens = (text: string): string[] => wordTokens(text).filter((t) => !STOP.has(t));

/**
 * Sentences: split after . ! ? or the Devanagari danda (। ॥) followed by whitespace/end — not inside
 * numbers ("0.5"), not after a lone initial or common abbreviation ("e.g.", "i.e.", "Dr.").
 */
export function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  let start = 0;
  const re = /[.!?।॥]+(?=\s|$)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const before = text.slice(start, m.index);
    if (/(?:\b(?:e\.g|i\.e|etc|vs|dr|mr|mrs|ms|prof|fig)|\b\p{L})$/iu.test(before) && m[0] === '.') continue;
    const sentence = text.slice(start, m.index + m[0].length).trim();
    if (sentence) sentences.push(sentence);
    start = m.index + m[0].length;
  }
  const rest = text.slice(start).trim();
  if (rest) sentences.push(rest);
  return sentences;
}
