import { Router } from 'express';
import { z } from 'zod';
import { Types } from 'mongoose';
import { Lecture, TopicSection, TranscriptSegment } from '../../models/index.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { requireAuth } from '../../middleware/auth.js';
import { objectIdParams } from '../../middleware/objectIdParams.js';
import { requireRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { emptyBody } from '../../utils/schemas.js';
import { conflict, notFound, notImplemented, unauthenticated } from '../../utils/errors.js';
import { assertTopicTiling } from '../../services/topics/segmenter.js';
import { rejectBody } from '../review.schemas.js';

/**
 * Topic sections — owner B, PB.1 — CONTRACTS.md §5.5. Students get approved topics only
 * (TopicSection.approvedFor); ownership (404) is checked in the handler.
 */
export const topicsRouter = Router();

function viewerOf(req: { user?: { id: string; role: 'student' | 'teacher' } }) {
  if (!req.user) throw unauthenticated();
  return req.user;
}

/** The topic, if the caller owns its lecture; another teacher's topic is a 404 (§1.6). */
async function findOwnedTopic(topicId: string, teacherId: string) {
  const topic = await TopicSection.findById(topicId);
  if (!topic) throw notFound('Topic');
  const lecture = await Lecture.findOne({ _id: topic.lectureId, uploadedBy: teacherId });
  if (!lecture) throw notFound('Topic');
  return { topic, lecture };
}

const updateTopicBody = z
  .object({
    label: z.string().trim().min(1, 'Must be 1–80 characters').max(80, 'Must be 1–80 characters').optional(),
    keywords: z
      .array(z.string().trim().min(1, 'Must not be empty'))
      .min(3, 'Must have 3–8 items')
      .max(8, 'Must have 3–8 items')
      .optional(),
  })
  .strict('Only "label" and "keywords" can be changed')
  .refine((b) => b.label !== undefined || b.keywords !== undefined, 'Send "label" and/or "keywords"');

topicsRouter.get(
  '/lectures/:id/topics',
  requireAuth,
  objectIdParams('id'),
  asyncHandler(async (req, res) => {
    const viewer = viewerOf(req);
    const lecture = await Lecture.findById(req.params.id);
    if (!lecture) throw notFound('Lecture');

    // Students: only lectures they can see (ready + transcript approved). Teachers: only their own.
    if (viewer.role === 'student' && (lecture.status !== 'ready' || !lecture.transcriptApproved)) {
      throw notFound('Lecture');
    }
    if (viewer.role === 'teacher' && String(lecture.uploadedBy) !== viewer.id) throw notFound('Lecture');

    // Approved-only for students, at the query level (§4.12); teachers see pending and rejected too.
    const query =
      viewer.role === 'student'
        ? TopicSection.approvedFor(lecture.id)
        : TopicSection.find({ lectureId: lecture._id });
    const items = await query.sort({ index: 1 });
    res.json({
      lectureId: String(lecture._id),
      items: items.map((item) => item.toJSON()),
    });
  }),
);

topicsRouter.patch(
  '/topics/:id',
  requireAuth,
  requireRole('teacher'),
  objectIdParams('id'),
  validate({ body: updateTopicBody }),
  asyncHandler(async (req, res) => {
    const { topic, lecture } = await findOwnedTopic(req.params.id!, viewerOf(req).id);
    const body = req.body as { label?: string; keywords?: string[] };
    if (body.label !== undefined) topic.label = body.label;
    if (body.keywords !== undefined) topic.keywords = body.keywords;

    // Re-validate the lecture's tiling with this edit applied — BEFORE saving, so a failed check
    // changes nothing. (Boundaries are not editable in v1, §5.5; this guards stored data.)
    const sections = await TopicSection.find({ lectureId: topic.lectureId }).sort({ index: 1 });
    const segments = await TranscriptSegment.find({ lectureId: topic.lectureId }).sort({ index: 1 }).select('index startSec endSec text');
    try {
      if (lecture.durationSec == null) throw new Error('Lecture duration is missing');
      assertTopicTiling(
        sections.map((s) => (String(s._id) === String(topic._id) ? topic : s)),
        lecture.durationSec,
        segments,
      );
    } catch (err) {
      throw conflict(`This lecture's topic sections are inconsistent (${(err as Error).message}). Reprocess from "segmenting".`);
    }

    await topic.save();
    res.json({ topic: topic.toJSON() });
  }),
);

topicsRouter.post(
  '/topics/:id/approve',
  requireAuth,
  requireRole('teacher'),
  objectIdParams('id'),
  validate({ body: emptyBody }),
  asyncHandler(async (req, res) => {
    const viewer = viewerOf(req);
    const { topic } = await findOwnedTopic(req.params.id!, viewer.id);
    // Idempotent (§5.5): approving an approved topic changes nothing.
    if (topic.status !== 'approved') {
      topic.status = 'approved';
      topic.rejectionReason = null;
      topic.reviewedBy = new Types.ObjectId(viewer.id);
      topic.reviewedAt = new Date();
      await topic.save();
    }
    res.json({ topic: topic.toJSON() });
  }),
);

topicsRouter.post(
  '/topics/:id/reject',
  requireAuth,
  requireRole('teacher'),
  objectIdParams('id'),
  validate({ body: rejectBody }),
  () => {
    throw notImplemented('B', 'PB.1', 'Topic rejection');
  },
);
