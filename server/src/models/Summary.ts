import { Schema, model } from 'mongoose';
import {
  applyReviewRules,
  clientJson,
  evidenceSchema,
  lengthBetween,
  reviewFields,
  type ApprovalQueryHelpers,
  type Evidence,
  type ObjectId,
  type ReviewFields,
  type ReviewableModel,
} from './shared.js';

/** `summaries` — one per topic section. docs/CONTRACTS.md §4.6. */
export interface ISummary extends ReviewFields {
  lectureId: ObjectId;
  topicId: ObjectId;
  title: string;
  /** 2–5 sentence paragraph. */
  text: string;
  keyPoints: string[];
  /** Must lie inside the parent topic section (validated by the service). */
  evidence: Evidence[];
  reviewNote: string | null;
  /** 0–1: share of summary sentences supported by the section text (faithfulness check). null = not checked. */
  faithfulnessScore: number | null;
  /** Summary sentences the faithfulness check could not support from the section text. */
  unsupportedSentences: string[];
  model: string;
  promptVersion: string;
  createdAt: Date;
  updatedAt: Date;
}

export type SummaryModel = ReviewableModel<ISummary>;

const summarySchema = new Schema<ISummary, SummaryModel, object, ApprovalQueryHelpers>(
  {
    lectureId: { type: Schema.Types.ObjectId, ref: 'Lecture', required: true },
    topicId: { type: Schema.Types.ObjectId, ref: 'TopicSection', required: true },
    title: { type: String, required: true, trim: true },
    text: { type: String, required: true },
    keyPoints: { type: [String], validate: lengthBetween(2, 5) },
    evidence: { type: [evidenceSchema], validate: lengthBetween(1, 3) },
    ...reviewFields,
    reviewNote: { type: String, default: null },
    faithfulnessScore: { type: Number, min: 0, max: 1, default: null },
    unsupportedSentences: { type: [String], default: [] },
    model: { type: String, required: true },
    promptVersion: { type: String, required: true },
  },
  { timestamps: true, toJSON: clientJson() },
);

applyReviewRules(summarySchema);

summarySchema.index({ topicId: 1 }, { unique: true });
summarySchema.index({ lectureId: 1, status: 1 });

export const Summary = model<ISummary, SummaryModel>('Summary', summarySchema);
