
import { createHash } from 'node:crypto';
import { LlmCache } from '../../models/LlmCache.js';

export interface AnswerCacheParams {
  model: string;
  promptVersion: string;
  input: {
    system: string;
    user: string;
  };
}

function getCacheKeyInput(params: AnswerCacheParams) {
  return {
    purpose: 'answer',
    model: params.model,
    promptVersion: params.promptVersion,
    input: params.input,
  };
}

export function createAnswerCacheKey(
  params: AnswerCacheParams,
): string {
  return createHash('sha256')
    .update(JSON.stringify(getCacheKeyInput(params)))
    .digest('hex');
}

export async function getCachedAnswer(
  params: AnswerCacheParams,
): Promise<{
  response: unknown;
  tokensIn: number;
  tokensOut: number;
} | null> {
    const cached = await LlmCache.findOneAndUpdate(
        {
        key: createAnswerCacheKey(params),
        purpose: 'answer',
        },
        { $inc: { hits: 1 } },
        { new: true },
    ).lean();

  if (!cached) {
    return null;
  }

  return {
    response: cached.response,
    tokensIn: cached.tokensIn,
    tokensOut: cached.tokensOut,
  };
}

export async function setCachedAnswer(
  params: AnswerCacheParams,
  response: unknown,
  tokensIn: number,
  tokensOut: number,
): Promise<void> {
  if (
    !Number.isFinite(tokensIn) ||
    !Number.isFinite(tokensOut) ||
    tokensIn < 0 ||
    tokensOut < 0
  ) {
    throw new Error(
      'Cache token counts must be non-negative numbers',
    );
  }

  const key = createAnswerCacheKey(params);

  await LlmCache.updateOne(
    { key },
    {
      $setOnInsert: {
        key,
        purpose: 'answer',
        model: params.model,
        promptVersion: params.promptVersion,
        response,
        tokensIn,
        tokensOut,
      },
    },
    { upsert: true },
  );
}