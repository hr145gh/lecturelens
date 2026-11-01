# LectureLens API reference

Generated from `server/src/routes/index.ts` and the module routers under `server/src/modules/`
(no route here that is not mounted there). Field-level rules and invariants live in
[`docs/CONTRACTS.md`](CONTRACTS.md), which wins if the two ever disagree. Examples are taken from
`mocks/*.json`; where no fixture exists the matching CONTRACTS.md §6 example is used and says so.

- **Base URL:** `http://localhost:5000/api/v1`
- **Auth:** `Authorization: Bearer <jwt>` from `/auth/login` or `/auth/register`, on every route
  except `/health`, `/auth/register`, `/auth/login` and the signed media URL. Roles and ownership:
  the RBAC matrix, CONTRACTS.md §1.6 (another teacher's lecture is `404`, a student on a teacher route `403`).
- **Errors:** every non-2xx is `{ "error": { "code", "message", "details", "requestId" } }` (CONTRACTS.md §3);
  every response carries `X-Request-Id`. A malformed path id is `404`; there is no `400`.
  Any route can also answer `500 INTERNAL_ERROR`.
- **Stubs:** `501 NOT_IMPLEMENTED` routes already run their real auth, role and validation checks;
  `details` names the owner and the prompt that implements them (CONTRACTS.md §7).

## Endpoints

| Method | Path | Owner | Auth / role | Status |
| --- | --- | --- | --- | --- |
| GET | [`/health`](#get-health) | D | public | Implemented |
| POST | [`/auth/register`](#post-auth-register) | D | public · rate-limited 10 / 15 min / IP | Implemented |
| POST | [`/auth/login`](#post-auth-login) | D | public · 10 failed attempts / 15 min / IP | Implemented |
| GET | [`/auth/me`](#get-auth-me) | D | any signed-in user | Implemented |
| GET | [`/users/me`](#get-users-me) | D | any signed-in user | Implemented |
| PATCH | [`/users/me`](#patch-users-me) | D | any signed-in user | Implemented |
| POST | [`/lectures`](#post-lectures) | D | teacher | Implemented |
| GET | [`/lectures`](#get-lectures) | D | any signed-in user | Implemented |
| GET | [`/lectures/:id`](#get-lectures-id) | D | owner, or a student if ready + transcript approved | Implemented |
| GET | [`/lectures/:id/media`](#get-lectures-id-media) | D | signed URL (`exp`, `sig` from GET /lectures/:id), no Bearer token | Implemented |
| GET | [`/lectures/:id/status`](#get-lectures-id-status) | D | owner (teacher) | Implemented |
| POST | [`/lectures/:id/reprocess`](#post-lectures-id-reprocess) | D | owner (teacher) | Implemented |
| DELETE | [`/lectures/:id`](#delete-lectures-id) | D | owner (teacher) | Implemented |
| GET | [`/lectures/:id/transcript`](#get-lectures-id-transcript) | A | owner, or a student if transcript approved | Implemented (PA.1) |
| PATCH | [`/lectures/:id/segments/:index`](#patch-lectures-id-segments-index) | A | owner (teacher) | Implemented (PA.1) |
| POST | [`/lectures/:id/transcript/approve`](#post-lectures-id-transcript-approve) | A | owner (teacher) | Implemented (PA.1) |
| GET | [`/lectures/:id/topics`](#get-lectures-id-topics) | B | owner, or a student (approved only) | Implemented (PB.1) |
| PATCH | [`/topics/:id`](#patch-topics-id) | B | owner (teacher) | Implemented (PB.1) |
| POST | [`/topics/:id/approve`](#post-topics-id-approve) | B | owner (teacher) | Implemented (PB.1) |
| POST | [`/topics/:id/reject`](#post-topics-id-reject) | B | owner (teacher) | Stub (501) — PB.1 |
| GET | [`/lectures/:id/summaries`](#get-lectures-id-summaries) | B | owner, or a student (approved only) | Implemented (PB.2) |
| PATCH | [`/summaries/:id`](#patch-summaries-id) | B | owner (teacher) | Stub (501) — PB.2 |
| POST | [`/summaries/:id/approve`](#post-summaries-id-approve) | B | owner (teacher) | Implemented (PB.2) |
| POST | [`/summaries/:id/reject`](#post-summaries-id-reject) | B | owner (teacher) | Stub (501) — PB.2 |
| POST | [`/search`](#post-search) | C | any signed-in user | Stub (501) — PC.1 |
| POST | [`/ask`](#post-ask) | C | any signed-in user | Stub (501) — PC.2 |
| POST | [`/lectures/:id/questions/generate`](#post-lectures-id-questions-generate) | C | owner (teacher) | Stub (501) — PC.3 |
| GET | [`/questions`](#get-questions) | C | teacher (own lectures) | Stub (501) — PC.3 |
| PATCH | [`/questions/:id`](#patch-questions-id) | C | owner (teacher) | Stub (501) — PC.3 |
| POST | [`/quizzes`](#post-quizzes) | C | any signed-in user | Stub (501) — PC.3 |
| GET | [`/quizzes`](#get-quizzes) | C | any signed-in user (own quizzes) | Stub (501) — PC.3 |
| GET | [`/quizzes/:id`](#get-quizzes-id) | C | quiz creator, or the lecture's owner | Stub (501) — PC.3 |
| POST | [`/quizzes/:id/attempts`](#post-quizzes-id-attempts) | C | any signed-in user | Stub (501) — PC.3 |
| GET | [`/attempts/:id`](#get-attempts-id) | C | the attempt's own user only | Stub (501) — PC.3 |
| GET | [`/revision-plan`](#get-revision-plan) | C | any signed-in user (own plan) | Stub (501) — PC.3 |

## D — Infrastructure, auth, users, lectures

<a id="get-health"></a>
### GET `/health`

**Owner** D · **Auth** public · **Status** Implemented

**Request:** No body.

**Success — 200**

```json
{
  "status": "ok",
  "uptimeSec": 812.441,
  "db": "connected",
  "version": "0.0.0",
  "timestamp": "2026-10-28T14:07:56.900Z"
}
```

`db` is `"connected"` or `"not_connected"`.

**Errors:** none specific.

<a id="post-auth-register"></a>
### POST `/auth/register`

**Owner** D · **Auth** public · rate-limited 10 / 15 min / IP · **Status** Implemented

**Request:** JSON `{ name, email, password, role }` — name 2–80; email valid (lower-cased); password 8–128 with a letter and a digit; role `student` | `teacher`.

**Success — 201**

```json
{
  "user": {
    "id": "6650c3a0c3b2e41d8a000001",
    "email": "teacher@lecturelens.dev",
    "name": "Dr. Ananya Rao",
    "role": "teacher",
    "lastLoginAt": "2026-09-01T08:00:00.000Z",
    "createdAt": "2026-09-01T08:00:00.000Z",
    "updatedAt": "2026-09-01T08:00:00.000Z"
  },
  "token": "eyJhbGciOiJIUzI1NiIs… (JWT, shortened)"
}
```

**Errors:** 409 CONFLICT (email exists, any case); 422 VALIDATION_FAILED (field map); 429 RATE_LIMITED.

<a id="post-auth-login"></a>
### POST `/auth/login`

**Owner** D · **Auth** public · 10 failed attempts / 15 min / IP (successful sign-ins never count) · **Status** Implemented

**Request:** JSON `{ email, password }`.

**Success — 200**

```json
{
  "user": {
    "id": "6650c3a0c3b2e41d8a000001",
    "email": "teacher@lecturelens.dev",
    "name": "Dr. Ananya Rao",
    "role": "teacher",
    "lastLoginAt": "2026-10-28T13:56:46.675Z",
    "createdAt": "2026-09-01T08:00:00.000Z",
    "updatedAt": "2026-10-28T13:56:46.675Z"
  },
  "token": "eyJhbGciOiJIUzI1NiIs… (JWT, shortened)"
}
```

JWT claims are only `{ sub, role, iat, exp }` (HS256).

**Errors:** 401 UNAUTHENTICATED — always "Invalid email or password" (never says which); 422 VALIDATION_FAILED; 429 RATE_LIMITED.

<a id="get-auth-me"></a>
### GET `/auth/me`

**Owner** D · **Auth** any signed-in user · **Status** Implemented

**Request:** No body.

**Success — 200**

```json
{
  "user": {
    "id": "6650c3a0c3b2e41d8a000001",
    "email": "teacher@lecturelens.dev",
    "name": "Dr. Ananya Rao",
    "role": "teacher",
    "lastLoginAt": "2026-10-28T13:56:46.675Z",
    "createdAt": "2026-09-01T08:00:00.000Z",
    "updatedAt": "2026-10-28T13:56:46.675Z"
  }
}
```

**Errors:** 401 UNAUTHENTICATED (no/invalid/expired token; `details.reason: "expired"` when expired).

<a id="get-users-me"></a>
### GET `/users/me`

**Owner** D · **Auth** any signed-in user · **Status** Implemented

**Request:** No body.

**Success — 200**

```json
{
  "user": {
    "id": "6650c3a0c3b2e41d8a000001",
    "email": "teacher@lecturelens.dev",
    "name": "Dr. Ananya Rao",
    "role": "teacher",
    "lastLoginAt": "2026-10-28T13:56:46.675Z",
    "createdAt": "2026-09-01T08:00:00.000Z",
    "updatedAt": "2026-10-28T13:56:46.675Z"
  }
}
```

**Errors:** 401 UNAUTHENTICATED (no/invalid/expired token; `details.reason: "expired"` when expired).

<a id="patch-users-me"></a>
### PATCH `/users/me`

**Owner** D · **Auth** any signed-in user · **Status** Implemented

**Request:** JSON `{ name }` (2–80). Any other field → 422 `{ "body": "Only \"name\" can be changed" }`.

**Success — 200**

```json
{
  "user": {
    "id": "6650c3a0c3b2e41d8a000001",
    "email": "teacher@lecturelens.dev",
    "name": "Dr. A. Rao",
    "role": "teacher",
    "lastLoginAt": "2026-10-28T13:56:46.675Z",
    "createdAt": "2026-09-01T08:00:00.000Z",
    "updatedAt": "2026-10-28T13:56:46.675Z"
  }
}
```

**Errors:** 401 UNAUTHENTICATED (no/invalid/expired token; `details.reason: "expired"` when expired); 422 VALIDATION_FAILED.

<a id="post-lectures"></a>
### POST `/lectures`

**Owner** D · **Auth** teacher · **Status** Implemented

**Request:** `multipart/form-data`: `file` (.mp4 .mkv .mov .webm .mp3 .wav .m4a, ≤ MAX_UPLOAD_MB), `title` (1–200), optional `courseCode`, `description`, `recordedOn` (YYYY-MM-DD, not future), `notes`; consent `lecturerConsent`, `purposeShown`, `processorNamed` — each must be `"true"`.

**Success — 202**

```json
{
  "lecture": {
    "id": "6650c3a0c3b2e41d8a100005",
    "title": "Lecture 10 — Convolutional Neural Networks",
    "courseCode": "CS 3410",
    "description": "Convolution, padding and stride, pooling, and parameter sharing.",
    "recordedOn": "2026-10-27",
    "status": "uploaded",
    "statusDetail": "Upload received; waiting to start audio extraction.",
    "error": null,
    "durationSec": null,
    "transcriptApproved": false,
    "topicCount": null,
    "uploadedBy": "6650c3a0c3b2e41d8a000001",
    "uploadedByName": "Dr. Ananya Rao",
    "consent": {
      "lecturerConsent": true,
      "purposeShown": true,
      "processorNamed": true,
      "grantedBy": "6650c3a0c3b2e41d8a000001",
      "grantedAt": "2026-10-27T10:21:07.226Z"
    },
    "media": {
      "originalFilename": "cs3410-lec10-cnns.mp4",
      "mimeType": "video/mp4",
      "sizeBytes": 912384512
    },
    "createdAt": "2026-10-27T10:21:07.226Z",
    "updatedAt": "2026-10-27T10:21:07.226Z"
  }
}
```

Processing starts in the background: extracting → transcribing → chunking → segmenting → summarising (`indexing` is skipped until Member C's embeddings exist; the lecture then becomes `ready` with a `statusDetail` saying search is not available yet). Poll `GET /lectures/:id/status`. Failures set `failed` with a §4.2 `error.code`.

**Errors:** 401 UNAUTHENTICATED (no/invalid/expired token; `details.reason: "expired"` when expired); 403 FORBIDDEN (student); 413 PAYLOAD_TOO_LARGE `{ maxMb }`; 415 UNSUPPORTED_MEDIA_TYPE `{ mimeType }` (extension, declared type or magic bytes); 422 VALIDATION_FAILED (e.g. `consent.lecturerConsent`, `file`) — the stored file is deleted.

<a id="get-lectures"></a>
### GET `/lectures`

**Owner** D · **Auth** any signed-in user · **Status** Implemented

**Request:** Query `page` (≥1, default 1), `limit` (1–100, default 20), `status?`, `q?` (title search). Teachers see their own; students only `ready` + `transcriptApproved`.

**Success — 200**

```json
{
  "items": [
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
  ],
  "page": 1,
  "limit": 20,
  "total": 6
}
```

`items` shortened to one lecture; the fixture has six.

**Errors:** 401 UNAUTHENTICATED (no/invalid/expired token; `details.reason: "expired"` when expired); 422 VALIDATION_FAILED (out-of-range paging).

<a id="get-lectures-id"></a>
### GET `/lectures/:id`

**Owner** D · **Auth** owner, or a student if ready + transcript approved · **Status** Implemented

**Request:** No body.

**Success — 200**

```json
{
  "lecture": {
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
  },
  "mediaUrl": "/api/v1/lectures/6650c3a0c3b2e41d8a100001/media?exp=1793217600&sig=3f1c…(64 hex)"
}
```

**Errors:** 401 UNAUTHENTICATED (no/invalid/expired token; `details.reason: "expired"` when expired); 404 NOT_FOUND (unknown, malformed, or not visible — never 403).

<a id="get-lectures-id-media"></a>
### GET `/lectures/:id/media`

**Owner** D · **Auth** signed URL (`exp`, `sig` from GET /lectures/:id), no Bearer token · **Status** Implemented

**Request:** Query `exp`, `sig`. Optional `Range: bytes=a-b`.

**Success — 200 / 206**

The media bytes (`Content-Type` from the upload; `206` with `Content-Range` for a range).

**Errors:** 401 UNAUTHENTICATED (missing, invalid or expired signature); 404 NOT_FOUND (lecture or file missing).

<a id="get-lectures-id-status"></a>
### GET `/lectures/:id/status`

**Owner** D · **Auth** owner (teacher) · **Status** Implemented

**Request:** No body.

**Success — 200**

```json
{
  "lectureId": "6650c3a0c3b2e41d8a100004",
  "status": "transcribing",
  "statusDetail": "Transcribing 49.2 minutes of audio with AssemblyAI.",
  "error": null,
  "durationSec": 2954.88,
  "progressPct": 17,
  "stages": [
    {
      "name": "extracting",
      "state": "done",
      "ms": 30489
    },
    {
      "name": "transcribing",
      "state": "running",
      "ms": 183406
    },
    {
      "name": "chunking",
      "state": "pending",
      "ms": null
    },
    {
      "name": "segmenting",
      "state": "pending",
      "ms": null
    },
    {
      "name": "summarising",
      "state": "pending",
      "ms": null
    },
    {
      "name": "indexing",
      "state": "pending",
      "ms": null
    }
  ],
  "updatedAt": "2026-10-27T10:03:12.517Z"
}
```

Example from CONTRACTS.md §6.2 (no fixture exists for status).

**Errors:** 401 UNAUTHENTICATED (no/invalid/expired token; `details.reason: "expired"` when expired); 403 FORBIDDEN (student); 404 NOT_FOUND (another teacher's lecture).

<a id="post-lectures-id-reprocess"></a>
### POST `/lectures/:id/reprocess`

**Owner** D · **Auth** owner (teacher) · **Status** Implemented

**Request:** JSON `{ fromStage? }` or `?fromStage=` — a stage name, default `extracting`.

**Success — 202**

```json
{
  "lecture": {
    "id": "6650c3a0c3b2e41d8a100001",
    "title": "Lecture 7 — Gradient Descent and Backpropagation",
    "courseCode": "CS 3410",
    "description": "Gradient descent, learning rates, SGD and mini-batches, the chain rule, and backpropagation through a two-layer network.",
    "recordedOn": "2026-10-20",
    "status": "transcribing",
    "statusDetail": "Reprocessing from transcription.",
    "error": null,
    "durationSec": 1199.398,
    "transcriptApproved": false,
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
}
```

Idempotent: repeating the same restart while it is queued returns 202 and starts nothing new.

**Errors:** 401 UNAUTHENTICATED (no/invalid/expired token; `details.reason: "expired"` when expired); 403 FORBIDDEN (student); 404 NOT_FOUND; 409 CONFLICT `{ status }` (still processing, or a stage after the failing one); 422 VALIDATION_FAILED (unknown stage).

<a id="delete-lectures-id"></a>
### DELETE `/lectures/:id`

**Owner** D · **Auth** owner (teacher) · **Status** Implemented

**Request:** No body.

**Success — 204**

No body. Derived documents and `STORAGE_DIR/<id>/` are removed.

**Errors:** 401 UNAUTHENTICATED (no/invalid/expired token; `details.reason: "expired"` when expired); 403 FORBIDDEN (student); 404 NOT_FOUND; 500 INTERNAL_ERROR (a derived collection failed; lecture kept for retry).

## A — Transcript

<a id="get-lectures-id-transcript"></a>
### GET `/lectures/:id/transcript`

**Owner** A · **Auth** owner, or a student if transcript approved · **Status** Implemented (PA.1)

**Request:** No body.

**Success — 200**

```json
{
  "lectureId": "6650c3a0c3b2e41d8a100001",
  "transcriptApproved": true,
  "items": [
    {
      "id": "6650c3a0c3b2e41d8a200000",
      "lectureId": "6650c3a0c3b2e41d8a100001",
      "index": 0,
      "startSec": 2.416,
      "endSec": 32.201,
      "text": "Okay, let's get started. Can everyone at the back hear me? Good. So last week we finished linear regression, and I left you with a question: we wrote down a loss function, the mean squared error, but we never actually said how a computer finds the weights that make that loss small. Today is all about answering that.",
      "confidence": 0.934,
      "lowConfidence": false,
      "speaker": "A",
      "corrected": false,
      "originalText": null,
      "correctedBy": null,
      "correctedAt": null,
      "modelVersion": "assemblyai-universal-2"
    },
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
  ]
}
```

`items` shortened to two of 45 segments.

**Errors:** 401 UNAUTHENTICATED (no/invalid/expired token; `details.reason: "expired"` when expired); 403 FORBIDDEN `{ reason: "TRANSCRIPT_NOT_APPROVED" }`; 404 NOT_FOUND.

<a id="patch-lectures-id-segments-index"></a>
### PATCH `/lectures/:id/segments/:index`

**Owner** A · **Auth** owner (teacher) · **Status** Implemented (PA.1)

**Request:** JSON `{ text }` (1–2000). Timing is not editable.

**Success — 200**

```json
{
  "segment": {
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
}
```

**Errors:** 401 UNAUTHENTICATED (no/invalid/expired token; `details.reason: "expired"` when expired); 403 FORBIDDEN; 404 NOT_FOUND; 422 VALIDATION_FAILED.

<a id="post-lectures-id-transcript-approve"></a>
### POST `/lectures/:id/transcript/approve`

**Owner** A · **Auth** owner (teacher) · **Status** Implemented (PA.1)

**Request:** No body.

**Success — 200**

```json
{
  "lecture": {
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
}
```

**Errors:** 401 UNAUTHENTICATED (no/invalid/expired token; `details.reason: "expired"` when expired); 403 FORBIDDEN; 404 NOT_FOUND; 409 CONFLICT (not ready).

## B — Topics and summaries

<a id="get-lectures-id-topics"></a>
### GET `/lectures/:id/topics`

**Owner** B · **Auth** owner, or a student (approved only) · **Status** Implemented (PB.1)

**Request:** No body.

**Success — 200**

```json
{
  "lectureId": "6650c3a0c3b2e41d8a100001",
  "items": [
    {
      "id": "6650c3a0c3b2e41d8a400000",
      "lectureId": "6650c3a0c3b2e41d8a100001",
      "index": 0,
      "startSec": 0,
      "endSec": 221.199,
      "segmentStart": 0,
      "segmentEnd": 7,
      "label": "Recap: training as minimising a loss over parameters",
      "keywords": [
        "loss function",
        "mean squared error",
        "parameters",
        "normal equations",
        "loss landscape"
      ],
      "method": "embedding_similarity",
      "boundaryScore": null,
      "status": "approved",
      "rejectionReason": null,
      "reviewedBy": "6650c3a0c3b2e41d8a000001",
      "reviewedAt": "2026-10-21T09:02:10.500Z"
    }
  ]
}
```

`items` shortened to one of five.

**Errors:** 401 UNAUTHENTICATED (no/invalid/expired token; `details.reason: "expired"` when expired); 404 NOT_FOUND.

<a id="patch-topics-id"></a>
### PATCH `/topics/:id`

**Owner** B · **Auth** owner (teacher) · **Status** Implemented (PB.1)

**Request:** JSON `{ label?, keywords? }` (label ≤ 80; 3–8 keywords).

**Success — 200**

```json
{
  "topic": {
    "id": "6650c3a0c3b2e41d8a400000",
    "lectureId": "6650c3a0c3b2e41d8a100001",
    "index": 0,
    "startSec": 0,
    "endSec": 221.199,
    "segmentStart": 0,
    "segmentEnd": 7,
    "label": "Recap: training as minimising a loss over parameters",
    "keywords": [
      "loss function",
      "mean squared error",
      "parameters",
      "normal equations",
      "loss landscape"
    ],
    "method": "embedding_similarity",
    "boundaryScore": null,
    "status": "approved",
    "rejectionReason": null,
    "reviewedBy": "6650c3a0c3b2e41d8a000001",
    "reviewedAt": "2026-10-21T09:02:10.500Z"
  }
}
```

**Errors:** 401 UNAUTHENTICATED (no/invalid/expired token; `details.reason: "expired"` when expired); 403 FORBIDDEN (student); 404 NOT_FOUND; 422 VALIDATION_FAILED.

<a id="post-topics-id-approve"></a>
### POST `/topics/:id/approve`

**Owner** B · **Auth** owner (teacher) · **Status** Implemented (PB.1)

**Request:** No body.

**Success — 200**

```json
{
  "topic": {
    "id": "6650c3a0c3b2e41d8a400000",
    "lectureId": "6650c3a0c3b2e41d8a100001",
    "index": 0,
    "startSec": 0,
    "endSec": 221.199,
    "segmentStart": 0,
    "segmentEnd": 7,
    "label": "Recap: training as minimising a loss over parameters",
    "keywords": [
      "loss function",
      "mean squared error",
      "parameters",
      "normal equations",
      "loss landscape"
    ],
    "method": "embedding_similarity",
    "boundaryScore": null,
    "status": "approved",
    "rejectionReason": null,
    "reviewedBy": "6650c3a0c3b2e41d8a000001",
    "reviewedAt": "2026-10-21T09:02:10.500Z"
  }
}
```

**Errors:** 401 UNAUTHENTICATED (no/invalid/expired token; `details.reason: "expired"` when expired); 403 FORBIDDEN (student); 404 NOT_FOUND; 422 VALIDATION_FAILED.

<a id="post-topics-id-reject"></a>
### POST `/topics/:id/reject`

**Owner** B · **Auth** owner (teacher) · **Status** Stub (501) — PB.1

**Request:** JSON `{ rejectionReason, reviewNote? }`.

**Success — 200**

```json
{
  "topic": {
    "id": "6650c3a0c3b2e41d8a400004",
    "lectureId": "6650c3a0c3b2e41d8a100001",
    "index": 4,
    "startSec": 965.174,
    "endSec": 1199.398,
    "segmentStart": 36,
    "segmentEnd": 44,
    "label": "Backpropagation through a two-layer network",
    "keywords": [
      "backpropagation",
      "sigmoid",
      "vanishing gradients",
      "delta",
      "gradient checking"
    ],
    "method": "embedding_similarity",
    "boundaryScore": 0.291,
    "status": "rejected",
    "rejectionReason": "AMBIGUOUS",
    "reviewedBy": null,
    "reviewedAt": null
  }
}
```

**Errors:** 401 UNAUTHENTICATED (no/invalid/expired token; `details.reason: "expired"` when expired); 403 FORBIDDEN (student); 404 NOT_FOUND; 422 VALIDATION_FAILED; 501 NOT_IMPLEMENTED.

<a id="get-lectures-id-summaries"></a>
### GET `/lectures/:id/summaries`

**Owner** B · **Auth** owner, or a student (approved only) · **Status** Implemented (PB.2)

**Request:** No body.

**Success — 200**

```json
{
  "lectureId": "6650c3a0c3b2e41d8a100001",
  "items": [
    {
      "id": "6650c3a0c3b2e41d8a500000",
      "lectureId": "6650c3a0c3b2e41d8a100001",
      "topicId": "6650c3a0c3b2e41d8a400000",
      "title": "Recap: training as minimising a loss over parameters",
      "text": "Training is reframed as minimising the loss L(θ) as a function of the parameters θ, with the data held fixed. Linear regression admits a closed-form solution via the normal equations, but its O(d³) cost and the absence of any closed form for neural networks motivate an iterative method that walks downhill on the loss landscape.",
      "keyPoints": [
        "The loss is treated as a function of the parameters, not the data.",
        "Closed-form least squares needs a d×d matrix inverse (about d³ work) and does not exist for neural networks.",
        "Linear-regression loss is a convex bowl; neural-network losses have local minima, plateaus and saddle points."
      ],
      "evidence": [
        {
          "chunkId": "6650c3a0c3b2e41d8a300000",
          "startSec": 66.201,
          "endSec": 95.359,
          "quote": "Think of it as a function of theta."
        },
        {
          "chunkId": "6650c3a0c3b2e41d8a300001",
          "startSec": 97.723,
          "endSec": 126.77,
          "quote": "for a neural network there is no closed form at all"
        }
      ],
      "status": "approved",
      "rejectionReason": null,
      "reviewNote": null,
      "faithfulnessScore": 1,
      "unsupportedSentences": [],
      "reviewedBy": "6650c3a0c3b2e41d8a000001",
      "reviewedAt": "2026-10-21T09:10:40.200Z",
      "model": "llama-3.3-70b-versatile",
      "promptVersion": "summary-v1",
      "createdAt": "2026-10-20T09:29:51.604Z",
      "updatedAt": "2026-10-21T09:10:40.200Z"
    }
  ]
}
```

`items` shortened to one of five.

**Errors:** 401 UNAUTHENTICATED (no/invalid/expired token; `details.reason: "expired"` when expired); 404 NOT_FOUND.

<a id="patch-summaries-id"></a>
### PATCH `/summaries/:id`

**Owner** B · **Auth** owner (teacher) · **Status** Stub (501) — PB.2

**Request:** JSON `{ title?, text?, keyPoints? }` (2–5 key points).

**Success — 200**

```json
{
  "summary": {
    "id": "6650c3a0c3b2e41d8a500000",
    "lectureId": "6650c3a0c3b2e41d8a100001",
    "topicId": "6650c3a0c3b2e41d8a400000",
    "title": "Recap: training as minimising a loss over parameters",
    "text": "Training is reframed as minimising the loss L(θ) as a function of the parameters θ, with the data held fixed. Linear regression admits a closed-form solution via the normal equations, but its O(d³) cost and the absence of any closed form for neural networks motivate an iterative method that walks downhill on the loss landscape.",
    "keyPoints": [
      "The loss is treated as a function of the parameters, not the data.",
      "Closed-form least squares needs a d×d matrix inverse (about d³ work) and does not exist for neural networks.",
      "Linear-regression loss is a convex bowl; neural-network losses have local minima, plateaus and saddle points."
    ],
    "evidence": [
      {
        "chunkId": "6650c3a0c3b2e41d8a300000",
        "startSec": 66.201,
        "endSec": 95.359,
        "quote": "Think of it as a function of theta."
      },
      {
        "chunkId": "6650c3a0c3b2e41d8a300001",
        "startSec": 97.723,
        "endSec": 126.77,
        "quote": "for a neural network there is no closed form at all"
      }
    ],
    "status": "approved",
    "rejectionReason": null,
    "reviewNote": null,
    "faithfulnessScore": 1,
    "unsupportedSentences": [],
    "reviewedBy": "6650c3a0c3b2e41d8a000001",
    "reviewedAt": "2026-10-21T09:10:40.200Z",
    "model": "llama-3.3-70b-versatile",
    "promptVersion": "summary-v1",
    "createdAt": "2026-10-20T09:29:51.604Z",
    "updatedAt": "2026-10-21T09:10:40.200Z"
  }
}
```

**Errors:** 401 UNAUTHENTICATED (no/invalid/expired token; `details.reason: "expired"` when expired); 403 FORBIDDEN (student); 404 NOT_FOUND; 422 VALIDATION_FAILED; 501 NOT_IMPLEMENTED.

<a id="post-summaries-id-approve"></a>
### POST `/summaries/:id/approve`

**Owner** B · **Auth** owner (teacher) · **Status** Implemented (PB.2)

**Request:** No body.

**Success — 200**

```json
{
  "summary": {
    "id": "6650c3a0c3b2e41d8a500000",
    "lectureId": "6650c3a0c3b2e41d8a100001",
    "topicId": "6650c3a0c3b2e41d8a400000",
    "title": "Recap: training as minimising a loss over parameters",
    "text": "Training is reframed as minimising the loss L(θ) as a function of the parameters θ, with the data held fixed. Linear regression admits a closed-form solution via the normal equations, but its O(d³) cost and the absence of any closed form for neural networks motivate an iterative method that walks downhill on the loss landscape.",
    "keyPoints": [
      "The loss is treated as a function of the parameters, not the data.",
      "Closed-form least squares needs a d×d matrix inverse (about d³ work) and does not exist for neural networks.",
      "Linear-regression loss is a convex bowl; neural-network losses have local minima, plateaus and saddle points."
    ],
    "evidence": [
      {
        "chunkId": "6650c3a0c3b2e41d8a300000",
        "startSec": 66.201,
        "endSec": 95.359,
        "quote": "Think of it as a function of theta."
      },
      {
        "chunkId": "6650c3a0c3b2e41d8a300001",
        "startSec": 97.723,
        "endSec": 126.77,
        "quote": "for a neural network there is no closed form at all"
      }
    ],
    "status": "approved",
    "rejectionReason": null,
    "reviewNote": null,
    "faithfulnessScore": 1,
    "unsupportedSentences": [],
    "reviewedBy": "6650c3a0c3b2e41d8a000001",
    "reviewedAt": "2026-10-21T09:10:40.200Z",
    "model": "llama-3.3-70b-versatile",
    "promptVersion": "summary-v1",
    "createdAt": "2026-10-20T09:29:51.604Z",
    "updatedAt": "2026-10-21T09:10:40.200Z"
  }
}
```

**Errors:** 401 UNAUTHENTICATED (no/invalid/expired token; `details.reason: "expired"` when expired); 403 FORBIDDEN (student); 404 NOT_FOUND; 422 VALIDATION_FAILED.

<a id="post-summaries-id-reject"></a>
### POST `/summaries/:id/reject`

**Owner** B · **Auth** owner (teacher) · **Status** Stub (501) — PB.2

**Request:** JSON `{ rejectionReason, reviewNote? }`.

**Success — 200**

```json
{
  "summary": {
    "id": "6650c3a0c3b2e41d8a500003",
    "lectureId": "6650c3a0c3b2e41d8a100001",
    "topicId": "6650c3a0c3b2e41d8a400003",
    "title": "Chain rule and computational graphs",
    "text": "Backpropagation is an efficient application of the chain rule over a computational graph, not a new learning algorithm. The forward pass stores intermediate values; the backward pass multiplies each node's upstream gradient by its local derivative. Add gates distribute, multiply gates swap, max gates route, and gradients from multiple branches are summed.",
    "keyPoints": [
      "Worked example f = (x + y)·z at x = −2, y = 5, z = −4 gives ∂f/∂x = ∂f/∂y = −4 and ∂f/∂z = 3.",
      "Each node needs only its upstream gradient and its local derivative.",
      "The backward pass costs about the same as one or two forward passes."
    ],
    "evidence": [
      {
        "chunkId": "6650c3a0c3b2e41d8a300008",
        "startSec": 699.039,
        "endSec": 719.664,
        "quote": "It is just an efficient way of computing gradients"
      },
      {
        "chunkId": "6650c3a0c3b2e41d8a30000b",
        "startSec": 888.848,
        "endSec": 915.081,
        "quote": "An add gate distributes the upstream gradient unchanged to all its inputs."
      }
    ],
    "status": "rejected",
    "rejectionReason": "UNSUPPORTED",
    "reviewNote": null,
    "faithfulnessScore": 0.667,
    "unsupportedSentences": ["Add gates distribute, multiply gates swap, max gates route, and gradients from multiple branches are summed."],
    "reviewedBy": null,
    "reviewedAt": null,
    "model": "llama-3.3-70b-versatile",
    "promptVersion": "summary-v1",
    "createdAt": "2026-10-20T09:29:51.604Z",
    "updatedAt": "2026-10-20T09:29:51.604Z"
  }
}
```

**Errors:** 401 UNAUTHENTICATED (no/invalid/expired token; `details.reason: "expired"` when expired); 403 FORBIDDEN (student); 404 NOT_FOUND; 422 VALIDATION_FAILED; 501 NOT_IMPLEMENTED.

## C — Search, Q&A, questions, quizzes, revision

<a id="post-search"></a>
### POST `/search`

**Owner** C · **Auth** any signed-in user · **Status** Stub (501) — PC.1

**Request:** JSON `{ query, lectureId?, retriever? = "hybrid", topK? = 5 (1–20) }`.

**Success — 200**

```json
{
  "query": "what happens if the learning rate is too big",
  "retriever": "hybrid",
  "items": [
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
  ],
  "tookMs": 38
}
```

Passage from CONTRACTS.md §6.7 (no fixture exists for search); `tookMs` illustrative.

**Errors:** 401 UNAUTHENTICATED (no/invalid/expired token; `details.reason: "expired"` when expired); 422 VALIDATION_FAILED; 501 NOT_IMPLEMENTED.

<a id="post-ask"></a>
### POST `/ask`

**Owner** C · **Auth** any signed-in user · **Status** Stub (501) — PC.2

**Request:** JSON `{ question (3–500), lectureId?, retriever? = "hybrid" }`.

**Success — 200 (answered)**

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
      "chunkId": "6650c3a0c3b2e41d8a300003",
      "startSec": 299.059,
      "endSec": 329.254,
      "quote": "With eta equal to point one, each step multiplies w by point eight, so we shrink smoothly toward zero.",
      "lectureId": "6650c3a0c3b2e41d8a100001",
      "deepLink": "/lectures/6650c3a0c3b2e41d8a100001/play?t=299.059",
      "marker": 1
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

**Success — 200 (abstained — not an error)**

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

Answered example shortened to its first citation.

**Errors:** 401 UNAUTHENTICATED (no/invalid/expired token; `details.reason: "expired"` when expired); 422 VALIDATION_FAILED; 501 NOT_IMPLEMENTED; 503 PROVIDER_UNAVAILABLE `{ provider }`.

<a id="post-lectures-id-questions-generate"></a>
### POST `/lectures/:id/questions/generate`

**Owner** C · **Auth** owner (teacher) · **Status** Stub (501) — PC.3

**Request:** JSON `{ count? 1–20 = 5, topicIds?, difficulty? }`.

**Success — 201**

```json
{
  "items": [
    {
      "id": "6650c3a0c3b2e41d8a600006",
      "lectureId": "6650c3a0c3b2e41d8a100001",
      "topicId": "6650c3a0c3b2e41d8a400004",
      "type": "mcq",
      "difficulty": "hard",
      "stem": "Why do deep stacks of sigmoid layers suffer from vanishing gradients?",
      "options": [
        {
          "id": "a",
          "text": "The sigmoid derivative h(1 − h) is at most 0.25, so multiplying through many layers shrinks the gradient"
        },
        {
          "id": "b",
          "text": "Sigmoid outputs can be negative, which cancels gradients"
        },
        {
          "id": "c",
          "text": "The learning rate is divided by the number of layers"
        },
        {
          "id": "d",
          "text": "Bias gradients are always zero for sigmoid layers"
        }
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
  ]
}
```

**Errors:** 401 UNAUTHENTICATED (no/invalid/expired token; `details.reason: "expired"` when expired); 403 FORBIDDEN; 404 NOT_FOUND; 409 CONFLICT (lecture not ready); 422 VALIDATION_FAILED; 501 NOT_IMPLEMENTED; 503 PROVIDER_UNAVAILABLE.

<a id="get-questions"></a>
### GET `/questions`

**Owner** C · **Auth** teacher (own lectures) · **Status** Stub (501) — PC.3

**Request:** Query `lectureId` (required), `status?`, `topicId?`, `page`, `limit`.

**Success — 200**

```json
{
  "items": [
    {
      "id": "6650c3a0c3b2e41d8a600000",
      "lectureId": "6650c3a0c3b2e41d8a100001",
      "topicId": "6650c3a0c3b2e41d8a400000",
      "type": "mcq",
      "difficulty": "medium",
      "stem": "In the \"loss landscape\" view of training described in the lecture, what is treated as the variable being optimised?",
      "options": [
        {
          "id": "a",
          "text": "The training inputs x"
        },
        {
          "id": "b",
          "text": "The model parameters θ"
        },
        {
          "id": "c",
          "text": "The target labels y"
        },
        {
          "id": "d",
          "text": "The number of training examples"
        }
      ],
      "correctOptionId": "b",
      "explanation": "The lecture says the data is fixed and the loss should be thought of as a function of θ; training searches for the θ with the smallest loss.",
      "evidence": [
        {
          "chunkId": "6650c3a0c3b2e41d8a300000",
          "startSec": 66.201,
          "endSec": 95.359,
          "quote": "The data is fixed. Think of it as a function of theta."
        }
      ],
      "status": "approved",
      "rejectionReason": null,
      "reviewNote": null,
      "reviewedBy": "6650c3a0c3b2e41d8a000001",
      "reviewedAt": "2026-10-21T09:30:00.310Z",
      "model": "llama-3.3-70b-versatile",
      "promptVersion": "mcq-v1",
      "createdAt": "2026-10-20T15:12:08.377Z",
      "updatedAt": "2026-10-21T09:30:00.310Z"
    }
  ],
  "page": 1,
  "limit": 20,
  "total": 8
}
```

`items` shortened to one of eight.

**Errors:** 401 UNAUTHENTICATED (no/invalid/expired token; `details.reason: "expired"` when expired); 403 FORBIDDEN; 422 VALIDATION_FAILED; 501 NOT_IMPLEMENTED.

<a id="patch-questions-id"></a>
### PATCH `/questions/:id`

**Owner** C · **Auth** owner (teacher) · **Status** Stub (501) — PC.3

**Request:** JSON, any of `{ stem, options, correctOptionId, explanation, difficulty, status, rejectionReason, reviewNote }`; `status: "rejected"` needs `rejectionReason`.

**Success — 200**

```json
{
  "question": {
    "id": "6650c3a0c3b2e41d8a600004",
    "lectureId": "6650c3a0c3b2e41d8a100001",
    "topicId": "6650c3a0c3b2e41d8a400002",
    "type": "mcq",
    "difficulty": "medium",
    "stem": "Why is the single-example stochastic gradient still useful even though it is noisy?",
    "options": [
      {
        "id": "a",
        "text": "It always has lower variance than the full-batch gradient"
      },
      {
        "id": "b",
        "text": "It equals the full-batch gradient for every example"
      },
      {
        "id": "c",
        "text": "It is an unbiased estimate: in expectation it equals the full-batch gradient"
      },
      {
        "id": "d",
        "text": "It only needs to be computed once per epoch"
      }
    ],
    "correctOptionId": "a",
    "explanation": "A single-example gradient has lower variance than the full-batch gradient, so each step is more reliable.",
    "evidence": [
      {
        "chunkId": "6650c3a0c3b2e41d8a300006",
        "startSec": 517.092,
        "endSec": 540.686,
        "quote": "That estimate is noisy, but it's unbiased."
      }
    ],
    "status": "rejected",
    "rejectionReason": "FACTUALLY_WRONG",
    "reviewNote": "Keyed answer (a) is false: the lecture says the estimate is noisy (higher variance) but unbiased. The correct option is (c), and the explanation contradicts the cited passage.",
    "reviewedBy": "6650c3a0c3b2e41d8a000001",
    "reviewedAt": "2026-10-21T09:34:04.314Z",
    "model": "llama-3.3-70b-versatile",
    "promptVersion": "mcq-v1",
    "createdAt": "2026-10-20T15:12:08.377Z",
    "updatedAt": "2026-10-21T09:34:04.314Z"
  }
}
```

**Errors:** 401 UNAUTHENTICATED (no/invalid/expired token; `details.reason: "expired"` when expired); 403 FORBIDDEN (student); 404 NOT_FOUND; 422 VALIDATION_FAILED; 501 NOT_IMPLEMENTED.

<a id="post-quizzes"></a>
### POST `/quizzes`

**Owner** C · **Auth** any signed-in user · **Status** Stub (501) — PC.3

**Request:** JSON `{ lectureId, topicIds?, questionCount? 1–20 = 10 }`.

**Success — 201**

```json
{
  "quiz": {
    "id": "6650c3a0c3b2e41d8a700001",
    "lectureId": "6650c3a0c3b2e41d8a100001",
    "createdBy": "6650c3a0c3b2e41d8a000002",
    "title": "Practice quiz — Lecture 7",
    "topicIds": [],
    "questions": [
      {
        "id": "6650c3a0c3b2e41d8a600000",
        "topicId": "6650c3a0c3b2e41d8a400000",
        "difficulty": "medium",
        "stem": "In the \"loss landscape\" view of training described in the lecture, what is treated as the variable being optimised?",
        "options": [
          {
            "id": "a",
            "text": "The training inputs x"
          },
          {
            "id": "b",
            "text": "The model parameters θ"
          },
          {
            "id": "c",
            "text": "The target labels y"
          },
          {
            "id": "d",
            "text": "The number of training examples"
          }
        ]
      }
    ],
    "createdAt": "2026-10-26T18:20:51.000Z"
  }
}
```

Student view: no `correctOptionId`, `explanation`, `evidence` or `status`; built from the approved questions in `mocks/questions.json`, shortened to one.

**Errors:** 401 UNAUTHENTICATED (no/invalid/expired token; `details.reason: "expired"` when expired); 404 NOT_FOUND; 422 VALIDATION_FAILED (incl. "No approved questions available for this lecture"); 501 NOT_IMPLEMENTED.

<a id="get-quizzes"></a>
### GET `/quizzes`

**Owner** C · **Auth** any signed-in user (own quizzes) · **Status** Stub (501) — PC.3

**Request:** Query `lectureId?`, `page`, `limit`.

**Success — 200**

Paginated `QuizSummary` — shape in CONTRACTS.md §5.7 (no fixture exists).

**Errors:** 401 UNAUTHENTICATED (no/invalid/expired token; `details.reason: "expired"` when expired); 422 VALIDATION_FAILED; 501 NOT_IMPLEMENTED.

<a id="get-quizzes-id"></a>
### GET `/quizzes/:id`

**Owner** C · **Auth** quiz creator, or the lecture's owner · **Status** Stub (501) — PC.3

**Request:** No body.

**Success — 200**

```json
{
  "quiz": {
    "id": "6650c3a0c3b2e41d8a700001",
    "lectureId": "6650c3a0c3b2e41d8a100001",
    "createdBy": "6650c3a0c3b2e41d8a000002",
    "title": "Practice quiz — Lecture 7",
    "topicIds": [],
    "questions": [
      {
        "id": "6650c3a0c3b2e41d8a600000",
        "topicId": "6650c3a0c3b2e41d8a400000",
        "difficulty": "medium",
        "stem": "In the \"loss landscape\" view of training described in the lecture, what is treated as the variable being optimised?",
        "options": [
          {
            "id": "a",
            "text": "The training inputs x"
          },
          {
            "id": "b",
            "text": "The model parameters θ"
          },
          {
            "id": "c",
            "text": "The target labels y"
          },
          {
            "id": "d",
            "text": "The number of training examples"
          }
        ]
      }
    ],
    "createdAt": "2026-10-26T18:20:51.000Z"
  }
}
```

**Errors:** 401 UNAUTHENTICATED (no/invalid/expired token; `details.reason: "expired"` when expired); 404 NOT_FOUND; 501 NOT_IMPLEMENTED.

<a id="post-quizzes-id-attempts"></a>
### POST `/quizzes/:id/attempts`

**Owner** C · **Auth** any signed-in user · **Status** Stub (501) — PC.3

**Request:** JSON `{ startedAt (ISO), answers: [{ questionId, selectedOptionId | null }] }` — one per quiz question.

**Success — 201**

```json
{
  "attempt": {
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
      }
    ],
    "score": {
      "correct": 3,
      "total": 5,
      "accuracy": 0.6
    },
    "perTopic": [
      {
        "topicId": "6650c3a0c3b2e41d8a400000",
        "topicLabel": "Recap: training as minimising a loss over parameters",
        "correct": 1,
        "total": 1,
        "accuracy": 1
      },
      {
        "topicId": "6650c3a0c3b2e41d8a400001",
        "topicLabel": "Gradient descent and the learning rate",
        "correct": 1,
        "total": 2,
        "accuracy": 0.5
      },
      {
        "topicId": "6650c3a0c3b2e41d8a400002",
        "topicLabel": "Stochastic and mini-batch gradient descent",
        "correct": 0,
        "total": 1,
        "accuracy": 0
      },
      {
        "topicId": "6650c3a0c3b2e41d8a400003",
        "topicLabel": "Chain rule and computational graphs",
        "correct": 1,
        "total": 1,
        "accuracy": 1
      }
    ],
    "startedAt": "2026-10-26T18:31:02.118Z",
    "submittedAt": "2026-10-26T18:39:27.031Z",
    "timeTakenSec": 504.913
  }
}
```

From CONTRACTS.md §6.11, `answers` shortened to one of five.

**Errors:** 401 UNAUTHENTICATED (no/invalid/expired token; `details.reason: "expired"` when expired); 404 NOT_FOUND; 422 VALIDATION_FAILED; 501 NOT_IMPLEMENTED.

<a id="get-attempts-id"></a>
### GET `/attempts/:id`

**Owner** C · **Auth** the attempt's own user only · **Status** Stub (501) — PC.3

**Request:** No body.

**Success — 200**

```json
{
  "attempt": {
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
      }
    ],
    "score": {
      "correct": 3,
      "total": 5,
      "accuracy": 0.6
    },
    "perTopic": [
      {
        "topicId": "6650c3a0c3b2e41d8a400000",
        "topicLabel": "Recap: training as minimising a loss over parameters",
        "correct": 1,
        "total": 1,
        "accuracy": 1
      },
      {
        "topicId": "6650c3a0c3b2e41d8a400001",
        "topicLabel": "Gradient descent and the learning rate",
        "correct": 1,
        "total": 2,
        "accuracy": 0.5
      },
      {
        "topicId": "6650c3a0c3b2e41d8a400002",
        "topicLabel": "Stochastic and mini-batch gradient descent",
        "correct": 0,
        "total": 1,
        "accuracy": 0
      },
      {
        "topicId": "6650c3a0c3b2e41d8a400003",
        "topicLabel": "Chain rule and computational graphs",
        "correct": 1,
        "total": 1,
        "accuracy": 1
      }
    ],
    "startedAt": "2026-10-26T18:31:02.118Z",
    "submittedAt": "2026-10-26T18:39:27.031Z",
    "timeTakenSec": 504.913
  }
}
```

**Errors:** 401 UNAUTHENTICATED (no/invalid/expired token; `details.reason: "expired"` when expired); 404 NOT_FOUND; 501 NOT_IMPLEMENTED.

<a id="get-revision-plan"></a>
### GET `/revision-plan`

**Owner** C · **Auth** any signed-in user (own plan) · **Status** Stub (501) — PC.3

**Request:** Query `lectureId?`.

**Success — 200**

```json
{
  "plan": {
    "id": "6650c3a0c3b2e41d8a900001",
    "studentId": "6650c3a0c3b2e41d8a000002",
    "lectureId": "6650c3a0c3b2e41d8a100001",
    "generatedAt": "2026-10-26T18:39:28.204Z",
    "basedOnAttemptIds": [
      "6650c3a0c3b2e41d8a800001",
      "6650c3a0c3b2e41d8a800002",
      "6650c3a0c3b2e41d8a800003"
    ],
    "lectureAccuracy": 0.6,
    "items": [
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
    ]
  }
}
```

`{ plan: null }` before any attempt; example shortened to one of three items.

**Errors:** 401 UNAUTHENTICATED (no/invalid/expired token; `details.reason: "expired"` when expired); 422 VALIDATION_FAILED; 501 NOT_IMPLEMENTED.

## How to try it

Start the API against a database and seed the demo accounts (CONTRACTS.md §9 — demo credentials,
not secrets; the seed refuses to run in production):

```sh
npm run seed --workspace server
npm run dev --workspace server
```

Sign in as the demo teacher and keep the token:

```sh
TOKEN=$(curl -s -X POST localhost:5000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"teacher@lecturelens.dev","password":"lecturelens"}' \
  | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).token))")

curl -s localhost:5000/api/v1/auth/me -H "Authorization: Bearer $TOKEN"
curl -s "localhost:5000/api/v1/lectures?limit=5" -H "Authorization: Bearer $TOKEN"
curl -s localhost:5000/api/v1/lectures/6650c3a0c3b2e41d8a100001/status -H "Authorization: Bearer $TOKEN"
```

Upload a lecture (all three consent fields are required), then watch its status:

```sh
curl -s -X POST localhost:5000/api/v1/lectures -H "Authorization: Bearer $TOKEN" \
  -F "file=@sample.mp3" -F "title=Test lecture" -F "recordedOn=2026-10-28" \
  -F "lecturerConsent=true" -F "purposeShown=true" -F "processorNamed=true"
```

See a stub and a permission check in action (the second uses the demo student):

```sh
curl -s -X POST localhost:5000/api/v1/ask -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"question":"Why does the loss blow up?"}'
# → 501 NOT_IMPLEMENTED, details { "owner": "C", "prompt": "PC.2" }

STUDENT=$(curl -s -X POST localhost:5000/api/v1/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"student@lecturelens.dev","password":"lecturelens"}' \
  | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).token))")
curl -s -X DELETE localhost:5000/api/v1/lectures/6650c3a0c3b2e41d8a100001 -H "Authorization: Bearer $STUDENT"
# → 403 FORBIDDEN
```
