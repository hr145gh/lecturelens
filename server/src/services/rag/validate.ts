
import type { NumberedPassage } from './prompt.js';

export interface ModelCitationQuote {
  passageNumber: number;
  quote: string;
}

export interface ModelAnswer {
  answer: string;
  citedPassages: number[];
  citedQuotes: ModelCitationQuote[];
  answerable: boolean;
  confidence: number;
}

export interface ValidatedCitation {
  marker: number;
  chunkId: string;
  lectureId: string;
  startSec: number;
  endSec: number;
  quote: string;
  deepLink: string;
}

export type ValidationResult =
  | {
      answerable: false;
      abstainReason: 'PARSE_FAILED' | 'LOW_CONFIDENCE';
      answer: null;
      citations: [];
      confidence: null;
    }
  | {
      answerable: true;
      abstainReason: null;
      answer: string;
      citations: ValidatedCitation[];
      confidence: number;
    };

function abstain(
  reason: 'PARSE_FAILED' | 'LOW_CONFIDENCE',
): ValidationResult {
  return {
    answerable: false,
    abstainReason: reason,
    answer: null,
    citations: [],
    confidence: null,
  };
}

function parseModelAnswer(raw: string): ModelAnswer | null {
  try {
    const parsed: unknown = JSON.parse(raw);

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return null;
    }

    const candidate = parsed as Record<string, unknown>;

    if (
      typeof candidate.answer !== 'string' ||
      typeof candidate.answerable !== 'boolean' ||
      !Array.isArray(candidate.citedPassages) ||
      !candidate.citedPassages.every(
        (value) =>
          typeof value === 'number' && Number.isInteger(value),
      ) ||
      !Array.isArray(candidate.citedQuotes) ||
      !candidate.citedQuotes.every((value) => {
        if (
          typeof value !== 'object' ||
          value === null ||
          Array.isArray(value)
        ) {
          return false;
        }

        const quote = value as Record<string, unknown>;

        return (
          typeof quote.passageNumber === 'number' &&
          Number.isInteger(quote.passageNumber) &&
          typeof quote.quote === 'string'
        );
      }) ||
      typeof candidate.confidence !== 'number' ||
      !Number.isFinite(candidate.confidence) ||
      candidate.confidence < 0 ||
      candidate.confidence > 1
    ) {
      return null;
    }

    return {
      answer: candidate.answer,
      answerable: candidate.answerable,
      citedPassages: candidate.citedPassages as number[],
      citedQuotes: candidate.citedQuotes as ModelCitationQuote[],
      confidence: candidate.confidence,
    };
  } catch {
    return null;
  }
}

function buildCitation(
  passage: NumberedPassage,
  quote: string,
): ValidatedCitation {
  return {
    marker: passage.number,
    chunkId: passage.chunkId,
    lectureId: passage.lectureId,
    startSec: passage.startSec,
    endSec: passage.endSec,
    quote,
    deepLink: `/lectures/${passage.lectureId}/play?t=${passage.startSec}`,
  };
}

export function validateModelAnswer(
  raw: string,
  passages: NumberedPassage[],
): ValidationResult {
  const parsed = parseModelAnswer(raw);

  if (!parsed) {
    return abstain('PARSE_FAILED');
  }

  if (!parsed.answerable) {
    return abstain('LOW_CONFIDENCE');
  }

  if (!parsed.answer.trim() || parsed.confidence <= 0) {
    return abstain('LOW_CONFIDENCE');
  }

  const passageMap = new Map(
    passages.map((passage) => [passage.number, passage]),
  );

  const validCitations: ValidatedCitation[] = [];

  for (const number of new Set(parsed.citedPassages)) {
    const passage = passageMap.get(number);

    if (!passage) {
      continue;
    }

    const matchingQuote = parsed.citedQuotes.find(
      (item) => item.passageNumber === number,
    )?.quote;

    if (
      !matchingQuote ||
      matchingQuote.length > 300 ||
      !passage.text.includes(matchingQuote)
    ) {
      continue;
    }

    validCitations.push(buildCitation(passage, matchingQuote));
  }

  if (validCitations.length === 0) {
    return abstain('LOW_CONFIDENCE');
  }

  const validNumbers = new Set(
    validCitations.map((citation) => citation.marker),
  );

  let answer = parsed.answer.replace(
    /\[(\d+)\]/g,
    (marker, number: string) =>
      validNumbers.has(Number(number)) ? marker : '',
  );

  for (const citation of validCitations) {
    const marker = `[${citation.marker}]`;

    if (!answer.includes(marker)) {
      answer = `${answer.trim()} ${marker}`;
    }
  }

  return {
    answerable: true,
    abstainReason: null,
    answer: answer.trim(),
    citations: validCitations,
    confidence: parsed.confidence,
  };
}
