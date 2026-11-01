
import {
  keywordSearch,
} from '../retrieval/keyword.js';
import {
  vectorSearch,
} from '../retrieval/vector.js';
import {
  hybridSearch,
} from '../retrieval/hybrid.js';
import {
  RAG_PROMPT_VERSION,
  buildAnswerPrompt,
  getRagTopK,
  type RagPassage,
} from './prompt.js';
import {
  validateModelAnswer,
  type ValidationResult,
} from './validate.js';
import {
  getCachedAnswer,
  setCachedAnswer,
} from './cache.js';

export interface AnswerGenerator {
  model: string;
  generate(input: {
    system: string;
    user: string;
  }): Promise<{
    content: string;
    model: string;
    tokensIn: number;
    tokensOut: number;
  }>;
}

export interface AnswerQuestionOptions {
  question: string;
  allowedLectureIds: string[];
  retriever: 'keyword' | 'vector' | 'hybrid';
  generator: AnswerGenerator;
}

type AnswerOutcome =
  | ValidationResult
  | {
      answerable: false;
      abstainReason: 'NO_RELEVANT_PASSAGE';
      answer: null;
      citations: [];
      confidence: null;
    };

export type AnswerQuestionResult = AnswerOutcome & {
  abstained: boolean;
  cached: boolean;
  topScore: number | null;
};

function getRelevanceThreshold(): number {
  const configured = Number(process.env.RAG_MIN_SCORE);

  return Number.isFinite(configured) ? configured : 0.35;
}

async function retrievePassages(
  options: AnswerQuestionOptions,
): Promise<RagPassage[]> {
  const input = {
    query: options.question,
    allowedLectureIds: options.allowedLectureIds,
    k: getRagTopK(),
  };

  switch (options.retriever) {
    case 'keyword':
      return keywordSearch(input);
    case 'vector':
      return vectorSearch(input);
    case 'hybrid':
      return hybridSearch(input);
  }
}

function makeResult(
  validation: AnswerOutcome,
  topScore: number | null,
  cached: boolean,
): AnswerQuestionResult {
  return {
    ...validation,
    abstained: !validation.answerable,
    cached,
    topScore,
  };
}

export async function answerQuestion(
  options: AnswerQuestionOptions,
): Promise<AnswerQuestionResult> {
  const retrievedPassages = await retrievePassages(options);

  const topScore =
    retrievedPassages.length > 0
      ? Math.max(...retrievedPassages.map((passage) => passage.score))
      : null;

  const passages = retrievedPassages.filter(
    (passage) => passage.score >= getRelevanceThreshold(),
  );

  if (passages.length === 0) {
    return makeResult(
      {
        answerable: false,
        abstainReason: 'NO_RELEVANT_PASSAGE',
        answer: null,
        citations: [],
        confidence: null,
      },
      topScore,
      false,
    );
  }

  const prompt = buildAnswerPrompt(
    options.question,
    passages,
  );

  const cacheParams = {
    model: options.generator.model,
    promptVersion: RAG_PROMPT_VERSION,
    input: {
      system: prompt.system,
      user: prompt.user,
    },
  };

  const cached = await getCachedAnswer(cacheParams);

  if (cached) {
    const cachedContent =
      typeof cached.response === 'string'
        ? cached.response
        : JSON.stringify(cached.response);

    const validation = validateModelAnswer(
      cachedContent,
      prompt.passages,
    );

    return makeResult(validation, topScore, true);
  }

  let tokensIn = 0;
  let tokensOut = 0;
  let validation: ValidationResult = {
    answerable: false,
    abstainReason: 'PARSE_FAILED',
    answer: null,
    citations: [],
    confidence: null,
  };

  let successfulContent: string | null = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    const generated = await options.generator.generate({
      system: prompt.system,
      user: prompt.user,
    });

    tokensIn += generated.tokensIn;
    tokensOut += generated.tokensOut;

    validation = validateModelAnswer(
      generated.content,
      prompt.passages,
    );

    if (validation.abstainReason !== 'PARSE_FAILED') {
      successfulContent = generated.content;
      break;
    }
  }

  if (validation.abstainReason === 'PARSE_FAILED') {
    return makeResult(validation, topScore, false);
  }

  if (validation.answerable && successfulContent !== null) {
    await setCachedAnswer(
      cacheParams,
      successfulContent,
      tokensIn,
      tokensOut,
    );
  }

  return makeResult(validation, topScore, false);
}
