
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { validate } from '../../middleware/validate.js';
import { Lecture, RETRIEVERS } from '../../models/index.js';
import { notFound } from '../../utils/errors.js';
import { objectIdString } from '../../utils/schemas.js';
import { keywordSearch } from '../../services/retrieval/keyword.js';
import { vectorSearch } from '../../services/retrieval/vector.js';
import { hybridSearch } from '../../services/retrieval/hybrid.js';

/** Semantic search — owner C, PC.1 — CONTRACTS.md §5.6. */
export const searchRouter = Router();

export const retriever = z.enum(RETRIEVERS, {
  errorMap: () => ({
    message: `Must be one of ${RETRIEVERS.join(', ')}`,
  }),
});

const searchBody = z
  .object({
    query: z
      .string({ required_error: 'Required' })
      .trim()
      .min(1, 'Must be 1–500 characters')
      .max(500, 'Must be 1–500 characters'),
    lectureId: objectIdString.optional(),
    retriever: retriever.default('hybrid'),
    topK: z
      .number({ invalid_type_error: 'Must be an integer 1–20' })
      .int('Must be an integer 1–20')
      .min(1, 'Must be an integer 1–20')
      .max(20, 'Must be an integer 1–20')
      .default(5),
  })
  .strict();

searchRouter.post(
  '/search',
  requireAuth,
  validate({ body: searchBody }),
  asyncHandler(async (req, res) => {
    const startedAt = Date.now();
    const { query, lectureId, retriever: selectedRetriever, topK } =
      req.body as z.infer<typeof searchBody>;

    const user = req.user!;

    const visibilityFilter =
      user.role === 'student'
        ? { status: 'ready', transcriptApproved: true }
        : {
            $or: [
              { status: 'ready', transcriptApproved: true },
              {
                status: 'pending_review',
                uploadedBy: user.id,
              },
            ],
          };

    const lectureFilter = lectureId
      ? { $and: [visibilityFilter, { _id: lectureId }] }
      : visibilityFilter;

    const lectures = await Lecture.find(lectureFilter)
      .select('_id title')
      .lean()
      .exec();

    if (lectureId && lectures.length === 0) {
      throw notFound('Lecture');
    }

    const allowedLectureIds = lectures.map((lecture) =>
      String(lecture._id),
    );

    if (allowedLectureIds.length === 0) {
      return res.json({
        query,
        retriever: selectedRetriever,
        items: [],
        tookMs: Date.now() - startedAt,
      });
    }

    let results;

    if (selectedRetriever === 'keyword') {
      results = await keywordSearch({
        query,
        allowedLectureIds,
        k: topK,
      });
    } else if (selectedRetriever === 'vector') {
      results = await vectorSearch({
        query,
        allowedLectureIds,
        k: topK,
      });
    } else {
      results = await hybridSearch({
        query,
        allowedLectureIds,
        k: topK,
      });
    }

    const titlesByLectureId = new Map(
      lectures.map((lecture) => [
        String(lecture._id),
        lecture.title,
      ]),
    );

    const items = results.flatMap((result, index) => {
      const lectureTitle = titlesByLectureId.get(result.lectureId);

      if (lectureTitle === undefined) {
        return [];
      }

      return [
        {
          chunkId: result.chunkId,
          lectureId: result.lectureId,
          lectureTitle,
          startSec: result.startSec,
          endSec: result.endSec,
          text: result.text,
          score: result.score,
          retriever: selectedRetriever,
          rank: index + 1,
          deepLink: `/lectures/${result.lectureId}/play?t=${result.startSec}`,
        },
      ];
    });

    return res.json({
      query,
      retriever: selectedRetriever,
      items,
      tookMs: Date.now() - startedAt,
    });
  }),
);
