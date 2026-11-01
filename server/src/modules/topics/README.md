# topics — owner: Member B · prompt PB.1
Routes: `GET /lectures/:id/topics`, `PATCH /topics/:id` (teacher, `{ label?, keywords? }`), `POST /topics/:id/approve` (teacher, no body), `POST /topics/:id/reject` (teacher, `{ rejectionReason, reviewNote? }`).
Output: `{ lectureId, items: TopicSection[] }` or `{ topic }` — see CONTRACTS.md §5.5, §4.5 (tiling invariant) and §6.5. Students: `TopicSection.approvedFor(lectureId)` only (§4.12).
Status: `GET /lectures/:id/topics`, `PATCH /topics/:id` and `POST /topics/:id/approve` are implemented (PB.1); `POST /topics/:id/reject` still returns `501 NOT_IMPLEMENTED`.
Replace the handler body only; do not change the path, guards or validation without a contract-change issue.

## Chunks and topic sections are different things

- **Retrieval chunks** (`services/chunking/chunker.ts`) — units for search / RAG, invisible to users:
  ~60 s windows overlapping ~15 s, snapped to segment edges, cut early at ~200 words. Built for Member C.
- **Topic sections** (`services/topics/segmenter.ts`) — navigation units for people, 2–15 min,
  non-overlapping, labelled in the UI, tiling the lecture exactly (§4.5). Built independently of chunks.
- `fixed_window` is the **baseline**: it exists to be beaten, not to ship as the answer.
- `embedding_similarity` is the **proposed** method: an **unsupervised heuristic over pretrained
  embeddings** (cosine similarity between the 3-segment windows either side of each gap; local minima
  below `TOPIC_SIM_THRESHOLD`; sections ≥ `TOPIC_MIN_SEC`, closer boundaries merged keeping the
  strongest). **It is not a trained segmentation model.** It needs Member C's shared embedder
  (`services/embeddings/`, not merged yet); until then the pipeline uses `fixed_window`, recorded as such.
- Labels: the shared LLM client (`services/llm/client.ts`, Member D) for a 3–6 word title and 3–5
  keywords as zod-validated JSON; on any failure, TF-IDF terms over the lecture's sections (logged).
- Tuning values (`CHUNK_SECONDS`, `CHUNK_OVERLAP_SECONDS`, `TOPIC_SECTION_SECONDS`, `TOPIC_SIM_THRESHOLD`,
  `TOPIC_MIN_SEC`) are starting values in `config/env.ts`, passed in by the pipeline.
