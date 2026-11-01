import { Types } from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import { Chunk, Lecture, Summary, TopicSection, TranscriptSegment, initialStages } from '../src/models/index.js';
import { buildChunks } from '../src/services/chunking/chunker.js';
import { linkEvidence, longestSharedRun } from '../src/services/summaries/evidence.js';
import { checkFaithfulness } from '../src/services/summaries/faithfulness.js';
import { createSummariesForLecture } from '../src/services/summaries/index.js';
import {
  basePrompt,
  EXTRACTIVE_MODEL,
  extractiveSummarise,
  summariseSection,
  type LlmClient,
} from '../src/services/summaries/summariser.js';
import { splitSentences } from '../src/services/summaries/text.js';
import { authHeader, buildApp, makeStudent, makeTeacher, resetDb } from './setup.js';

/** An LLM stand-in that replays scripted replies through the caller's zod schema (like the real client). */
function scripted(...replies: unknown[]): LlmClient & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    async generateJson<T>(prompt: string, schema: z.ZodType<T>): Promise<T> {
      prompts.push(prompt);
      const reply = replies.shift();
      if (reply instanceof Error) throw reply;
      return schema.parse(reply);
    },
  };
}

const PASSAGE =
  'Gradient descent moves the parameters downhill. The update subtracts the learning rate times the gradient. ' +
  'If the learning rate is too large, every step overshoots and the loss diverges. If it is too small, training is very slow.';

describe('summariser', () => {
  it('asks for 2–4 sentences, passage-only content and 2–3 short verbatim quotes', () => {
    const p = basePrompt(PASSAGE);
    expect(p).toMatch(/2–4 sentences/);
    expect(p).toMatch(/ONLY what is in the passage/);
    expect(p).toMatch(/2–3 SHORT quotes .* VERBATIM/);
    expect(basePrompt(PASSAGE, true)).toMatch(/previous answer was not usable/);
  });

  it('uses valid LLM JSON and records the model', async () => {
    const llm = scripted({ summary: 'The update subtracts the learning rate times the gradient. Too large a rate makes the loss diverge.', evidenceQuotes: ['subtracts the learning rate times the gradient', 'the loss diverges'] });
    const r = await summariseSection(PASSAGE, llm, 'openai/gpt-oss-120b');
    expect(r).toMatchObject({ model: 'openai/gpt-oss-120b', promptVersion: 'summary-v2' });
    expect(r.keyPoints).toHaveLength(2);
  });

  it('retries once with a stricter instruction after invalid output (here: 1 sentence)', async () => {
    const llm = scripted(
      { summary: 'One sentence only.', evidenceQuotes: ['a', 'b'] },
      { summary: 'Gradient descent moves parameters downhill. Large rates diverge.', evidenceQuotes: ['moves the parameters downhill', 'the loss diverges'] },
    );
    const r = await summariseSection(PASSAGE, llm, 'm');
    expect(llm.prompts).toHaveLength(2);
    expect(llm.prompts[1]).toMatch(/not usable/);
    expect(r.promptVersion).toBe('summary-v2-strict');
  });

  it('falls back to extractive summarisation after two failures, marking the model field', async () => {
    const r = await summariseSection(PASSAGE, scripted({ summary: 'x', evidenceQuotes: [] }, new Error('HTTP 503')), 'm');
    expect(r.model).toBe(EXTRACTIVE_MODEL);
    expect(r.fallbackReason).toMatch(/strict retry: HTTP 503/);
    expect(splitSentences(r.summary).length).toBe(3);
    for (const q of r.evidenceQuotes) expect(PASSAGE).toContain(q); // its quotes are the passage's own text
  });

  it('extractive: the 3 most central sentences, in original order', () => {
    const picked = extractiveSummarise(PASSAGE, 3);
    const all = splitSentences(PASSAGE);
    expect(picked).toHaveLength(3);
    expect(picked.map((s) => all.indexOf(s))).toEqual([...picked.map((s) => all.indexOf(s))].sort((a, b) => a - b));
  });

  it('splits sentences without breaking decimals or abbreviations, and on the Devanagari danda', () => {
    expect(splitSentences('With eta 0.1 it converges, e.g. on w². Then it stops! Done?')).toEqual(['With eta 0.1 it converges, e.g. on w².', 'Then it stops!', 'Done?']);
    expect(splitSentences('class diagram structure है। अब attributes देखते हैं।')).toHaveLength(2);
  });
});

describe('evidence linking', () => {
  const segments = [
    { index: 0, startSec: 0, endSec: 10.5, text: 'Okay. Gradient descent moves the parameters   downhill, step by step.' },
    { index: 1, startSec: 10.5, endSec: 21.25, text: 'The update subtracts the learning rate times the gradient.' },
    { index: 2, startSec: 21.25, endSec: 30, text: 'Class diagram जो है, वो structure diagram के अंदर आते हैं।' },
  ];
  const chunks = buildChunks(segments, { windowSec: 15, overlapSec: 5 }).map((c, i) => ({ ...c, id: `chunk${i}` }));

  it('exact match on normalised text (case, whitespace) stores the segment\'s own verbatim text and its span', () => {
    const [e] = linkEvidence(['GRADIENT DESCENT moves the parameters downhill'], segments, chunks);
    expect(e).toMatchObject({ startSec: 0, endSec: 10.5, quote: 'Gradient descent moves the parameters downhill' }); // whitespace collapsed
    expect(chunks.find((c) => c.id === e!.chunkId)!.text.replace(/\s+/g, ' ')).toContain(e!.quote); // inside its chunk (modulo whitespace)
  });

  it('a paraphrased quote falls back to the best segment and is SHORTENED to what actually matched', () => {
    const [e] = linkEvidence(['so the update subtracts the learning rate times the slope'], segments, chunks);
    expect(e).toMatchObject({ startSec: 10.5, endSec: 21.25, quote: 'The update subtracts the learning rate times the' });
    expect(segments[1]!.text).toContain(e!.quote);
  });

  it('DISCARDS quotes it cannot locate — never a timestamp it cannot justify', () => {
    // No segment shares a long enough verbatim run with either quote (2 words < the 4-word minimum).
    expect(linkEvidence(['momentum accelerates convergence on ravines', 'the parameters of momentum ravines'], segments, chunks)).toEqual([]);
  });

  it('works on Devanagari / code-mixed text', () => {
    const [e] = linkEvidence(['वो structure diagram के अंदर आते हैं'], segments, chunks);
    expect(e).toMatchObject({ startSec: 21.25, quote: 'वो structure diagram के अंदर आते हैं' });
  });

  it('longestSharedRun keeps word order (not a bag of words)', () => {
    expect(longestSharedRun('downhill moves descent gradient', segments[0]!.text).words).toBe(1);
  });
});

describe('faithfulness check', () => {
  it('flags sentences whose content words are not in the section, and scores the rest', () => {
    const r = checkFaithfulness('The update subtracts the learning rate times the gradient. Adam uses bias-corrected moment estimates.', PASSAGE);
    expect(r.unsupportedSentences).toEqual(['Adam uses bias-corrected moment estimates.']);
    expect(r.faithfulnessScore).toBe(0.5);
  });
});

describe('createSummariesForLecture', () => {
  let lectureId: string;
  beforeEach(async () => {
    await resetDb();
    const teacher = await makeTeacher();
    const lecture = await Lecture.create({
      title: 'L', uploadedBy: teacher._id, status: 'summarising', statusDetail: 's', durationSec: 60,
      consent: { lecturerConsent: true, purposeShown: true, processorNamed: true, grantedBy: teacher._id, grantedAt: new Date() },
      mediaPath: 'x/a.mp3', media: { originalFilename: 'a.mp3', mimeType: 'audio/mpeg', sizeBytes: 1 },
    });
    lectureId = lecture.id;
    const segs = splitSentences(PASSAGE).map((text, i) => ({ lectureId, index: i, startSec: i * 15, endSec: i * 15 + 14, text, confidence: 0.9, lowConfidence: false, modelVersion: 'm' }));
    await TranscriptSegment.insertMany(segs);
    await Chunk.insertMany(buildChunks(segs, { windowSec: 30, overlapSec: 10 }).map((c) => ({ ...c, lectureId, embeddingModel: 'x' })));
    await TopicSection.insertMany([
      { lectureId, index: 0, startSec: 0, endSec: 30, segmentStart: 0, segmentEnd: 1, label: 'Gradient descent update rule', keywords: ['a', 'b', 'c'], method: 'fixed_window' },
      { lectureId, index: 1, startSec: 30, endSec: 60, segmentStart: 2, segmentEnd: 3, label: 'Choosing the learning rate', keywords: ['a', 'b', 'c'], method: 'fixed_window' },
    ]);
  });

  it('creates one pending_review summary per section — never approved — with faithfulness stored', async () => {
    const llm = scripted(
      { summary: 'Gradient descent moves the parameters downhill. The update subtracts the learning rate times the gradient.', evidenceQuotes: ['moves the parameters downhill', 'subtracts the learning rate times the gradient'] },
      { summary: 'A large learning rate overshoots and diverges. Momentum fixes everything instantly.', evidenceQuotes: ['every step overshoots and the loss diverges', 'training is very slow'] },
    );
    const made = await createSummariesForLecture(lectureId, llm, 'test-model');
    const stored = await Summary.find({ lectureId }).sort({ createdAt: 1 }).lean();
    expect(stored).toHaveLength(2);
    expect(stored.every((s) => s.status === 'pending_review' && s.reviewedBy === null)).toBe(true);
    expect(stored[0]).toMatchObject({ faithfulnessScore: 1, unsupportedSentences: [], model: 'test-model' });
    expect(stored[1]!.unsupportedSentences).toEqual(['Momentum fixes everything instantly.']);
    expect(stored[1]!.faithfulnessScore).toBe(0.5);
    for (const s of stored) for (const e of s.evidence) expect(e.endSec).toBeGreaterThan(e.startSec);
    expect(made.map((m) => m.evidence)).toEqual([2, 2]);
  });

  it('when no LLM quote can be located it uses the extractive summary instead of inventing evidence', async () => {
    const llm = scripted(
      { summary: 'Gradient descent moves the parameters downhill. It updates them.', evidenceQuotes: ['entirely invented words here', 'nothing like the passage'] },
      { summary: 'Too large diverges. Too small is slow.', evidenceQuotes: ['the loss diverges', 'training is very slow'] },
    );
    const made = await createSummariesForLecture(lectureId, llm, 'test-model');
    expect(made[0]).toMatchObject({ model: EXTRACTIVE_MODEL, fallbackReason: expect.stringMatching(/could be located/) });
    const first = await Summary.findOne({ topicId: (await TopicSection.findOne({ lectureId, index: 0 }))!._id });
    expect(first!.evidence.length).toBeGreaterThan(0);
  });

  it('a section that fails does not stop the others (or throw)', async () => {
    vi.spyOn(Summary, 'create').mockRejectedValueOnce(new Error('disk full'));
    const made = await createSummariesForLecture(lectureId, null);
    expect(made).toHaveLength(1);
    expect(await Summary.countDocuments({ lectureId })).toBe(1);
    vi.restoreAllMocks();
  });
});

describe('summaries routes', () => {
  const app = buildApp();
  let teacher: Awaited<ReturnType<typeof makeTeacher>>;
  let other: Awaited<ReturnType<typeof makeTeacher>>;
  let student: Awaited<ReturnType<typeof makeStudent>>;
  let lectureId: Types.ObjectId;
  let pendingId: string;

  beforeEach(async () => {
    await resetDb();
    [teacher, other, student] = await Promise.all([makeTeacher(), makeTeacher(), makeStudent()]);
    const lecture = await Lecture.create({
      title: 'L', uploadedBy: teacher._id, status: 'ready', statusDetail: 'Ready.', transcriptApproved: true, durationSec: 60,
      consent: { lecturerConsent: true, purposeShown: true, processorNamed: true, grantedBy: teacher._id, grantedAt: new Date() },
      stages: initialStages().map((s) => ({ ...s, state: 'done', ms: 1 })), mediaPath: 'x/a.mp3', media: { originalFilename: 'a.mp3', mimeType: 'audio/mpeg', sizeBytes: 1 },
    });
    lectureId = lecture._id;
    const topics = await TopicSection.insertMany([1, 0].map((index) => ({
      lectureId, index, startSec: index * 30, endSec: index * 30 + 30, segmentStart: index, segmentEnd: index, label: `Topic ${index}`, keywords: ['a', 'b', 'c'], method: 'fixed_window',
    })));
    const evidence = [{ chunkId: new Types.ObjectId(), startSec: 1, endSec: 2, quote: 'q' }];
    const docs = await Summary.insertMany(topics.map((t) => ({
      lectureId, topicId: t._id, title: t.label, text: 'One. Two.', keyPoints: ['One.', 'Two.'], evidence, model: 'm', promptVersion: 'v',
      status: t.index === 0 ? 'approved' : 'pending_review',
    })));
    pendingId = String(docs.find((d) => d.status === 'pending_review')!._id);
  });

  const list = (who: { _id: Types.ObjectId; role: 'student' | 'teacher' }) =>
    request(app).get(`/api/v1/lectures/${lectureId}/summaries`).set(authHeader(who));

  it('students see approved only; the owner sees all, in topic order; another teacher gets 404', async () => {
    expect((await list(student).expect(200)).body.items.map((s: { title: string }) => s.title)).toEqual(['Topic 0']);
    const owner = await list(teacher).expect(200);
    expect(owner.body.items.map((s: { title: string; status: string }) => `${s.title}:${s.status}`)).toEqual(['Topic 0:approved', 'Topic 1:pending_review']);
    expect(owner.body.items[0]).toHaveProperty('faithfulnessScore');
    await list(other).expect(404);
  });

  it('approve: teacher-only (student 403), owner-only (other teacher 404), idempotent', async () => {
    await request(app).post(`/api/v1/summaries/${pendingId}/approve`).set(authHeader(student)).expect(403);
    await request(app).post(`/api/v1/summaries/${pendingId}/approve`).set(authHeader(other)).expect(404);
    const a = await request(app).post(`/api/v1/summaries/${pendingId}/approve`).set(authHeader(teacher)).expect(200);
    const b = await request(app).post(`/api/v1/summaries/${pendingId}/approve`).set(authHeader(teacher)).expect(200);
    expect(a.body.summary).toMatchObject({ status: 'approved', reviewedBy: teacher.id });
    expect(b.body.summary.reviewedAt).toBe(a.body.summary.reviewedAt);
    expect((await list(student).expect(200)).body.items).toHaveLength(2);
  });

  it('PATCH and reject are still honest 501s', async () => {
    await request(app).patch(`/api/v1/summaries/${pendingId}`).set(authHeader(teacher)).send({ title: 'x' }).expect(501);
    await request(app).post(`/api/v1/summaries/${pendingId}/reject`).set(authHeader(teacher)).send({ rejectionReason: 'OTHER' }).expect(501);
  });
});
