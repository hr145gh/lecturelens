import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { objectIdParams } from '../../middleware/objectIdParams.js';
import { requireRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { Lecture, TranscriptSegment } from '../../models/index.js';
import { conflict, forbidden, notFound, unauthenticated } from '../../utils/errors.js';
import { emptyBody } from '../../utils/schemas.js';

export const transcriptRouter = Router();

const segmentParams = z.object({
  id: z.string(),
  index: z.coerce
    .number({ invalid_type_error: 'Must be an integer ≥ 0' })
    .int('Must be an integer ≥ 0')
    .min(0, 'Must be an integer ≥ 0'),
});

const segmentBody = z
  .object({
    text: z
      .string({ required_error: 'Required' })
      .trim()
      .min(1, 'Must be 1–2000 characters')
      .max(2000, 'Must be 1–2000 characters'),
  })
  .strict('Only "text" can be changed; timing is not editable');

function viewerOf(req: { user?: { id: string; role: string } }) {
  if (!req.user) throw unauthenticated();
  return req.user;
}

async function findOwnedLecture(id: string, userId: string) {
  const lecture = await Lecture.findOne({ _id: id, uploadedBy: userId });
  if (!lecture) throw notFound('Lecture');
  return lecture;
}

transcriptRouter.get(
  '/lectures/:id/transcript',
  requireAuth,
  objectIdParams('id'),
  asyncHandler(async (req, res) => {
    const viewer = viewerOf(req);
    const lecture = await Lecture.findById(req.params.id);

    if (!lecture) throw notFound('Lecture');

    if (viewer.role === 'teacher') {
      if (String(lecture.uploadedBy) !== viewer.id) {
        throw notFound('Lecture');
      }
    } else {
      if (lecture.status !== 'ready') throw notFound('Lecture');

      if (!lecture.transcriptApproved) {
        throw forbidden('TRANSCRIPT_NOT_APPROVED');
      }
    }

    const segments = await TranscriptSegment.find({ lectureId: lecture._id })
      .sort({ index: 1 })
      .select('index startSec endSec text confidence lowConfidence speaker corrected originalText correctedBy correctedAt modelVersion createdAt updatedAt');

    res.json({
      lectureId: lecture.id,
      transcriptApproved: lecture.transcriptApproved,
      items: segments,
    });
  }),
);

transcriptRouter.patch(
  '/lectures/:id/segments/:index',
  requireAuth,
  requireRole('teacher'),
  objectIdParams('id'),
  validate({ params: segmentParams, body: segmentBody }),
  asyncHandler(async (req, res) => {
    const viewer = viewerOf(req);
    const lecture = await findOwnedLecture(req.params.id!, viewer.id);

    const segment = await TranscriptSegment.findOne({
      lectureId: lecture._id,
      index: Number(req.params.index),
    });

    if (!segment) throw notFound('Transcript segment');

    if (segment.text !== req.body.text) {
      segment.text = req.body.text;
      segment.correctedBy = new Types.ObjectId(viewer.id);
      segment.correctedAt = new Date();

      // The model records originalText on the first text edit.
      await segment.save();
    }

    res.json({ segment });
  }),
);

transcriptRouter.post(
  '/lectures/:id/transcript/approve',
  requireAuth,
  requireRole('teacher'),
  objectIdParams('id'),
  validate({ body: emptyBody }),
  asyncHandler(async (req, res) => {
    const viewer = viewerOf(req);
    const lecture = await findOwnedLecture(req.params.id!, viewer.id);

    if (lecture.status !== 'ready') {
      throw conflict('Transcript can only be approved when the lecture is ready.', {
        status: lecture.status,
      });
    }

    if (!lecture.transcriptApproved) {
      lecture.transcriptApproved = true;
      lecture.transcriptApprovedBy = new Types.ObjectId(viewer.id);
      lecture.transcriptApprovedAt = new Date();
      await lecture.save();
    }

    res.json({ lecture });
  }),
);
