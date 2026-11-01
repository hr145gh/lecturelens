# topics — owner: Member B · prompt PB.1
Routes: `GET /lectures/:id/topics`, `PATCH /topics/:id` (teacher, `{ label?, keywords? }`), `POST /topics/:id/approve` (teacher, no body), `POST /topics/:id/reject` (teacher, `{ rejectionReason, reviewNote? }`).
Output: `{ lectureId, items: TopicSection[] }` or `{ topic }` — see CONTRACTS.md §5.5, §4.5 (tiling invariant) and §6.5. Students: `TopicSection.approvedFor(lectureId)` only (§4.12).
Replace the handler body only; do not change the path, guards or validation without a contract-change issue.

## Chunk/topic separation

- `services/chunking` produces short, overlapping retrieval chunks. These are invisible to users.
- `services/topics` produces human-readable, non-overlapping navigation sections.
- Fixed-window topic sections are only the labeled `fixed_window` comparison baseline.
- Embedding-topic detection is an unsupervised heuristic over pretrained embeddings, not a trained
  segmentation model. Member C supplies the shared embedding helper through the narrow interface;
  this module does not implement embedding inference itself.
