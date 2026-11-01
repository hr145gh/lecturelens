
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { objectIdParams } from '../../middleware/objectIdParams.js';
import { requireRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import {
  DIFFICULTIES,
  OPTION_IDS,
  REJECTION_REASONS,
  REVIEW_STATUSES,
  Lecture,
  Question,
  Quiz,
} from '../../models/index.js';
import { forbidden, notFound, notImplemented } from '../../utils/errors.js';
import { objectIdString, paging } from '../../utils/schemas.js';

/**
 * Questions, quizzes and attempts — owner C, PC.3 — CONTRACTS.md §5.7. Students only ever get
 * approved questions, without answer keys before submission; ownership is checked in handlers.
 */
export const quizRouter = Router();

const oneOf = <T extends readonly [string, ...string[]]>(values: T) =>
  z.enum(values, { errorMap: () => ({ message: `Must be one of ${values.join(', ')}` }) });

const int = (min: number, max: number) =>
  z.number({ invalid_type_error: `Must be an integer ${min}–${max}` })
    .int(`Must be an integer ${min}–${max}`)
    .min(min, `Must be an integer ${min}–${max}`)
    .max(max, `Must be an integer ${min}–${max}`);

const generateBody = z
  .object({
    count: int(1, 20).default(5),
    topicIds: z.array(objectIdString).optional(),
    difficulty: oneOf(DIFFICULTIES).optional(),
  })
  .strict();

const questionsQuery = z.object({
  lectureId: objectIdString,
  status: oneOf(REVIEW_STATUSES).optional(),
  topicId: objectIdString.optional(),
  ...paging,
});

const updateQuestionBody = z
  .object({
    stem: z.string().trim().min(1, 'Must not be empty').optional(),
    options: z
      .array(
        z.object({
          id: oneOf(OPTION_IDS),
          text: z.string().trim().min(1, 'Must not be empty'),
        }).strict(),
      )
      .length(4, 'Must be exactly four options')
      .refine(
        (o) => o.every((opt, i) => opt.id === OPTION_IDS[i]),
        'Option ids must be a, b, c, d in order',
      )
      .optional(),
    correctOptionId: oneOf(OPTION_IDS).optional(),
    explanation: z.string().trim().min(1, 'Must not be empty').optional(),
    difficulty: oneOf(DIFFICULTIES).optional(),
    status: oneOf(REVIEW_STATUSES).optional(),
    rejectionReason: oneOf(REJECTION_REASONS).nullable().optional(),
    reviewNote: z.string().trim().max(2000, 'Must be at most 2000 characters').nullable().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'Send at least one field to change')
  .refine((b) => b.status !== 'rejected' || b.rejectionReason, {
    path: ['rejectionReason'],
    message: 'Required when status is "rejected"',
  });

const createQuizBody = z
  .object({
    lectureId: objectIdString,
    topicIds: z.array(objectIdString).optional(),
    questionCount: int(1, 20).default(10),
  })
  .strict();

const quizzesQuery = z.object({ lectureId: objectIdString.optional(), ...paging });

const attemptBody = z
  .object({
    startedAt: z.string({ required_error: 'Required' })
      .datetime({ message: 'Must be an ISO 8601 date-time' }),
    answers: z
      .array(
        z.object({
          questionId: objectIdString,
          selectedOptionId: oneOf(OPTION_IDS).nullable(),
        }).strict(),
      )
      .min(1, 'Must answer every quiz question'),
  })
  .strict();

quizRouter.post(
  '/lectures/:id/questions/generate',
  requireAuth,
  requireRole('teacher'),
  objectIdParams('id'),
  validate({ body: generateBody }),
  () => {
    throw notImplemented('C', 'PC.3', 'Question generation');
  },
);

quizRouter.get(
  '/questions',
  requireAuth,
  requireRole('teacher'),
  validate({ query: questionsQuery }),
  () => {
    throw notImplemented('C', 'PC.3', 'The question bank');
  },
);

quizRouter.patch(
  '/questions/:id',
  requireAuth,
  requireRole('teacher'),
  objectIdParams('id'),
  validate({ body: updateQuestionBody }),
  () => {
    throw notImplemented('C', 'PC.3', 'Question review');
  },
);

quizRouter.post(
  '/quizzes',
  requireAuth,
  validate({ body: createQuizBody }),
  () => {
    throw notImplemented('C', 'PC.3', 'Quiz creation');
  },
);

quizRouter.get(
  '/quizzes',
  requireAuth,
  validate({ query: quizzesQuery }),
  () => {
    throw notImplemented('C', 'PC.3', 'The quiz list');
  },
);

quizRouter.get(
  '/quizzes/:id',
  requireAuth,
  objectIdParams('id'),
  asyncHandler(async (req, res) => {
    const quiz = await Quiz.findById(req.params.id).exec();

    if (!quiz) {
      throw notFound('Quiz');
    }

    const lecture = await Lecture.findById(quiz.lectureId)
      .select('uploadedBy')
      .exec();

    if (!lecture) {
      throw notFound('Lecture');
    }

    // Only the lecture uploader may see complete question details.
    const isLectureOwner = String(lecture.uploadedBy) === req.user!.id;

    // Never include questions that have not been approved.
    const questions = await Question.find({
      _id: { $in: quiz.questionIds },
    })
      .approvedOnly()
      .exec();

    // Preserve the question order stored in the quiz.
    const orderedQuestions = quiz.questionIds
      .map((id) =>
        questions.find(
          (question) => String(question._id) === String(id),
        ),
      )
      .filter((question) => question !== undefined)
      .map((question) => {
        if (isLectureOwner) {
          return question.toJSON();
        }

        // Student and non-owner view: never expose answer keys or explanations.
        return {
          id: String(question._id),
          topicId: question.topicId,
          difficulty: question.difficulty,
          stem: question.stem,
          options: question.options,
        };
      });

    res.json({
      quiz: {
        id: String(quiz._id),
        lectureId: String(quiz.lectureId),
        createdBy: String(quiz.createdBy),
        title: quiz.title,
        topicIds: quiz.topicIds.map(String),
        questions: orderedQuestions,
        createdAt: quiz.createdAt,
      },
    });
  }),
);

// Any signed-in user may submit (CONTRACTS.md §1.6: teachers can do everything students can).
quizRouter.post(
  '/quizzes/:id/attempts',
  requireAuth,
  objectIdParams('id'),
  validate({ body: attemptBody }),
  () => {
    throw notImplemented('C', 'PC.3', 'Quiz attempts');
  },
);

// Own attempts only — nobody reads another user's attempt (§1.6); checked in the handler.
quizRouter.get(
  '/attempts/:id',
  requireAuth,
  objectIdParams('id'),
  () => {
    throw notImplemented('C', 'PC.3', 'Attempt results');
  },
);
