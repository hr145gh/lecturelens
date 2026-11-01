import { Chunk, Summary, TopicSection, TranscriptSegment } from '../../models/index.js';
import { checkFaithfulness } from './faithfulness.js';
import { linkEvidence, type EvidenceSegment } from './evidence.js';
import { summariseSection, type LlmClient } from './summariser.js';

export interface GeneratedSummary {
  summaryId: string;
  faithfulnessScore: number;
  unsupportedSentences: string[];
  model: string;
}

export async function createSummariesForLecture(
  lectureId: string,
  llm?: LlmClient,
): Promise<GeneratedSummary[]> {
  const topics = await TopicSection.find({ lectureId }).sort({ index: 1 });
  const segments = await TranscriptSegment.find({ lectureId }).sort({ index: 1 });
  const chunks = await Chunk.find({ lectureId }).sort({ index: 1 });
  const generated: GeneratedSummary[] = [];

  await Summary.deleteMany({ lectureId });
  for (const topic of topics) {
    const sectionSegments: EvidenceSegment[] = segments
      .filter((segment) => segment.index >= topic.segmentStart && segment.index <= topic.segmentEnd)
      .map((segment) => ({
        id: segment._id,
        index: segment.index,
        startSec: segment.startSec,
        endSec: segment.endSec,
        text: segment.text,
      }));
    const passage = sectionSegments.map((segment) => segment.text).join(' ');
    try {
      const result = await summariseSection(passage, llm);
      const evidence = linkEvidence(
        result.evidenceQuotes,
        sectionSegments,
        chunks.map((chunk) => ({
          id: chunk._id,
          segmentStart: chunk.segmentStart,
          segmentEnd: chunk.segmentEnd,
          text: chunk.text,
        })),
      );
      const faithfulness = checkFaithfulness(result.summary, passage);
      const created = await Summary.create({
        lectureId: topic.lectureId,
        topicId: topic._id,
        title: topic.label,
        text: result.summary,
        keyPoints: result.keyPoints.length >= 2
          ? result.keyPoints.slice(0, 5)
          : ['See the summary for the main point.', 'Review the linked transcript evidence.'],
        evidence,
        status: 'pending_review',
        rejectionReason: null,
        reviewedBy: null,
        reviewedAt: null,
        reviewNote: null,
        model: result.model,
        promptVersion: result.promptVersion,
      });
      generated.push({
        summaryId: String(created._id),
        faithfulnessScore: faithfulness.faithfulnessScore,
        unsupportedSentences: faithfulness.unsupportedSentences,
        model: result.model,
      });
    } catch {
      // One section must not prevent other summaries or pipeline stages from completing.
    }
  }

  return generated;
}

