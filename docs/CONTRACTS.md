# LectureLens — API & Data Contracts

> **Owner: Member D.** This file is the single source of truth for every shape,
> field name, enum value and error code shared between client and server.
> Anyone else who needs a change must open a `contract-change` issue; do not
> edit this file directly. Every accepted change is logged in
> [`docs/DECISIONS.md`](./DECISIONS.md).
>
> Fixtures in [`mocks/`](../mocks) are **exact response bodies** for the routes
> named in §8, as seen by the owning teacher. They obey every rule in this file.

---

## 1. Conventions

### 1.1 IDs

- Every document id is a MongoDB `ObjectId`.
- Clients see it as the **24-character lowercase hex string** field `id`.
  `_id` and `__v` are **never** sent to clients.
- Foreign keys are serialised the same way (`lectureId`, `topicId`, `uploadedBy`, …):
  24-char hex strings, never populated objects unless this file says so.
- Implementation: every Mongoose schema uses the shared `toJSON` transform
  (`id = _id.toString()`, delete `_id`, `__v`, and all server-only fields listed in §4).
- A path parameter that is not a valid ObjectId returns `404 NOT_FOUND`.

### 1.2 Wall-clock times

- ISO-8601, UTC, **milliseconds**, trailing `Z`: `"2026-10-20T09:14:22.418Z"`.
- This is exactly what `Date.prototype.toISOString()` produces. Stored as BSON `Date`.
- Field names end in `At` (`createdAt`, `reviewedAt`, `grantedAt`, …).

### 1.3 Media offsets (positions inside a lecture recording)

- **Float seconds**, rounded to **3 decimals** (millisecond precision):
  `Math.round(x * 1000) / 1000`.
- **Always** named `startSec` / `endSec` (or end in `Sec`, e.g. `durationSec`).
- JSON drops trailing zeros, so `612.340` is sent as `612.34`. That is the same value.
- **`hh:mm:ss` strings and integer milliseconds are FORBIDDEN for media offsets — in the
  API, in the database and in URLs — because the HTML5 player seeks with
  `video.currentTime = 612.34`, which takes float seconds directly.** Formatting as
  `10:12` is a display concern done in the UI at render time only.
- Intervals are half-open: `[startSec, endSec)`.
- Not media offsets: **processing durations** (`ms`, `latencyMs`, `tookMs`) are
  integer milliseconds of server wall-clock time. They never seek a player.

### 1.4 JSON & pagination

- All JSON fields are **camelCase**. Enum *values* are the exact strings in §2.
- Absent optional values are sent as `null`, not omitted (arrays: `[]`).
- Paginated list routes accept `?page=1&limit=20` (defaults: `page=1`, `limit=20`;
  `limit` max `100`; `page` ≥ 1) and return:

  ```json
  { "items": [], "page": 1, "limit": 20, "total": 0 }
  ```

  Out-of-range `page`/`limit` → `422 VALIDATION_FAILED`.
- Per-lecture collections that are bounded by one lecture (transcript, topics,
  summaries) are **not** paginated and return `{ "lectureId": "...", "items": [...] }`.

### 1.5 Auth

- Every route under `/api/v1` requires `Authorization: Bearer <jwt>` **except**
  `POST /auth/register`, `POST /auth/login`, `GET /health`, and
  `GET /lectures/:id/media` (signed URL, see §5.3 — `<video src>` cannot send headers).
- JWT payload: `{ "sub": "<userId>", "role": "student" | "teacher", "iat", "exp" }`,
  HS256, secret `JWT_SECRET`, lifetime `JWT_EXPIRES_IN` (default `7d`).
- Missing/invalid/expired token → `401 UNAUTHENTICATED`.
- Access rules used in §5:
  - **public** — no token.
  - **any** — any authenticated user.
  - **teacher** — `role === "teacher"`.
  - **owner** — teacher whose id equals `lecture.uploadedBy`. A teacher who is not the
    owner gets `404 NOT_FOUND` (we do not reveal other teachers' lectures); a student
    gets `403 FORBIDDEN`.
  - **student** — `role === "student"`.
- Lecture visibility (single-course MVP): teachers see lectures they uploaded;
  students see a lecture only when `status: "ready"` **and** `transcriptApproved: true` —
  in lists, detail, search and ask alike.
- Tokens: missing, malformed or invalid → `401` with `details: {}`; expired →
  `401` with `details: { "reason": "expired" }` so the client can say "your session expired".
  `requireAuth` reloads the user on every request, so a deleted account loses access at once.

### 1.6 RBAC matrix

Enforced **on the server** (`requireAuth`, then `requireRole` / `requireOwnerOrRole` from
`server/src/middleware/`). Hiding a button in the UI is not access control: every
teacher-only route rejects a student token with `403 FORBIDDEN` even if the client never
calls it.

| Who | May |
| --- | --- |
| **student** | read lectures whose `status` is `ready` **and** `transcriptApproved` is `true`; read **approved** topic sections, summaries and questions; build quizzes and create attempts; read **own** attempts and **own** revision plan |
| **teacher** | everything a student can do, plus: upload; patch segments; approve transcripts, topics, summaries and questions; generate questions; reprocess; delete own lectures; read `pending_review` content |
| **nobody** | read another user's attempts; call any route except `GET /health`, `POST /auth/register`, `POST /auth/login` and the signed `GET /lectures/:id/media` without a valid token |

Ownership still applies to teachers: every teacher action and every `pending_review` read
above is limited to lectures the teacher uploaded (`lecture.uploadedBy`). Another teacher's
lecture answers `404 NOT_FOUND` (§1.5), not `403`, so its existence is not revealed.

---

## 2. Enums — exact strings, no synonyms

| Enum | Values |
| --- | --- |
| `lecture.status` | `uploaded` \| `extracting` \| `transcribing` \| `chunking` \| `segmenting` \| `summarising` \| `indexing` \| `ready` \| `failed` |
| `user.role` | `student` \| `teacher` |
| review `status` (topics, summaries, questions) | `pending_review` \| `approved` \| `rejected` |
| `rejectionReason` | `FACTUALLY_WRONG` \| `UNSUPPORTED` \| `AMBIGUOUS` \| `TOO_EASY` \| `TOO_HARD` \| `DUPLICATE` \| `OTHER` |
| `abstainReason` | `NO_RELEVANT_PASSAGE` \| `LOW_CONFIDENCE` \| `PARSE_FAILED` |
| `retriever` | `keyword` \| `vector` \| `hybrid` |
| `topic.method` | `embedding_similarity` \| `fixed_window` |

Supporting enums (also exact):

| Enum | Values | Notes |
| --- | --- | --- |
| stage `name` | `extracting` \| `transcribing` \| `chunking` \| `segmenting` \| `summarising` \| `indexing` | The six processing statuses, in pipeline order. |
| stage `state` | `pending` \| `running` \| `done` \| `failed` \| `skipped` | |
| `question.type` | `mcq` | Only type in v1. |
| `question.difficulty` | `easy` \| `medium` \| `hard` | |
| option `id` | `a` \| `b` \| `c` \| `d` | Exactly four options, in this order. |
| `llmcache.purpose` | `topic_label` \| `summary` \| `mcq` \| `answer` | |

Status lifecycle (pipeline runs in-process inside the API server, in this order):

```
uploaded → extracting → transcribing → chunking → segmenting → summarising → indexing → ready
                any stage ──(error)──▶ failed
```

- `failed` sets `lecture.error` (see §4.2). `POST /lectures/:id/reprocess` restarts from a
  given stage and is only allowed from `ready` or `failed`.
- On server boot, any lecture found in a non-terminal status (not `ready`/`failed`) is set to
  `failed` with `error.code = "PIPELINE_INTERRUPTED"` (there is no job queue to resume from).

---

## 3. Error envelope

**Every** non-2xx response from **every** route has exactly this body:

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Request body is invalid.",
    "details": { "title": "Required", "consent.lecturerConsent": "Must be true" },
    "requestId": "req_8fK2a"
  }
}
```

- `code` — one of the codes below (SCREAMING_SNAKE_CASE).
- `message` — human-readable, safe to show to users, no stack traces or secrets.
- `details` — **always an object**; `{}` when there is nothing to add. Never `null`.
- `requestId` — `"req_"` + a URL-safe random id, generated per request by the
  `requestId` middleware, also returned in the `X-Request-Id` response header and
  printed in server logs for that request.

### 3.1 Reserved codes

| Code | HTTP | When | `details` |
| --- | --- | --- | --- |
| `UNAUTHENTICATED` | 401 | Missing/invalid/expired JWT; wrong email or password on login. | `{}`, or `{ "reason": "expired" }` for an expired JWT |
| `FORBIDDEN` | 403 | Authenticated but the role may not do this. | `{}` or `{ "reason": "..." }` |
| `NOT_FOUND` | 404 | Unknown route, unknown/invalid id, or another teacher's lecture. | `{}` |
| `VALIDATION_FAILED` | 422 | Any invalid input: body, query, params, multipart fields, malformed JSON. | **field → message map**, dotted paths for nested fields, e.g. `{ "options.2.text": "Required" }` |
| `NOT_IMPLEMENTED` | 501 | Route exists in this contract but its owner has not built it yet (§7). | `{ "owner": "C", "prompt": "PC.2" }` |
| `PROVIDER_UNAVAILABLE` | 503 | AssemblyAI / LLM provider down, timed out, or rate-limited us. | `{ "provider": "groq" }` |
| `INTERNAL_ERROR` | 500 | Anything unexpected. Logged with `requestId`. | `{}` |

There is **no 400**. All bad-input cases, including unparseable JSON, are `422 VALIDATION_FAILED`.

### 3.2 Additional codes

| Code | HTTP | When |
| --- | --- | --- |
| `CONFLICT` | 409 | Duplicate email on register; illegal state transition (e.g. reprocess while processing, generate questions before `ready`). `details` names the current state, e.g. `{ "status": "transcribing" }`. |
| `PAYLOAD_TOO_LARGE` | 413 | Upload exceeds `MAX_UPLOAD_MB`. `details: { "maxMb": 512 }` |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | Upload MIME type not in the accepted list (§5.3). `details: { "mimeType": "..." }` |
| `RATE_LIMITED` | 429 | Too many attempts from one IP within 15 minutes: `POST /auth/login` allows 10 **failed** attempts (successful sign-ins never count, so signing in and out cannot lock anyone out); `POST /auth/register` allows 10 attempts. `details: { "retryAfterSec": 412 }`, plus a `Retry-After` header. |

Adding a new code is a contract change.

---

## 4. MongoDB collections

Notation: **R** = required, **S** = server-only (never serialised to clients).
All collections have `createdAt` / `updatedAt` via Mongoose `timestamps: true` unless noted.
Every `*Id` / `*By` field is an `ObjectId` reference.

### 4.1 `users`

| Field | Type | Notes |
| --- | --- | --- |
| `_id` | ObjectId | → `id` |
| `email` | string R | unique, trimmed, lowercased |
| `passwordHash` | string R S | bcrypt, cost 10, `select: false` |
| `name` | string R | 2–80 chars |
| `role` | enum R | `student` \| `teacher`; immutable after register |
| `lastLoginAt` | Date \| null | |
| `createdAt`, `updatedAt` | Date | |

Indexes: `{ email: 1 }` unique.

### 4.2 `lectures`

| Field | Type | Notes |
| --- | --- | --- |
| `title` | string R | 1–200 chars |
| `courseCode` | string \| null | e.g. `"CS 3410"` |
| `description` | string \| null | ≤ 2000 chars |
| `recordedOn` | string \| null | calendar date `YYYY-MM-DD` the lecture was given; `null` if not supplied |
| `notes` | string \| null S | teacher's lecture notes from upload; kept for later use, not serialised in v1 |
| `uploadedBy` | ObjectId R | → `users` (a teacher) |
| `consent` | object R | embedded, see below; upload is rejected unless all three booleans are `true` |
| `consent.lecturerConsent` | boolean R | lecturer agreed to recording being processed |
| `consent.purposeShown` | boolean R | the purpose statement was shown before consent |
| `consent.processorNamed` | boolean R | the third-party processors (AssemblyAI, LLM provider) were named |
| `consent.grantedBy` | ObjectId R | user who ticked consent (= uploader) |
| `consent.grantedAt` | Date R | server time of upload |
| `status` | enum R | default `uploaded` |
| `statusDetail` | string R | one human sentence about the current status; no relative times ("3 min ago") |
| `error` | object \| null | `null` unless `status === "failed"`: `{ stage, code, message, at }` — `stage` is a stage name, `code` one of `NO_AUDIO_STREAM`, `UNSUPPORTED_CODEC`, `TRANSCRIPTION_FAILED`, `PROVIDER_UNAVAILABLE`, `PIPELINE_INTERRUPTED`, `INTERNAL_ERROR`, `NOT_IMPLEMENTED` (set only by the former placeholder pipeline, so it can appear on older lectures; the current pipeline never sets it, §7) |
| `stages` | array S* | `[{ name, state, ms, startedAt, finishedAt }]`, one per stage name in order. *Exposed only via `GET /lectures/:id/status`. |
| `durationSec` | float \| null | from ffprobe during `extracting`; `null` before that |
| `mediaPath` | string R S | path of original upload, relative to `STORAGE_DIR`: `<lectureId>/<uuid><ext>` (the client's filename is never used as a path) |
| `audioPath` | string \| null S | extracted mono audio, relative to `STORAGE_DIR` |
| `media` | object R | `{ originalFilename, mimeType, sizeBytes }` |
| `provider` | object R S | `{ asr, asrModel, externalId }` — ASR provider (`assemblyai` \| `groq`), bare model id (e.g. `universal-2`) and the provider's job id (AssemblyAI transcript id; `null` for Groq); each `null` until a transcript is stored. The full raw provider response is kept beside the media at `STORAGE_DIR/<lectureId>/asr-response.json`, not in the document |
| `transcriptApproved` | boolean R | default `false`; set by `POST /lectures/:id/transcript/approve`; reset to `false` by reprocess from `extracting`/`transcribing` |
| `transcriptApprovedBy` | ObjectId \| null | |
| `transcriptApprovedAt` | Date \| null | |

Indexes: `{ uploadedBy: 1, createdAt: -1 }`, `{ status: 1, createdAt: -1 }`.

Delete cascades to every collection below that has `lectureId`, plus files under `STORAGE_DIR`.

### 4.3 `transcriptsegments`

One ASR utterance. Immutable timing; only `text` may be corrected.

| Field | Type | Notes |
| --- | --- | --- |
| `lectureId` | ObjectId R | |
| `index` | int R | 0-based, contiguous, ordered by time |
| `startSec`, `endSec` | float R | `startSec < endSec`; `endSec[i] ≤ startSec[i+1]` (no overlap; silence gaps allowed) |
| `text` | string R | current text (corrected if edited) |
| `confidence` | float R | 0–1, from ASR |
| `lowConfidence` | boolean R | `confidence < 0.75`; set at ingest, **not** cleared by correction |
| `speaker` | string \| null | ASR diarisation label: `"A"`, `"B"`, … |
| `corrected` | boolean R | default `false`; `true` after the first edit |
| `originalText` | string \| null | `null` until the first edit. **Set ONCE on the first edit to the ASR text and never overwritten** — this is the audit trail. |
| `correctedBy` | ObjectId \| null | last editor |
| `correctedAt` | Date \| null | last edit time |
| `modelVersion` | string R | `<provider>-<model>`: `"assemblyai-universal-2"` or `"groq-whisper-large-v3-turbo"`. Segments are utterances built from the provider's word timings (new segment on a speaker change, a pause > 1.2 s, a sentence end after ≥ 6 s, or at 30 s); `confidence` is the mean of the words' |

Indexes: `{ lectureId: 1, index: 1 }` unique; `{ lectureId: 1, lowConfidence: 1 }`.

### 4.4 `chunks`

Retrieval unit (for RAG; never shown to users — not a topic section): consecutive whole segments
(never split a segment), ~60 s windows that **overlap** by ~15 s, every boundary snapped to a segment
edge, cut early at ~200 words so the embedding model never truncates a chunk. Window and overlap
are starting values to tune (`CHUNK_SECONDS`, `CHUNK_OVERLAP_SECONDS`). Because chunks overlap, a
segment can belong to two chunks. The fixtures (`mocks/chunks.json`) are a simpler non-overlapping
example of 3 segments per chunk.

| Field | Type | Notes |
| --- | --- | --- |
| `lectureId` | ObjectId R | |
| `index` | int R | 0-based |
| `startSec`, `endSec` | float R | `= segments[segmentStart].startSec`, `= segments[segmentEnd].endSec` |
| `text` | string R | segment texts joined by a single space |
| `segmentStart`, `segmentEnd` | int R | inclusive segment indexes |
| `embedding` | float[384] R S | `EMBEDDING_MODEL` output, **L2-normalised on write** (‖v‖ = 1 ± 1e-6); `select: false`. `[]` until the `indexing` stage writes it (the seed inserts `[]`); any other length than 0 or 384 is rejected |
| `embeddingModel` | string R | e.g. `"Xenova/all-MiniLM-L6-v2"` |

Indexes:
- `{ lectureId: 1, index: 1 }` unique.
- Text index `{ text: "text" }`, name `chunks_text`, `default_language: "english"` — used by the `keyword` retriever.
- Atlas Vector Search index `chunks_embedding_vs` on `embedding` (`numDimensions: 384`,
  `similarity: "dotProduct"` — equal to cosine because vectors are normalised), filter field
  `lectureId`. This is an index on the existing Atlas cluster, **not** a separate vector
  database. If the cluster tier lacks Vector Search, the `vector` retriever loads the
  in-scope chunk embeddings and computes dot products in-process.

Chunks become stale when a segment is corrected; the owner re-runs
`POST /lectures/:id/reprocess { "fromStage": "chunking" }`.

### 4.5 `topicsections`

| Field | Type | Notes |
| --- | --- | --- |
| `lectureId` | ObjectId R | |
| `index` | int R | 0-based |
| `startSec`, `endSec` | float R | see tiling invariant |
| `segmentStart`, `segmentEnd` | int R | inclusive; contiguous across sections; cover every segment |
| `label` | string R | ≤ 80 chars |
| `keywords` | string[] R | 3–8 items |
| `method` | enum R | `embedding_similarity` \| `fixed_window` |
| `boundaryScore` | float \| null | 0–1 strength of the boundary at `startSec`; `null` for `index 0` and for `fixed_window` |
| `status` | enum R | **default `pending_review`** |
| `rejectionReason` | enum \| null | required iff `status === "rejected"` |
| `reviewedBy` | ObjectId \| null | |
| `reviewedAt` | Date \| null | |

**Tiling invariant** (enforced in the service on every write): sections of a lecture,
sorted by `index`, tile `[0, durationSec)` exactly — `sections[0].startSec === 0`,
`sections[last].endSec === lecture.durationSec`, and `sections[i].endSec === sections[i+1].startSec`.
Internal boundaries sit at `segments[segmentStart].startSec`. No gaps, no overlaps.
Boundaries are not editable via the API in v1 (only `label`, `keywords`).

Indexes: `{ lectureId: 1, index: 1 }` unique; `{ lectureId: 1, status: 1 }`.

### 4.6 `summaries`

One summary per topic section.

| Field | Type | Notes |
| --- | --- | --- |
| `lectureId` | ObjectId R | |
| `topicId` | ObjectId R | → `topicsections` |
| `title` | string R | defaults to the topic label |
| `text` | string R | 2–5 sentence paragraph |
| `keyPoints` | string[] R | 2–5 items |
| `evidence` | Evidence[] R | 1–3 items, see below |
| `status` | enum R | **default `pending_review`** |
| `rejectionReason` | enum \| null | required iff `rejected` |
| `reviewNote` | string \| null | teacher's free-text note |
| `faithfulnessScore` | float \| null | 0–1, share of summary sentences whose content words are supported by the section text (token-overlap check, `services/summaries/faithfulness.ts`); `null` if not checked. Shown to the reviewing teacher |
| `unsupportedSentences` | string[] R | summary sentences that check flagged (`[]` when none) — a review aid, not proof of error |
| `reviewedBy`, `reviewedAt` | ObjectId/Date \| null | |
| `model`, `promptVersion` | string R | the LLM id (`LLM_MODEL`, default `"openai/gpt-oss-120b"`; the fixtures were recorded as `"llama-3.3-70b-versatile"`) or `"extractive-tfidf"` for the fallback; e.g. `"summary-v2"` |

**Evidence object** (used by summaries and questions; citations extend it):

```ts
{ chunkId: string; startSec: number; endSec: number; quote: string }
```

- `quote` is a **verbatim** substring of `chunks[chunkId].text`, ≤ 300 chars.
- `startSec`/`endSec` is the span of the transcript segment containing the quote, and lies
  inside the chunk's span.
- For summaries and questions it **must** lie inside the parent topic section:
  `section.startSec ≤ startSec` and `endSec ≤ section.endSec`.
- The service validates all three on write; LLM output that fails is regenerated or dropped,
  never stored.

Indexes: `{ topicId: 1 }` unique; `{ lectureId: 1, status: 1 }`.

### 4.7 `questions`

| Field | Type | Notes |
| --- | --- | --- |
| `lectureId`, `topicId` | ObjectId R | |
| `type` | enum R | `mcq` |
| `difficulty` | enum R | `easy` \| `medium` \| `hard` |
| `stem` | string R | |
| `options` | `{ id, text }[4]` R | ids `a`,`b`,`c`,`d` in order |
| `correctOptionId` | enum R | `a`–`d` |
| `explanation` | string R | why the keyed answer is right |
| `evidence` | Evidence[] R | 1–3 items, inside the topic section |
| `status` | enum R | **default `pending_review`** |
| `rejectionReason` | enum \| null | required iff `rejected`, `null` otherwise |
| `reviewNote` | string \| null | |
| `reviewedBy`, `reviewedAt` | ObjectId/Date \| null | |
| `model`, `promptVersion` | string R | e.g. `"mcq-v1"` |

Indexes: `{ lectureId: 1, status: 1, topicId: 1 }`.

### 4.8 `quizzes`

| Field | Type | Notes |
| --- | --- | --- |
| `lectureId` | ObjectId R | |
| `createdBy` | ObjectId R | student or teacher |
| `title` | string R | e.g. `"Practice quiz — Lecture 7"` |
| `questionIds` | ObjectId[] R | drawn only from `approved` questions at creation |
| `topicIds` | ObjectId[] R | topics requested (`[]` = all) |

Indexes: `{ createdBy: 1, createdAt: -1 }`, `{ lectureId: 1 }`.

### 4.9 `attempts`

| Field | Type | Notes |
| --- | --- | --- |
| `quizId`, `lectureId`, `studentId` | ObjectId R | |
| `answers` | array R | `[{ questionId, topicId, selectedOptionId, correct }]` (`selectedOptionId` `null` = skipped, counts as wrong) |
| `score` | object R | `{ correct, total, accuracy }`; `accuracy` = `correct/total`, 3 decimals |
| `perTopic` | array R | `[{ topicId, topicLabel, correct, total, accuracy }]`, ordered by topic index |
| `startedAt`, `submittedAt` | Date R | |
| `timeTakenSec` | float R | `submittedAt − startedAt` in seconds |

No `updatedAt` (attempts are immutable). Indexes: `{ studentId: 1, submittedAt: -1 }`, `{ quizId: 1, studentId: 1 }`.

### 4.10 `revisionrecommendations`

One document per generated plan. Regenerated synchronously after each attempt is
scored; `GET /revision-plan` returns the latest.

| Field | Type | Notes |
| --- | --- | --- |
| `studentId` | ObjectId R | |
| `lectureId` | ObjectId \| null | `null` = plan across all lectures |
| `generatedAt` | Date R | |
| `basedOnAttemptIds` | ObjectId[] R | |
| `lectureAccuracy` | float R | overall accuracy across those attempts |
| `items` | array R | ranked, see §6.12: `rank, lectureId, topicId, topicLabel, startSec, endSec, deepLink, correct, attempted, accuracy, reason` |

`reason` is a sentence built from the student's **actual numbers** (counts, percentages,
dates). Template labels like `"weak_topic"` are forbidden.

Items only reference **approved** topics. Indexes: `{ studentId: 1, lectureId: 1, generatedAt: -1 }`.

### 4.11 `llmcache` (server-only, never exposed)

| Field | Type | Notes |
| --- | --- | --- |
| `key` | string R | sha256 hex of `JSON.stringify({ purpose, model, promptVersion, input })` |
| `purpose` | enum R | `topic_label` \| `summary` \| `mcq` \| `answer` |
| `model`, `promptVersion` | string R | |
| `response` | Mixed R | parsed, validated JSON output |
| `tokensIn`, `tokensOut` | int R | |
| `hits` | int R | default 0 |
| `expiresAt` | Date R | `createdAt + 30 days` |

Indexes: `{ key: 1 }` unique; `{ expiresAt: 1 }` with `expireAfterSeconds: 0` (TTL).

### 4.12 Approval filtering — MUST

`status` **defaults to `pending_review`** on `summaries`, `questions` and `topicsections`.

**Every student-facing query on those three collections MUST filter `status: "approved"` at
the Mongoose level** — via the shared query helper (`Model.find(...).approvedOnly()`, or the
static `Model.approvedFor(lectureId)`; `APPROVED` is the matching filter for `populate({ match })`) applied
in the service layer whenever `req.user.role === "student"`, including `populate()` calls,
quiz assembly, search and ask. **Filtering in the UI is not a substitute** — unapproved
content must never leave the server for a student.

---

## 5. REST endpoints

Base path: `/api/v1`. Owner letters: **A** ingest/transcript, **B** topics/summaries,
**C** search/Q&A/quizzes/revision, **D** contracts/auth/lectures/infra.
Routes marked **(+)** were added beyond the minimum list to make the flows complete.

### 5.1 Route table

| Method | Path | Owner | Role | Purpose |
| --- | --- | --- | --- | --- |
| POST | `/auth/register` | D | public | Create account → `201 { token, user }` |
| POST | `/auth/login` | D | public | Exchange email+password for JWT → `200 { token, user }` |
| GET | `/auth/me` | D | any | Validate token, return `{ user }` |
| GET | `/users/me` | D | any | Current user's profile `{ user }` |
| PATCH | `/users/me` | D | any | Update `name` only → `{ user }` |
| GET | `/health` | D | public | Liveness + DB state |
| POST | `/lectures` | D | teacher | Multipart upload with consent; starts pipeline → `202 { lecture }` |
| GET | `/lectures` | D | any | Paginated lecture list (teacher: own; student: `ready` and `transcriptApproved` only) |
| GET | `/lectures/:id` | D | owner / student if `ready` and `transcriptApproved` | Lecture detail `{ lecture, mediaUrl }` |
| DELETE | `/lectures/:id` | D | owner | Delete lecture, all derived docs and files → `204` |
| GET | `/lectures/:id/status` | D | owner | Processing status with per-stage timings |
| POST | `/lectures/:id/reprocess` | D | owner | Re-run pipeline from a stage → `202 { lecture }` |
| GET | `/lectures/:id/media` **(+)** | D | signed URL | Stream original media with HTTP Range support |
| GET | `/lectures/:id/transcript` | A | owner / student if `transcriptApproved` | Full transcript `{ lectureId, transcriptApproved, items }` |
| PATCH | `/lectures/:id/segments/:index` | A | owner | Correct one segment's text → `{ segment }` |
| POST | `/lectures/:id/transcript/approve` | A | owner | Mark transcript approved → `{ lecture }` |
| GET | `/lectures/:id/topics` | B | owner / student (approved only) | Topic sections `{ lectureId, items }` |
| PATCH | `/topics/:id` | B | owner | Edit `label` / `keywords` → `{ topic }` |
| POST | `/topics/:id/approve` | B | owner | Approve topic → `{ topic }` |
| POST | `/topics/:id/reject` **(+)** | B | owner | Reject with `rejectionReason` → `{ topic }` |
| GET | `/lectures/:id/summaries` | B | owner / student (approved only) | Section summaries `{ lectureId, items }` |
| PATCH | `/summaries/:id` **(+)** | B | owner | Edit `title` / `text` / `keyPoints` → `{ summary }` |
| POST | `/summaries/:id/approve` | B | owner | Approve summary → `{ summary }` |
| POST | `/summaries/:id/reject` **(+)** | B | owner | Reject with `rejectionReason` → `{ summary }` |
| POST | `/search` | C | any | Retrieve ranked passages |
| POST | `/ask` | C | any | Grounded answer with timestamp citations, or abstain |
| POST | `/lectures/:id/questions/generate` | C | owner | Generate MCQs (status `pending_review`) → `201 { items }` |
| GET | `/questions` | C | teacher | Paginated question bank for own lectures (review queue) |
| PATCH | `/questions/:id` | C | owner | Edit and/or approve/reject a question → `{ question }` |
| POST | `/quizzes` | C | any | Build a quiz from approved questions → `201 { quiz }` |
| GET | `/quizzes` **(+)** | C | any | Paginated `QuizSummary` list of the caller's quizzes, with best score |
| GET | `/quizzes/:id` | C | quiz creator / owner | Get quiz `{ quiz }` |
| POST | `/quizzes/:id/attempts` | C | any | Submit answers, get scored attempt → `201 { attempt }` |
| GET | `/attempts/:id` | C | the attempt's own user only | Get scored attempt `{ attempt }` |
| GET | `/revision-plan` | C | any (own plan) | Latest ranked revision plan `{ plan }` |

Single-resource responses are wrapped in a named key (`{ lecture }`, `{ topic }`, …);
lists use `{ items, ... }` as in §1.4.

### 5.2 Auth & users (D)

- `POST /auth/register` body `{ email, password, name, role }` → `201 { user, token }`.
  `name` 2–80 chars (trimmed); `email` valid, trimmed and lowercased; `password` 8–128 chars with
  at least one letter and one digit; `role` `student` | `teacher`. Duplicate email (any case) →
  `409 CONFLICT`.
- `POST /auth/login` body `{ email, password }` → `200 { user, token }`. Wrong email *or* password →
  `401 UNAUTHENTICATED` with the same message, `"Invalid email or password"` (do not reveal which).
- Rate-limited per IP per 15 minutes → `429 RATE_LIMITED`: login after 10 failed attempts (successes do
  not count), register after 10 attempts.
- `PATCH /users/me` body `{ name }` only; any other field → `422` with `{ "body": "Only \"name\" can be changed" }`.
  Password change is not in v1.
- `user` object: `{ id, email, name, role, lastLoginAt, createdAt, updatedAt }`.
- `GET /health` → `200 { "status": "ok", "uptimeSec": 812.441, "db": "connected" | "not_connected", "version": "0.0.0", "timestamp": "<ISO>" }`.
  `version` is the server package version.

### 5.3 Lectures (D)

`POST /lectures` — `multipart/form-data`:

| Field | Type | Rules |
| --- | --- | --- |
| `file` | file R | `.mp4` `.mkv` `.mov` `.webm` `.mp3` `.wav` `.m4a` — MIME `video/mp4`, `video/x-matroska`, `video/quicktime`, `video/webm`, `audio/mpeg`, `audio/wav` (also `audio/x-wav`, `audio/wave`), `audio/mp4` (also `audio/x-m4a`); ≤ `MAX_UPLOAD_MB`. Browsers often send an empty or generic type (notably for `.mkv`), so the server decides by extension plus content sniffing, not the declared type alone. |
| `title` | text R | 1–200 chars |
| `courseCode` | text | optional, ≤ 100 chars |
| `description` | text | optional, ≤ 2000 chars |
| `recordedOn` | text | optional calendar date `YYYY-MM-DD` (a date, not a time — §1.2 does not apply); not in the future |
| `notes` | text | optional lecture notes, ≤ 10000 chars; stored for later use (e.g. LLM context), not serialised in v1 |
| `lecturerConsent` | text R | must be `"true"` |
| `purposeShown` | text R | must be `"true"` |
| `processorNamed` | text R | must be `"true"` |

Any consent field not `"true"` → `422` with e.g. `{ "consent.lecturerConsent": "Lecturer consent is required" }`,
and the uploaded file is deleted — no media is kept or processed without consent. Other upload errors:
missing `file` → `422 { "file": "Required" }`; an extension outside the list, a declared MIME type that
is neither generic nor listed, or content whose magic bytes do not match the extension →
`415 UNSUPPORTED_MEDIA_TYPE`; larger than `MAX_UPLOAD_MB` → `413 PAYLOAD_TOO_LARGE { "maxMb": 512 }`.
The file is stored at `STORAGE_DIR/<lectureId>/<uuid><ext>` (a relative `STORAGE_DIR` is resolved from
the repository root).
`consent.grantedBy` = caller, `consent.grantedAt` = server time. Returns `202 { lecture }` with
`status: "uploaded"`; the pipeline starts in-process immediately.

Every serialised lecture also carries two **computed, read-only** fields (not stored on the document):

- `uploadedByName` — `users.name` of `uploadedBy`, so lecture lists need no extra user lookups.
- `topicCount` — number of topic sections visible to the caller (students: `approved` only, §4.12);
  `null` until the `segmenting` stage has run.

`GET /lectures` query: `page`, `limit`, `status` (optional, one value), `q` (optional title search).
Sorted by `createdAt` desc.

`GET /lectures/:id` returns `{ lecture, mediaUrl }` where `mediaUrl` is
`/api/v1/lectures/:id/media?exp=<unix seconds>&sig=<hex HMAC-SHA256(JWT_SECRET, "<id>.<exp>")>`,
valid 6 hours. `GET /lectures/:id/media` checks `sig`/`exp` instead of the Bearer header
(`401` if invalid/expired) and supports `Range` → `206`.

`GET /lectures/:id/status` → §6.2, plus `progressPct` (0–100: share of the six stages `done`).
Stage states are derived from `status` in the §2 order, so they can never contradict it.

`POST /lectures/:id/reprocess` body `{ "fromStage": "<stage name>" }` (or `?fromStage=`; default
`"extracting"`) → `202 { lecture }`. Allowed from `ready`, or from `failed` at or before the failing
stage; otherwise `409 CONFLICT { status }`. **Idempotent:** repeating the same request while that
restart is still queued returns `202` with the lecture and starts nothing new. Deletes derived docs
from that stage on (`transcribing`: segments and everything after; `chunking`: chunks, topics,
summaries, questions; `segmenting`: topics, summaries, questions; `summarising`: summaries;
`indexing`: clears chunk embeddings). Quizzes and attempts are kept as history.
Reprocessing from `extracting` or `transcribing` resets `transcriptApproved` and **discards
corrections**; from `chunking` onward keeps corrected segments.

`DELETE /lectures/:id` → `204`. Deletes every document with this `lectureId` (segments, chunks,
topics, summaries, questions, quizzes, attempts, revision plans), then the lecture, then
`STORAGE_DIR/<lectureId>/`. If any derived collection fails, the lecture is kept so the delete can be
retried, the failure is logged, and the response is `500`.

### 5.4 Transcript (A)

- `GET /lectures/:id/transcript` → `{ lectureId, transcriptApproved, items: Segment[] }` ordered by
  `index`. Student and `transcriptApproved === false` → `403 FORBIDDEN`, `details: { "reason": "TRANSCRIPT_NOT_APPROVED" }`.
- `PATCH /lectures/:id/segments/:index` body `{ "text": "..." }` (1–2000 chars). First edit copies
  the ASR text to `originalText`; later edits never touch `originalText`. Sets `corrected`,
  `correctedBy`, `correctedAt`. Timing is not editable.
- `POST /lectures/:id/transcript/approve` — no body; idempotent. Requires `status: "ready"` (else `409`).

### 5.5 Topics & summaries (B)

- `PATCH /topics/:id` body `{ label?, keywords? }`. Does not change `status`.
- `POST /topics/:id/approve`, `POST /summaries/:id/approve` — no body; idempotent; set
  `status: "approved"`, `reviewedBy`, `reviewedAt`, clear `rejectionReason`.
- `POST /topics/:id/reject`, `POST /summaries/:id/reject` body
  `{ "rejectionReason": "<enum>", "reviewNote": "..." | null }`.
- `PATCH /summaries/:id` body `{ title?, text?, keyPoints? }`. Does not change `status`.

### 5.6 Search & ask (C)

`POST /search` body:

```json
{ "query": "what happens if the learning rate is too big", "lectureId": "6650c3a0c3b2e41d8a100001", "retriever": "hybrid", "topK": 5 }
```

`lectureId` optional (omitted = every lecture visible to the caller); `retriever` default `hybrid`;
`topK` 1–20, default 5. Response `200 { query, retriever, items: Passage[], tookMs }`.
`score` is higher-is-better and only comparable within one response: `vector` = dot product
(cosine) in [-1, 1]; `keyword` = Mongo `textScore`; `hybrid` = reciprocal-rank fusion
`Σ 1/(60 + rank)` over both lists. `rank` is 1-based.

`POST /ask` body `{ question, lectureId?, retriever? }` (question 3–500 chars). Response `200`
— **abstaining is a normal 200, not an error**:

- `NO_RELEVANT_PASSAGE` — no passage above the relevance threshold; the LLM is not called.
- `LOW_CONFIDENCE` — the model declared it cannot answer from the passages, or every citation
  failed the verbatim-quote check.
- `PARSE_FAILED` — model output was not valid JSON after one retry.
- Provider unreachable is **not** an abstain: it is `503 PROVIDER_UNAVAILABLE`.

When abstained: `answerable: false`, `abstained: true`, `abstainReason` set, `answer: null`,
`citations: []`, `confidence: null`.

Every answer carries `topScore`: the highest retrieval `score` among the passages considered
(same scale as `POST /search` for that retriever), or `null` when no passage was retrieved. It is
shown as grounding evidence, and explains `NO_RELEVANT_PASSAGE` (the top score was under the threshold). When answered: `abstainReason: null` and ≥ 1 citation.
Answer text references citations with `[n]` markers matching `citation.marker`.

`deepLink` (passages, citations, revision items, attempt answers) is **built by the server**:
`/lectures/<lectureId>/play?t=<startSec>` where `t` is the JSON number serialisation of `startSec`
(e.g. `t=612.34`). It is a client route; the player does `video.currentTime = Number(t)`.

### 5.7 Questions, quizzes, attempts, revision (C)

- `POST /lectures/:id/questions/generate` body `{ count?: 1–20 (default 5), topicIds?: string[], difficulty?: enum }`.
  Requires lecture `ready` (else `409`). Returns `201 { items: Question[] }`, all `pending_review`.
- `GET /questions` query `lectureId` (R), `status?`, `topicId?`, `page`, `limit`.
- `PATCH /questions/:id` body any of `{ stem, options, correctOptionId, explanation, difficulty, status, rejectionReason, reviewNote }`.
  `status: "rejected"` requires `rejectionReason`; `status: "approved"` clears it. Setting `status`
  sets `reviewedBy`/`reviewedAt`. Editing content of an approved question resets it to `pending_review`.
- `POST /quizzes` body `{ lectureId, topicIds?: string[], questionCount?: 1–20 (default 10) }`.
  Picks random **approved** questions; if fewer exist than requested, uses all of them; if none,
  `422 { "questionCount": "No approved questions available for this lecture" }`.
- Quiz question **student view**: `{ id, topicId, difficulty, stem, options }` — no
  `correctOptionId`, `explanation`, `evidence` or `status` before submission. The owner sees full
  questions. `GET /quizzes/:id` re-applies the approved filter, so a question un-approved after
  quiz creation disappears from the quiz.
- `quiz` object: `{ id, lectureId, createdBy, title, topicIds, questions, createdAt }`.
- `GET /quizzes` query `lectureId?`, `page`, `limit` → `Paginated<QuizSummary>` of quizzes the caller
  created, newest first. `QuizSummary`:
  `{ id, lectureId, lectureTitle, title, topics: [{ id, label }], questionCount, createdAt,
  attemptCount, bestScore: { correct, total, accuracy } | null, lastAttemptId: id | null, lastAttemptAt: date | null }`.
  `topics` are the approved topics the quiz's (approved) questions cover; `questionCount` re-applies the
  approved filter, matching what `GET /quizzes/:id` returns.
- `POST /quizzes/:id/attempts` body `{ startedAt, answers: [{ questionId, selectedOptionId | null }] }`
  — one answer per quiz question. Returns `201 { attempt }` (scored, with correct answers and
  explanations), then regenerates the student's revision plan.
- `GET /revision-plan` query `lectureId?` → `200 { plan }`, or `200 { plan: null }` if the student
  has no attempts yet.

---

## 6. Example JSON

All examples are taken from or consistent with `mocks/` (lecture `6650c3a0c3b2e41d8a100001`,
"Lecture 7 — Gradient Descent and Backpropagation", `durationSec: 1199.398`).

### 6.1 Lecture summary object (`GET /lectures` item)

```json
{
  "id": "6650c3a0c3b2e41d8a100001",
  "title": "Lecture 7 — Gradient Descent and Backpropagation",
  "courseCode": "CS 3410",
  "description": "Gradient descent, learning rates, SGD and mini-batches, the chain rule, and backpropagation through a two-layer network.",
  "recordedOn": "2026-10-20",
  "status": "ready",
  "statusDetail": "Ready.",
  "error": null,
  "durationSec": 1199.398,
  "transcriptApproved": true,
  "topicCount": 5,
  "uploadedBy": "6650c3a0c3b2e41d8a000001",
  "uploadedByName": "Dr. Ananya Rao",
  "consent": {
    "lecturerConsent": true,
    "purposeShown": true,
    "processorNamed": true,
    "grantedBy": "6650c3a0c3b2e41d8a000001",
    "grantedAt": "2026-10-20T09:14:22.418Z"
  },
  "media": {
    "originalFilename": "cs3410-lec07-gd-backprop.mp4",
    "mimeType": "video/mp4",
    "sizeBytes": 412090368
  },
  "createdAt": "2026-10-20T09:14:22.418Z",
  "updatedAt": "2026-10-21T09:25:40.006Z"
}
```

### 6.2 Processing status (`GET /lectures/:id/status`)

`ms` = elapsed wall-clock milliseconds for that stage (final for `done`/`failed`, so-far for
`running`, `null` for `pending`/`skipped`).

```json
{
  "lectureId": "6650c3a0c3b2e41d8a100004",
  "status": "transcribing",
  "statusDetail": "Transcribing 49.2 minutes of audio with AssemblyAI.",
  "error": null,
  "durationSec": 2954.88,
  "progressPct": 17,
  "stages": [
    { "name": "extracting",   "state": "done",    "ms": 30489 },
    { "name": "transcribing", "state": "running", "ms": 183406 },
    { "name": "chunking",     "state": "pending", "ms": null },
    { "name": "segmenting",   "state": "pending", "ms": null },
    { "name": "summarising",  "state": "pending", "ms": null },
    { "name": "indexing",     "state": "pending", "ms": null }
  ],
  "updatedAt": "2026-10-27T10:03:12.517Z"
}
```

### 6.3 Transcript segment (corrected, low confidence)

```json
{
  "id": "6650c3a0c3b2e41d8a20000e",
  "lectureId": "6650c3a0c3b2e41d8a100001",
  "index": 14,
  "startSec": 386.948,
  "endSec": 412.214,
  "text": "Too small is also a problem, just a quieter one. With eta equal to point zero zero one you'll get there eventually, but it might take thousands of times more steps, and on a non convex surface you're more likely to stall on a plateau where the gradient is nearly zero.",
  "confidence": 0.684,
  "lowConfidence": true,
  "speaker": "A",
  "corrected": true,
  "originalText": "Too small is also a problem, just a quieter one. With either equal to point zero zero one you'll get there eventually, but it might take thousands of times more steps, and on a non convex surface you're more likely to stall on a plateau where the gradient is nearly zero.",
  "correctedBy": "6650c3a0c3b2e41d8a000001",
  "correctedAt": "2026-10-21T08:47:31.112Z",
  "modelVersion": "assemblyai-universal-2"
}
```

### 6.4 Chunk (client serialisation — `embedding` is server-only)

In MongoDB the same document also holds `embedding`: an array of exactly 384 floats with
L2 norm 1. It is never sent to clients.

```json
{
  "id": "6650c3a0c3b2e41d8a300004",
  "lectureId": "6650c3a0c3b2e41d8a100001",
  "index": 4,
  "startSec": 331.403,
  "endSec": 412.214,
  "text": "Now try eta equal to point nine. Each step multiplies w by one minus one point eight, which is negative point eight. So w jumps to negative point eight, then positive point six four, and so on. It still converges, but it oscillates back and forth across the minimum. And with eta equal to one point one, the multiplier is negative one point two. The magnitude grows every step. We overshoot further and further and the loss blows up to infinity. If you ever see your loss turn into NaN in the first few iterations, a learning rate that is too large is the first suspect. Too small is also a problem, just a quieter one. With eta equal to point zero zero one you'll get there eventually, but it might take thousands of times more steps, and on a non convex surface you're more likely to stall on a plateau where the gradient is nearly zero.",
  "segmentStart": 12,
  "segmentEnd": 14,
  "embeddingModel": "Xenova/all-MiniLM-L6-v2"
}
```

### 6.5 Topic section

```json
{
  "id": "6650c3a0c3b2e41d8a400001",
  "lectureId": "6650c3a0c3b2e41d8a100001",
  "index": 1,
  "startSec": 221.199,
  "endSec": 492.332,
  "segmentStart": 8,
  "segmentEnd": 17,
  "label": "Gradient descent and the learning rate",
  "keywords": ["gradient", "update rule", "learning rate", "oscillation", "divergence"],
  "method": "embedding_similarity",
  "boundaryScore": 0.412,
  "status": "approved",
  "rejectionReason": null,
  "reviewedBy": "6650c3a0c3b2e41d8a000001",
  "reviewedAt": "2026-10-21T09:03:11.510Z"
}
```

### 6.6 Section summary with evidence

```json
{
  "id": "6650c3a0c3b2e41d8a500001",
  "lectureId": "6650c3a0c3b2e41d8a100001",
  "topicId": "6650c3a0c3b2e41d8a400001",
  "title": "Gradient descent and the learning rate",
  "text": "Gradient descent repeatedly steps against the gradient: θ ← θ − η∇L(θ). The learning rate η is a hand-chosen hyperparameter. On L(w) = w² starting from w = 1, η = 0.1 converges smoothly, η = 0.9 oscillates but converges, and η = 1.1 diverges; a very small η converges slowly and can stall on plateaus.",
  "keyPoints": [
    "Update rule: θ_new = θ_old − η ∇L(θ_old).",
    "Too large a learning rate overshoots and diverges (loss becomes NaN); too small is slow.",
    "Choose η by sweeping a log scale and keeping the largest value that still decreases the loss steadily."
  ],
  "evidence": [
    {
      "chunkId": "6650c3a0c3b2e41d8a300003",
      "startSec": 249.396,
      "endSec": 274.907,
      "quote": "theta new equals theta old minus eta times the gradient of L evaluated at theta old"
    },
    {
      "chunkId": "6650c3a0c3b2e41d8a300004",
      "startSec": 357.43,
      "endSec": 385.149,
      "quote": "the loss blows up to infinity"
    }
  ],
  "status": "approved",
  "rejectionReason": null,
  "reviewNote": null,
  "faithfulnessScore": 0.667,
  "unsupportedSentences": ["On L(w) = w² starting from w = 1, η = 0.1 converges smoothly, η = 0.9 oscillates but converges, and η = 1.1 diverges; a very small η converges slowly and can stall on plateaus."],
  "reviewedBy": "6650c3a0c3b2e41d8a000001",
  "reviewedAt": "2026-10-21T09:11:41.201Z",
  "model": "llama-3.3-70b-versatile",
  "promptVersion": "summary-v1",
  "createdAt": "2026-10-20T09:29:51.604Z",
  "updatedAt": "2026-10-21T09:11:41.201Z"
}
```

### 6.7 Retrieved passage (`POST /search` item)

```json
{
  "chunkId": "6650c3a0c3b2e41d8a300004",
  "lectureId": "6650c3a0c3b2e41d8a100001",
  "lectureTitle": "Lecture 7 — Gradient Descent and Backpropagation",
  "startSec": 331.403,
  "endSec": 412.214,
  "text": "Now try eta equal to point nine. Each step multiplies w by one minus one point eight, which is negative point eight. … If you ever see your loss turn into NaN in the first few iterations, a learning rate that is too large is the first suspect. …",
  "score": 0.0325,
  "retriever": "hybrid",
  "rank": 1,
  "deepLink": "/lectures/6650c3a0c3b2e41d8a100001/play?t=331.403"
}
```

(`text` is the full chunk text; it is elided with `…` here for space only.)

### 6.8 Grounded answer — answered

```json
{
  "question": "Why does a learning rate that is too large make the loss blow up?",
  "lectureId": "6650c3a0c3b2e41d8a100001",
  "answerable": true,
  "abstained": false,
  "abstainReason": null,
  "answer": "On L(w) = w² each gradient descent step multiplies w by (1 − 2η). With η = 0.1 that factor is 0.8, so w shrinks smoothly toward the minimum [1]. With η = 1.1 the factor is −1.2: every step overshoots the minimum by more than the last, the magnitude grows each iteration and the loss diverges to infinity, which in practice shows up as NaN within the first few iterations [2].",
  "citations": [
    {
      "marker": 1,
      "chunkId": "6650c3a0c3b2e41d8a300003",
      "lectureId": "6650c3a0c3b2e41d8a100001",
      "startSec": 299.059,
      "endSec": 329.254,
      "quote": "With eta equal to point one, each step multiplies w by point eight, so we shrink smoothly toward zero.",
      "deepLink": "/lectures/6650c3a0c3b2e41d8a100001/play?t=299.059"
    },
    {
      "marker": 2,
      "chunkId": "6650c3a0c3b2e41d8a300004",
      "lectureId": "6650c3a0c3b2e41d8a100001",
      "startSec": 357.43,
      "endSec": 385.149,
      "quote": "The magnitude grows every step. We overshoot further and further and the loss blows up to infinity.",
      "deepLink": "/lectures/6650c3a0c3b2e41d8a100001/play?t=357.43"
    }
  ],
  "confidence": 0.86,
  "retriever": "hybrid",
  "topScore": 0.0325,
  "model": "llama-3.3-70b-versatile",
  "promptVersion": "answer-v1",
  "cached": false,
  "latencyMs": 1874
}
```

### 6.9 Grounded answer — abstained (HTTP 200, not an error)

```json
{
  "question": "What values did the lecturer recommend for Adam's beta1 and beta2?",
  "lectureId": "6650c3a0c3b2e41d8a100001",
  "answerable": false,
  "abstained": true,
  "abstainReason": "NO_RELEVANT_PASSAGE",
  "answer": null,
  "citations": [],
  "confidence": null,
  "retriever": "hybrid",
  "topScore": 0.0091,
  "model": "llama-3.3-70b-versatile",
  "promptVersion": "answer-v1",
  "cached": false,
  "latencyMs": 412
}
```

### 6.10 MCQ question (`pending_review`)

```json
{
  "id": "6650c3a0c3b2e41d8a600006",
  "lectureId": "6650c3a0c3b2e41d8a100001",
  "topicId": "6650c3a0c3b2e41d8a400004",
  "type": "mcq",
  "difficulty": "hard",
  "stem": "Why do deep stacks of sigmoid layers suffer from vanishing gradients?",
  "options": [
    { "id": "a", "text": "The sigmoid derivative h(1 − h) is at most 0.25, so multiplying through many layers shrinks the gradient" },
    { "id": "b", "text": "Sigmoid outputs can be negative, which cancels gradients" },
    { "id": "c", "text": "The learning rate is divided by the number of layers" },
    { "id": "d", "text": "Bias gradients are always zero for sigmoid layers" }
  ],
  "correctOptionId": "a",
  "explanation": "Backprop multiplies by h(1 − h) at every sigmoid layer, and that factor is at most 1/4; ten layers multiply the gradient by at most (1/4)¹⁰.",
  "evidence": [
    {
      "chunkId": "6650c3a0c3b2e41d8a30000d",
      "startSec": 1083.141,
      "endSec": 1111.59,
      "quote": "h times one minus h is at most one quarter, at h equals one half"
    }
  ],
  "status": "pending_review",
  "rejectionReason": null,
  "reviewNote": null,
  "reviewedBy": null,
  "reviewedAt": null,
  "model": "llama-3.3-70b-versatile",
  "promptVersion": "mcq-v1",
  "createdAt": "2026-10-20T15:12:08.377Z",
  "updatedAt": "2026-10-20T15:12:08.377Z"
}
```

### 6.11 Quiz attempt with per-topic breakdown (`POST /quizzes/:id/attempts`)

This is the student's 3rd attempt; `mocks/revision.json` is generated from attempts
`…800001`–`…800003`.

```json
{
  "id": "6650c3a0c3b2e41d8a800003",
  "quizId": "6650c3a0c3b2e41d8a700001",
  "lectureId": "6650c3a0c3b2e41d8a100001",
  "studentId": "6650c3a0c3b2e41d8a000002",
  "answers": [
    {
      "questionId": "6650c3a0c3b2e41d8a600000",
      "topicId": "6650c3a0c3b2e41d8a400000",
      "selectedOptionId": "b",
      "correctOptionId": "b",
      "correct": true,
      "explanation": "The lecture says the data is fixed and the loss should be thought of as a function of θ; training searches for the θ with the smallest loss.",
      "deepLink": "/lectures/6650c3a0c3b2e41d8a100001/play?t=66.201"
    },
    {
      "questionId": "6650c3a0c3b2e41d8a600001",
      "topicId": "6650c3a0c3b2e41d8a400001",
      "selectedOptionId": "b",
      "correctOptionId": "b",
      "correct": true,
      "explanation": "The gradient points uphill, so the update subtracts the learning rate times the gradient: θ_new = θ_old − η∇L(θ_old).",
      "deepLink": "/lectures/6650c3a0c3b2e41d8a100001/play?t=249.396"
    },
    {
      "questionId": "6650c3a0c3b2e41d8a600002",
      "topicId": "6650c3a0c3b2e41d8a400001",
      "selectedOptionId": "c",
      "correctOptionId": "d",
      "correct": false,
      "explanation": "Each step multiplies w by (1 − 2η). For η = 1.1 the multiplier is −1.2, whose magnitude exceeds 1, so |w| grows every step and the loss blows up.",
      "deepLink": "/lectures/6650c3a0c3b2e41d8a100001/play?t=357.43"
    },
    {
      "questionId": "6650c3a0c3b2e41d8a600003",
      "topicId": "6650c3a0c3b2e41d8a400002",
      "selectedOptionId": "c",
      "correctOptionId": "b",
      "correct": false,
      "explanation": "One iteration processes one mini-batch and one epoch is a full pass over the data, so 50,000 / 100 = 500 iterations.",
      "deepLink": "/lectures/6650c3a0c3b2e41d8a100001/play?t=568.51"
    },
    {
      "questionId": "6650c3a0c3b2e41d8a600005",
      "topicId": "6650c3a0c3b2e41d8a400003",
      "selectedOptionId": "a",
      "correctOptionId": "a",
      "correct": true,
      "explanation": "With q = x + y, ∂f/∂q = z = −4 and ∂q/∂x = 1, so by the chain rule ∂f/∂x = −4 × 1 = −4.",
      "deepLink": "/lectures/6650c3a0c3b2e41d8a100001/play?t=780.301"
    }
  ],
  "score": { "correct": 3, "total": 5, "accuracy": 0.6 },
  "perTopic": [
    { "topicId": "6650c3a0c3b2e41d8a400000", "topicLabel": "Recap: training as minimising a loss over parameters", "correct": 1, "total": 1, "accuracy": 1 },
    { "topicId": "6650c3a0c3b2e41d8a400001", "topicLabel": "Gradient descent and the learning rate", "correct": 1, "total": 2, "accuracy": 0.5 },
    { "topicId": "6650c3a0c3b2e41d8a400002", "topicLabel": "Stochastic and mini-batch gradient descent", "correct": 0, "total": 1, "accuracy": 0 },
    { "topicId": "6650c3a0c3b2e41d8a400003", "topicLabel": "Chain rule and computational graphs", "correct": 1, "total": 1, "accuracy": 1 }
  ],
  "startedAt": "2026-10-26T18:31:02.118Z",
  "submittedAt": "2026-10-26T18:39:27.031Z",
  "timeTakenSec": 504.913
}
```

### 6.12 Revision recommendation item

```json
{
  "rank": 1,
  "lectureId": "6650c3a0c3b2e41d8a100001",
  "topicId": "6650c3a0c3b2e41d8a400002",
  "topicLabel": "Stochastic and mini-batch gradient descent",
  "startSec": 492.332,
  "endSec": 699.039,
  "deepLink": "/lectures/6650c3a0c3b2e41d8a100001/play?t=492.332",
  "correct": 1,
  "attempted": 3,
  "accuracy": 0.333,
  "reason": "Across your 3 quiz attempts you got 1 of 3 answers on stochastic and mini-batch gradient descent right (33%), including a miss on your latest attempt on 26 Oct — your weakest topic, against 60% (9 of 15) for the lecture overall. Rewatch the 3.4-minute section on epochs and iterations."
}
```

---

## 7. Placeholder behaviour

- Every route in §5.1 is mounted from day one by Member D in `server/src/routes/index.ts`.
- Until its owner implements it, a route returns **`501 NOT_IMPLEMENTED`** in the standard envelope:

  ```json
  {
    "error": {
      "code": "NOT_IMPLEMENTED",
      "message": "Grounded Q&A is not yet implemented (owner: Member C).",
      "details": { "owner": "C", "prompt": "PC.2" },
      "requestId": "req_Q1v9x"
    }
  }
  ```

  `message` is exactly `"<Feature> is not yet implemented (owner: Member <X>)."`; `details.owner` is
  the owner letter from §5.1; `details.prompt` is the playbook prompt id that implements it (`PA.1`
  transcript; `PB.1` topics, `PB.2` summaries; `PC.1` search, `PC.2` ask, `PC.3` questions, quizzes,
  attempts and revision).
- Stubs are mounted with their **real** guards and validation (`server/src/modules/<name>/routes.ts`),
  so a request is authenticated, role-checked and validated (`401`/`403`/`404`/`422`) before the
  `501`. Owners replace the handler body only.
- The processing pipeline (`server/src/services/processing/pipeline.ts`; interface by D) runs every
  stage in §2 order: `extracting` and `transcribing` (A), `chunking`, `segmenting` and `summarising`
  (B). Until Member C provides embeddings, segmenting uses `fixed_window` and the `indexing` stage is
  **skipped**: the lecture becomes `ready` with `statusDetail` saying search indexing is not available
  yet, so nothing is faked. Failures set `failed` with a §4.2 `error.code`: `NO_AUDIO_STREAM`,
  `UNSUPPORTED_CODEC`, `PROVIDER_UNAVAILABLE` (both ASR providers failed or none configured),
  `TRANSCRIPTION_FAILED` (provider output unusable), `INTERNAL_ERROR`.
- **Returning fabricated success data from a server route is forbidden** — no hard-coded
  lectures, no canned answers, no `200` with empty placeholder objects. The client handles
  `501` by showing a "coming soon" state. Fixtures in `mocks/` are for client development and
  tests only and are never served by the API.

---

## 8. Fixture map (`mocks/`)

All fixtures share the same ids: lecture 1 = `6650c3a0c3b2e41d8a100001`, teacher
`…000001`, student `…000002`, segments `…2000xx`, chunks `…3000xx`, topics `…40000x`,
summaries `…50000x`, questions `…60000x`, quiz `…700001`, attempts `…80000x`, plan `…900001`.

| File | Response body of | Contents |
| --- | --- | --- |
| `lectures.json` | `GET /lectures` (teacher) | 6 lectures: 3 `ready`, 1 `transcribing`, 1 `uploaded`, 1 `failed` |
| `transcript.json` | `GET /lectures/:id/transcript` | 45 segments, 0–1199.398 s; 4 `lowConfidence`; segment 14 corrected |
| `chunks.json` | (internal; referenced by evidence) | 15 chunks of 3 segments, client serialisation |
| `topics.json` | `GET /lectures/:id/topics` (teacher) | 5 sections tiling `[0, 1199.398)`; 4 approved, 1 pending |
| `summaries.json` | `GET /lectures/:id/summaries` (teacher) | 5 summaries, 2 evidence each; 3 approved, 2 pending |
| `answer.json` | `POST /ask` | `{ answered, abstained }` — two response bodies |
| `questions.json` | `GET /questions?lectureId=…` | 8 MCQs; 5 approved, 2 pending, 1 rejected (`FACTUALLY_WRONG`) |
| `revision.json` | `GET /revision-plan` → `plan` | 3 ranked items with real percentages |

Student views are derived by keeping only `status: "approved"` items (and stripping answer
keys from quiz questions, §5.7).

---

## 9. Demo accounts

Seeded accounts for development and the project demo, all with the fixture ids from §8 so seeded
data lines up with `mocks/`. The server's seed script (`npm run seed --workspace server`, owner D)
creates all three. The client's mock auth adapter and the login page's demo block serve the first
two; the second student exists only in a seeded database (it owns the second seeded quiz attempt).

| Role | id | Name | Email | Password |
| --- | --- | --- | --- | --- |
| teacher | `6650c3a0c3b2e41d8a000001` | Dr. Ananya Rao | `teacher@lecturelens.dev` | `lecturelens` |
| student | `6650c3a0c3b2e41d8a000002` | Rohan Mehta | `student@lecturelens.dev` | `lecturelens` |
| student | `6650c3a0c3b2e41d8a000003` | Meera Iyer | `student2@lecturelens.dev` | `lecturelens` |

- These are **demo credentials, not secrets**. They must never exist in a production database:
  the seed script refuses to run when `NODE_ENV=production`.
- The login page shows a plainly labelled "Demo accounts" block when the `auth` domain is mocked or
  `VITE_SHOW_DEMO_ACCOUNTS=true`.
