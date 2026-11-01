
export const RAG_PROMPT_VERSION = 'answer-v3';

export interface RagPassage {
  chunkId: string;
  lectureId: string;
  startSec: number;
  endSec: number;
  text: string;
  score: number;
}

export interface NumberedPassage extends RagPassage {
  number: number;
}

export interface AnswerPrompt {
  system: string;
  user: string;
  passages: NumberedPassage[];
}

const DEFAULT_RAG_TOP_K = 8;

export function getRagTopK(): number {
  const configured = Number(process.env.RAG_TOP_K);

  if (
    !Number.isInteger(configured) ||
    configured < 1 ||
    configured > 20
  ) {
    return DEFAULT_RAG_TOP_K;
  }

  return configured;
}

function formatTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = (seconds % 60).toFixed(2);

  return `${minutes}:${remainingSeconds.padStart(5, '0')}`;
}

export function buildAnswerPrompt(
  question: string,
  retrievedPassages: RagPassage[],
): AnswerPrompt {
  const passages: NumberedPassage[] = retrievedPassages.map(
    (passage, index) => ({
      ...passage,
      number: index + 1,
    }),
  );

  const system = `
You are a grounded question-answering system for lecture transcripts.

STRICT RULES:
1. Answer the question using ONLY the numbered passages supplied by the user.
2. Do not use outside knowledge, assumptions, memory, or general knowledge.
3. Never invent facts, explanations, quotations, or citations.
4. If the passages do not contain enough information to answer the question,
   set "answerable" to false.
5. Cite every passage used in the answer using its supplied number.
6. Only cite passage numbers that actually exist in the supplied passages.
7. If you cannot confidently support an answer from the passages,
   abstain rather than guess.
8. Estimate your confidence from how directly and completely the passages
   support your answer. This is a subjective model estimate, not a probability.
9. Confidence must be a number between 0 and 1.
10. For every cited passage, provide an exact, continuous quotation copied
    from that passage's transcript text.
11. Each quotation must be non-empty and no longer than 300 characters.
12. Never paraphrase, correct, or modify a quotation.
13. Return one citedQuotes entry for every passage in citedPassages.

OUTPUT REQUIREMENTS:
Return ONLY valid JSON.
Do not include Markdown fences, explanations, or text outside the JSON.

The JSON must have exactly this structure:
{
  "answer": "Your answer with citation markers such as [1] and [2].",
  "citedPassages": [1, 2],
  "citedQuotes": [
    {
      "passageNumber": 1,
      "quote": "An exact quotation copied from passage 1."
    },
    {
      "passageNumber": 2,
      "quote": "An exact quotation copied from passage 2."
    }
  ],
  "answerable": true,
  "confidence": 0.86
}

For an unanswerable question, return:
{
  "answer": "",
  "citedPassages": [],
  "citedQuotes": [],
  "answerable": false,
  "confidence": 0
}

"citedPassages" must contain integer passage numbers.
"citedQuotes" must contain an exact transcript substring for each cited passage.
When "answerable" is false, "citedPassages" must be empty.
When "answerable" is false, "citedQuotes" must be empty.
When "answerable" is false, confidence must be 0.
`.trim();

  const formattedPassages = passages
    .map(
      (passage) => `
[${passage.number}]
Time range: ${formatTime(passage.startSec)} - ${formatTime(passage.endSec)}
Transcript:
${passage.text}
`.trim(),
    )
    .join('\n\n');

  const user = `
QUESTION:
${question}

NUMBERED LECTURE PASSAGES:
${formattedPassages || '(No relevant passages were retrieved.)'}

Answer the question using only these passages.
Return the required JSON object.
`.trim();

  return {
    system,
    user,
    passages,
  };
}
