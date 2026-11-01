import type { Evidence, Id, IsoDateTime } from './common';
import type { RejectionReason, ReviewStatus } from './enums';

/** Evidence on a summary; must lie inside the parent topic section. */
export type SummaryEvidence = Evidence;

/** One summary per topic section — docs/CONTRACTS.md §4.6, §6.6. */
export interface Summary {
  id: Id;
  lectureId: Id;
  topicId: Id;
  title: string;
  text: string;
  keyPoints: string[];
  evidence: SummaryEvidence[];
  status: ReviewStatus;
  rejectionReason: RejectionReason | null;
  reviewNote: string | null;
  /** 0–1 share of summary sentences supported by the section text; null if not checked. */
  faithfulnessScore: number | null;
  /** Sentences the faithfulness check flagged. */
  unsupportedSentences: string[];
  reviewedBy: Id | null;
  reviewedAt: IsoDateTime | null;
  model: string;
  promptVersion: string;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** PATCH /summaries/:id body. */
export interface UpdateSummaryPayload {
  title?: string;
  text?: string;
  keyPoints?: string[];
}
