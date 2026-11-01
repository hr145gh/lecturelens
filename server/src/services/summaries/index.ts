import { Chunk, Summary, TopicSection, TranscriptSegment } from '../../models/index.js';
import { logger } from '../../utils/logger.js';
import { linkEvidence, type EvidenceSegment } from './evidence.js';
import { checkFaithfulness } from './faithfulness.js';
import { extractiveResult, summariseSection, type LlmClient, type SummariserResult } from './summariser.js';

export interface GeneratedSummary {
  summaryId: string;
  topicId: string;
  faithfulnessScore: number;
  unsupportedSentences: string[];
  model: string;
  evidence: number;
  quotesDiscarded: number;
  fallbackReason: string | null;
}

/**
 * One summary per topic section (CONTRACTS.md §4.6), ALWAYS created as `pending_review`: a teacher
 * must approve it before any student sees it. A failing section is logged and skipped — it never
 * fails the pipeline or the other sections.
 */
export async function createSummariesForLecture(
  lectureId: string,
  llm?: LlmClient | null,
  modelName = 'llm',
): Promise<GeneratedSummary[]> {
  const topics = await TopicSection.find({ lectureId }).sort({ index: 1 });
  const segments = await TranscriptSegment.find({ lectureId }).sort({ index: 1 });
  const chunks = await Chunk.find({ lectureId }).sort({ index: 1 });
  const chunkInputs = chunks.map((c) => ({ id: c._id, segmentStart: c.segmentStart, segmentEnd: c.segmentEnd, text: c.text }));
  const generated: GeneratedSummary[] = [];

  await Summary.deleteMany({ lectureId });
  for (const topic of topics) {
    try {
      const sectionSegments: EvidenceSegment[] = segments
        .filter((s) => s.index >= topic.segmentStart && s.index <= topic.segmentEnd)
        .map((s) => ({ id: s._id, index: s.index, startSec: s.startSec, endSec: s.endSec, text: s.text }));
      const passage = sectionSegments.map((s) => s.text).join(' ');

      let result: SummariserResult = await summariseSection(passage, llm, modelName);
      let evidence = linkEvidence(result.evidenceQuotes, sectionSegments, chunkInputs);
      let quotesDiscarded = result.evidenceQuotes.length - evidence.length;
      if (evidence.length === 0 && result.model !== 'extractive-tfidf') {
        // §4.6 needs ≥ 1 evidence item and we never invent one: use the extractive summary, whose
        // quotes are the passage's own sentences.
        logger.warn('No LLM quote could be located in the section; using the extractive summary', {
          lectureId, topicId: String(topic._id), quotes: result.evidenceQuotes.length,
        });
        result = extractiveResult(passage, 'none of the LLM quotes could be located in the transcript');
        evidence = linkEvidence(result.evidenceQuotes, sectionSegments, chunkInputs);
        quotesDiscarded += result.evidenceQuotes.length - evidence.length;
      }
      if (evidence.length === 0) throw new Error('no evidence could be located for this section');

      const faithfulness = checkFaithfulness(result.summary, passage);
      const created = await Summary.create({
        lectureId: topic.lectureId,
        topicId: topic._id,
        title: topic.label,
        text: result.summary,
        keyPoints: result.keyPoints.slice(0, 5),
        evidence,
        status: 'pending_review', // never created approved — teacher review is required
        rejectionReason: null,
        reviewedBy: null,
        reviewedAt: null,
        reviewNote: null,
        faithfulnessScore: faithfulness.faithfulnessScore,
        unsupportedSentences: faithfulness.unsupportedSentences,
        model: result.model,
        promptVersion: result.promptVersion,
      });
      if (result.fallbackReason) logger.warn('Section summarised extractively', { lectureId, topicId: String(topic._id), reason: result.fallbackReason });
      generated.push({
        summaryId: String(created._id),
        topicId: String(topic._id),
        faithfulnessScore: faithfulness.faithfulnessScore,
        unsupportedSentences: faithfulness.unsupportedSentences,
        model: result.model,
        evidence: evidence.length,
        quotesDiscarded,
        fallbackReason: result.fallbackReason ?? null,
      });
    } catch (err) {
      // One section must not prevent the others (or later pipeline stages) from completing.
      logger.error('Could not summarise a topic section; skipped', { lectureId, topicId: String(topic._id), error: err });
    }
  }
  return generated;
}
