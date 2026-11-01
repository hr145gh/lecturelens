import { Router } from 'express';
import { z } from 'zod';
import { Types } from 'mongoose';
import { Lecture, Summary, TopicSection } from '../../models/index.js';
import { requireAuth } from '../../middleware/auth.js';
import { objectIdParams } from '../../middleware/objectIdParams.js';
import { requireRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { notImplemented } from '../../utils/errors.js';
import { emptyBody } from '../../utils/schemas.js';
import { rejectBody } from '../review.schemas.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { notFound, unauthenticated } from '../../utils/errors.js';

function viewerOf(req: { user?: { id: string; role: 'student' | 'teacher' } }) {
  if (!req.user) throw unauthenticated();
  return req.user;
}

/**
 * Section summaries — owner B, PB.2 — CONTRACTS.md §5.5. Students get approved summaries only
 * (Summary.approvedFor); ownership (404) is checked in the handler.
 */
export const summariesRouter = Router();

const updateSummaryBody = z
  .object({
    title: z.string().trim().min(1, 'Must not be empty').optional(),
    text: z.string().trim().min(1, 'Must not be empty').optional(),
    keyPoints: z
      .array(z.string().trim().min(1, 'Must not be empty'))
      .min(2, 'Must have 2–5 items')
      .max(5, 'Must have 2–5 items')
      .optional(),
  })
  .strict('Only "title", "text" and "keyPoints" can be changed')
  .refine((b) => Object.keys(b).length > 0, 'Send at least one of "title", "text", "keyPoints"');

summariesRouter.get(
  '/lectures/:id/summaries',
  requireAuth,
  objectIdParams('id'),
  asyncHandler(async (req, res) => {
    const viewer = viewerOf(req);
    const lecture = await Lecture.findById(req.params.id);
    if (!lecture) throw notFound('Lecture');

    // Students: only lectures they can see; teachers: only their own (another teacher's → 404, §1.6).
    if (viewer.role === 'student' && (lecture.status !== 'ready' || !lecture.transcriptApproved)) {
      throw notFound('Lecture');
    }
    if (viewer.role === 'teacher' && String(lecture.uploadedBy) !== viewer.id) throw notFound('Lecture');

    // Approved-only for students at the query level (§4.12); teachers see every status.
    const query = viewer.role === 'student'
      ? Summary.approvedFor(lecture._id)
      : Summary.find({ lectureId: lecture._id });
    const [items, topics] = await Promise.all([query, TopicSection.find({ lectureId: lecture._id }).select('index')]);
    // In lecture order: by the index of each summary's topic section.
    const order = new Map(topics.map((t) => [String(t._id), t.index]));
    items.sort((a, b) => (order.get(String(a.topicId)) ?? 0) - (order.get(String(b.topicId)) ?? 0));
    res.json({
      lectureId: String(lecture._id),
      items: items.map((item) => item.toJSON()),
    });
  }),
);

summariesRouter.patch(
  '/summaries/:id',
  requireAuth,
  requireRole('teacher'),
  objectIdParams('id'),
  validate({ body: updateSummaryBody }),
  () => {
    throw notImplemented('B', 'PB.2', 'Summary editing');
  },
);

summariesRouter.post(
  '/summaries/:id/approve',
  requireAuth,
  requireRole('teacher'),
  objectIdParams('id'),
  validate({ body: emptyBody }),
  asyncHandler(async (req, res) => {
    const viewer = viewerOf(req);
    const summary = await Summary.findById(req.params.id);
    if (!summary) throw notFound('Summary');
    const lecture = await Lecture.findOne({ _id: summary.lectureId, uploadedBy: viewer.id });
    if (!lecture) throw notFound('Summary'); // another teacher's summary → 404 (§1.6)
    // Idempotent (§5.5). The only way a summary becomes approved: a teacher's explicit approval.
    if (summary.status !== 'approved') {
      summary.status = 'approved';
      summary.rejectionReason = null;
      summary.reviewedBy = new Types.ObjectId(viewer.id);
      summary.reviewedAt = new Date();
      await summary.save();
    }
    res.json({ summary: summary.toJSON() });
  }),
);

summariesRouter.post('/summaries/:id/reject', requireAuth, requireRole('teacher'), objectIdParams('id'), validate({ body: rejectBody }), () => {
  throw notImplemented('B', 'PB.2', 'Summary rejection');
});
