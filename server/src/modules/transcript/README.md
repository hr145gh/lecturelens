# transcript — owner: Member A · prompt PA.1
Routes: `GET /lectures/:id/transcript`, `PATCH /lectures/:id/segments/:index` (teacher, body `{ text }` 1–2000 chars), `POST /lectures/:id/transcript/approve` (teacher, no body).
Output: `{ lectureId, transcriptApproved, items: Segment[] }`, `{ segment }`, `{ lecture }` — see CONTRACTS.md §5.4 and §6.3; audit rule in §4.3 (the TranscriptSegment model enforces it on `save()`).
Status: implemented (PA.1), audited and fixed by Member D. Transcripts are written by the pipeline (`services/asr/persist.ts`), never by these routes.
Replace the handler body only; do not change the path, guards or validation without a contract-change issue.
