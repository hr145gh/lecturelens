import { readFileSync } from 'node:fs';
import { Types } from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { Lecture, TopicSection, TranscriptSegment, initialStages } from '../src/models/index.js';
import { buildChunks, CHUNK_DEFAULTS, WORD_CAP } from '../src/services/chunking/chunker.js';
import { labelSection, labellingSchema, tfidfLabel, topTfidfTerms, type LlmClient } from '../src/services/topics/labeller.js';
import {
  assertTopicTiling,
  embeddingSimilarity,
  fixedWindow,
  type EmbeddingProvider,
  type TopicSectionOutput,
} from '../src/services/topics/segmenter.js';
import { authHeader, buildApp, makeStudent, makeTeacher, resetDb } from './setup.js';

/** The seeded lecture's transcript (mocks/transcript.json — Lecture 7, 45 segments, 0–1199.398 s). */
const transcript = JSON.parse(readFileSync(new URL('../../mocks/transcript.json', import.meta.url), 'utf8')) as {
  items: Array<{ index: number; startSec: number; endSec: number; text: string }>;
};
const SEGMENTS = transcript.items;
const DURATION = 1199.398;
const words = (t: string) => t.trim().split(/\s+/).length;

describe('retrieval chunks (buildChunks)', () => {
  const chunks = buildChunks(SEGMENTS, CHUNK_DEFAULTS);
  const seg = (i: number) => SEGMENTS.find((s) => s.index === i)!;

  it('never splits a segment: every chunk is whole consecutive segments, text joined by single spaces', () => {
    for (const c of chunks) {
      const inside = SEGMENTS.filter((s) => s.index >= c.segmentStart && s.index <= c.segmentEnd);
      expect(c.startSec).toBe(seg(c.segmentStart).startSec);
      expect(c.endSec).toBe(seg(c.segmentEnd).endSec);
      expect(c.text).toBe(inside.map((s) => s.text).join(' '));
    }
  });

  it('consecutive chunks overlap by at least the configured 15 s, snapped back to a segment edge', () => {
    const longest = Math.max(...SEGMENTS.map((s) => s.endSec - s.startSec));
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1]!;
      const next = chunks[i]!;
      if (prev.segmentStart === prev.segmentEnd) continue; // a one-segment chunk cannot overlap
      const overlap = prev.endSec - next.startSec;
      expect(next.segmentStart).toBeGreaterThan(prev.segmentStart); // always moves forward
      expect(next.segmentStart).toBeLessThanOrEqual(prev.segmentEnd);
      expect(overlap).toBeGreaterThanOrEqual(CHUNK_DEFAULTS.overlapSec);
      expect(overlap).toBeLessThan(CHUNK_DEFAULTS.overlapSec + longest);
    }
  });

  it('no chunk exceeds the ~200-word cap (unless a single segment alone is longer)', () => {
    for (const c of chunks) if (c.segmentStart !== c.segmentEnd) expect(words(c.text)).toBeLessThanOrEqual(WORD_CAP);
    const huge = [
      { index: 0, startSec: 0, endSec: 30, text: Array(150).fill('alpha').join(' ') },
      { index: 1, startSec: 30, endSec: 50, text: Array(100).fill('beta').join(' ') },
    ];
    const cut = buildChunks(huge, { windowSec: 600, overlapSec: 0 });
    expect(cut.map((c) => [c.segmentStart, c.segmentEnd])).toEqual([[0, 0], [1, 1]]); // cut early, not merged to 250
  });

  it('covers every segment, and the seeded lecture yields this many chunks', () => {
    const covered = new Set(chunks.flatMap((c) => SEGMENTS.filter((s) => s.index >= c.segmentStart && s.index <= c.segmentEnd).map((s) => s.index)));
    expect(covered.size).toBe(SEGMENTS.length);
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
    expect(chunks.every((c) => c.embedding.length === 0)).toBe(true); // Member C fills embeddings
    expect(chunks.length).toMatchInlineSnapshot(`26`);
  });
});

/**
 * A STAND-IN embedder for tests only — not an embedding model. It maps each window to the topic its
 * words belong to, so the right boundaries are known; real embeddings are Member C's.
 */
const standIn: EmbeddingProvider = {
  embed: (texts) =>
    texts.map((t) => {
      const counts = [0, 1, 2].map((k) => (t.match(new RegExp(['alpha', 'beta', 'gamma'][k]!, 'g')) ?? []).length);
      return counts.map((n) => n + 0.01);
    }),
};

/** 30 segments of 20 s: topic alpha for 0–9, beta 10–19, gamma 20–29. */
const threeTopics = Array.from({ length: 30 }, (_, i) => ({
  index: i,
  startSec: i * 20,
  endSec: i * 20 + 19.5,
  text: `${['alpha', 'beta', 'gamma'][Math.floor(i / 10)]} words for segment ${i}`,
}));

describe('topic sections — tiling for both methods', () => {
  it('fixed_window (baseline) tiles the seeded lecture exactly', () => {
    const sections = fixedWindow(SEGMENTS, DURATION);
    expect(() => assertTopicTiling(sections, DURATION, SEGMENTS)).not.toThrow();
    expect(sections.every((s) => s.method === 'fixed_window' && s.boundaryScore === null)).toBe(true);
    expect(sections.length).toMatchInlineSnapshot(`4`);
  });

  it('embedding_similarity (proposed) tiles the seeded lecture exactly', async () => {
    const sections = await embeddingSimilarity(SEGMENTS, DURATION, standIn);
    expect(() => assertTopicTiling(sections, DURATION, SEGMENTS)).not.toThrow();
    expect(sections.every((s) => s.method === 'embedding_similarity')).toBe(true);
  });

  it('finds the real topic changes, scores them 1 − similarity, and leaves boundaryScore null for section 0', async () => {
    const sections = await embeddingSimilarity(threeTopics, 600, standIn, { threshold: 0.45, minSectionSec: 120 });
    expect(sections.map((s) => [s.segmentStart, s.segmentEnd])).toEqual([[0, 9], [10, 19], [20, 29]]);
    expect(sections.map((s) => s.startSec)).toEqual([0, 200, 400]);
    expect(sections[0]!.boundaryScore).toBeNull();
    for (const s of sections.slice(1)) expect(s.boundaryScore!).toBeGreaterThan(0.9);
    expect(() => assertTopicTiling(sections, 600, threeTopics)).not.toThrow();
  });

  it('enforces the minimum section length by merging close boundaries, keeping the strongest', async () => {
    // alpha 0–9, a short beta 10–12 (60 s), gamma 13–29: real changes at 200 s and 260 s, only 60 s apart.
    const shortMiddle = threeTopics.map((s) => ({
      ...s,
      text: `${s.index < 10 ? 'alpha' : s.index < 13 ? 'beta' : 'gamma'} words for segment ${s.index}`,
    }));
    const loose = await embeddingSimilarity(shortMiddle, 600, standIn, { threshold: 0.45, minSectionSec: 30 });
    expect(loose.map((s) => s.startSec)).toEqual([0, 200, 260]); // both found when allowed
    const sections = await embeddingSimilarity(shortMiddle, 600, standIn, { threshold: 0.45, minSectionSec: 120 });
    expect(sections).toHaveLength(2); // merged: one of the two boundaries kept, never a 60 s section
    expect([200, 260]).toContain(sections[1]!.startSec);
    expect(sections.every((s) => s.endSec - s.startSec >= 120)).toBe(true);
    expect(() => assertTopicTiling(sections, 600, shortMiddle)).not.toThrow();
  });

  it('a single topic gives a single section, never a forced split', async () => {
    const one = threeTopics.map((s) => ({ ...s, text: `alpha words ${s.index}` }));
    expect(await embeddingSimilarity(one, 600, standIn)).toHaveLength(1);
  });

  it('refuses to run without Member C\'s embedder rather than inventing one', async () => {
    await expect(embeddingSimilarity(SEGMENTS, DURATION)).rejects.toThrow(/Member C/);
  });
});

describe('assertTopicTiling (CONTRACTS.md §4.5)', () => {
  const base = (): TopicSectionOutput[] => fixedWindow(threeTopics, 600, { sectionSec: 200 });
  const broken = (mutate: (s: TopicSectionOutput[]) => void) => {
    const s = base();
    mutate(s);
    return () => assertTopicTiling(s, 600, threeTopics);
  };

  it('accepts a correct tiling', () => expect(broken(() => undefined)).not.toThrow());
  it('rejects a first section not starting at 0', () => expect(broken((s) => (s[0]!.startSec = 1))).toThrow(/start at 0/));
  it('rejects a gap', () => expect(broken((s) => (s[1]!.startSec += 5))).toThrow(/without gaps or overlaps/));
  it('rejects an overlap', () => expect(broken((s) => (s[1]!.startSec -= 5))).toThrow(/without gaps or overlaps/));
  it('rejects a last section not ending at durationSec', () => expect(broken((s) => (s.at(-1)!.endSec = 599))).toThrow(/end at lecture durationSec/));
  it('rejects non-contiguous indexes', () => expect(broken((s) => (s[1]!.index = 5))).toThrow(/contiguous from 0/));
  it('rejects a segment that does not exist', () => expect(broken((s) => (s.at(-1)!.segmentEnd = 99))).toThrow(/existing segments/));
  it('rejects skipped segments between sections', () => expect(broken((s) => (s[1]!.segmentStart += 1))).toThrow(/contiguous/));
  it('rejects an empty list', () => expect(() => assertTopicTiling([], 600, threeTopics)).toThrow(/must not be empty/));
});

describe('labels', () => {
  const llm = (reply: unknown): LlmClient => ({
    generateJson: async (_prompt, schema) => schema.parse(reply),
  });

  it('uses the shared LLM client\'s JSON when it validates', async () => {
    const label = await labelSection('gradient descent learning rate', { llm: llm({ label: 'Gradient descent and learning rates', keywords: ['gradient', 'learning rate', 'step size'] }) });
    expect(label).toEqual({ label: 'Gradient descent and learning rates', keywords: ['gradient', 'learning rate', 'step size'], source: 'llm' });
  });

  it('falls back to TF-IDF on invalid JSON or a provider error, never failing the pipeline', async () => {
    const text = 'backpropagation chain rule backpropagation upstream gradient local gradient';
    const bad = await labelSection(text, { llm: llm({ label: 'x', keywords: [] }) });
    const down = await labelSection(text, { llm: { generateJson: async () => { throw new Error('503'); } } });
    for (const l of [bad, down]) {
      expect(l.source).toBe('tfidf');
      expect(l.keywords[0]).toBe('backpropagation');
      expect(labellingSchema.safeParse(l).success).toBe(true); // a valid 3–6 word title and 3–5 keywords
    }
  });

  it('TF-IDF prefers words that distinguish a section over words common to the whole lecture', () => {
    const corpus = ['loss loss gradient descent descent', 'loss gradient momentum momentum', 'loss dropout dropout regularisation'];
    expect(topTfidfTerms(corpus[1]!, 2, corpus)).toEqual(['momentum', 'gradient']);
  });

  it('always produces at least 3 keywords, even for a tiny section', () => {
    const l = tfidfLabel('ok so yes');
    expect(l.keywords.length).toBeGreaterThanOrEqual(3);
    expect(labellingSchema.safeParse(l).success).toBe(true);
  });
});

describe('topics routes', () => {
  const app = buildApp();
  let teacher: Awaited<ReturnType<typeof makeTeacher>>;
  let other: Awaited<ReturnType<typeof makeTeacher>>;
  let student: Awaited<ReturnType<typeof makeStudent>>;
  let lectureId: string;

  beforeEach(async () => {
    await resetDb();
    [teacher, other, student] = await Promise.all([makeTeacher(), makeTeacher(), makeStudent()]);
    const lecture = await Lecture.create({
      title: 'Lecture 7', uploadedBy: teacher._id, status: 'ready', statusDetail: 'Ready.', transcriptApproved: true, durationSec: 600,
      consent: { lecturerConsent: true, purposeShown: true, processorNamed: true, grantedBy: teacher._id, grantedAt: new Date() },
      stages: initialStages().map((s) => ({ ...s, state: 'done', ms: 1 })), mediaPath: 'x/a.mp3',
      media: { originalFilename: 'a.mp3', mimeType: 'audio/mpeg', sizeBytes: 1 },
    });
    lectureId = lecture.id;
    await TranscriptSegment.insertMany(threeTopics.map((s) => ({ ...s, lectureId, confidence: 0.9, lowConfidence: false, modelVersion: 'm' })));
    const sections = fixedWindow(threeTopics, 600, { sectionSec: 200 });
    await TopicSection.insertMany(
      sections.map((s, i) => ({ ...s, lectureId, label: `Section ${i}`, keywords: ['a', 'b', 'c'], status: i === 1 ? 'pending_review' : 'approved' })),
    );
  });

  const get = (who: { _id: Types.ObjectId; role: 'student' | 'teacher' }) =>
    request(app).get(`/api/v1/lectures/${lectureId}/topics`).set(authHeader(who));

  it('a student GET returns only approved sections; the owner sees all of them', async () => {
    const asStudent = await get(student).expect(200);
    expect(asStudent.body.items.map((t: { status: string }) => t.status)).toEqual(['approved', 'approved']);
    const asOwner = await get(teacher).expect(200);
    expect(asOwner.body.items.map((t: { status: string }) => t.status)).toEqual(['approved', 'pending_review', 'approved']);
  });

  it('another teacher gets 404 (existence not revealed)', async () => {
    await get(other).expect(404);
  });

  it('PATCH by a student → 403, and nothing changes', async () => {
    const topic = await TopicSection.findOne({ lectureId, index: 0 });
    const res = await request(app).patch(`/api/v1/topics/${topic!.id}`).set(authHeader(student)).send({ label: 'Hijacked' }).expect(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect((await TopicSection.findById(topic!._id))!.label).toBe('Section 0');
  });

  it('PATCH by the owner edits label/keywords only; boundaries are not editable (§5.5)', async () => {
    const topic = await TopicSection.findOne({ lectureId, index: 1 });
    const res = await request(app).patch(`/api/v1/topics/${topic!.id}`).set(authHeader(teacher)).send({ label: 'Stochastic gradient descent', keywords: ['sgd', 'mini-batch', 'epoch'] }).expect(200);
    expect(res.body.topic).toMatchObject({ label: 'Stochastic gradient descent', keywords: ['sgd', 'mini-batch', 'epoch'], status: 'pending_review' });
    await request(app).patch(`/api/v1/topics/${topic!.id}`).set(authHeader(teacher)).send({ startSec: 10 }).expect(422);
  });

  it('PATCH re-validates the tiling before saving: inconsistent stored sections → 409 and nothing saved', async () => {
    await TopicSection.updateOne({ lectureId, index: 2 }, { $set: { endSec: 590 } }); // corrupt stored data
    const topic = await TopicSection.findOne({ lectureId, index: 0 });
    const res = await request(app).patch(`/api/v1/topics/${topic!.id}`).set(authHeader(teacher)).send({ label: 'New title here' }).expect(409);
    expect(res.body.error.message).toMatch(/end at lecture durationSec/);
    expect((await TopicSection.findById(topic!._id))!.label).toBe('Section 0');
  });

  it('approve is owner-only and idempotent', async () => {
    const topic = await TopicSection.findOne({ lectureId, index: 1 });
    await request(app).post(`/api/v1/topics/${topic!.id}/approve`).set(authHeader(other)).expect(404);
    const first = await request(app).post(`/api/v1/topics/${topic!.id}/approve`).set(authHeader(teacher)).expect(200);
    const second = await request(app).post(`/api/v1/topics/${topic!.id}/approve`).set(authHeader(teacher)).expect(200);
    expect(first.body.topic).toMatchObject({ status: 'approved', reviewedBy: teacher.id });
    expect(second.body.topic.reviewedAt).toBe(first.body.topic.reviewedAt);
  });
});
