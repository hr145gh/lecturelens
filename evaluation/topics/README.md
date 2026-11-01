# Topic segmentation & summary evaluation (Member B)

```
npx tsx evaluation/topics/evaluate.ts          # writes results.csv, prints the table below
node_modules/.bin/vitest run evaluation/topics  # metric unit tests (incl. NLTK's WindowDiff example)
```

## What is measured — read this before the numbers

- **Sample size: 2 lectures, 1 annotator each — far too small to generalise from.**
  - `annotations/lecture-7-claude-assistant.json` — Lecture 7 (gradient descent / backprop),
    45 segments, from `mocks/transcript.json`. **This is a synthetic fixture transcript, not a
    recording.** (`mocks/topics.json` places two boundaries differently, at 17 and 25; the
    annotation was made from the transcript text, not copied from the fixture.)
  - `annotations/gate-smashers-claude-assistant.json` — a real Hindi–English UML class-diagram
    lecture (third-party Gate Smashers video, 582 s), 23 segments, transcribed once with Groq
    (`whisper-large-v3-turbo`, 2026-11-01). Segments 13, 17 and 19 contain garbled ASR, which
    makes the reference boundaries there uncertain.
  - **The Gate Smashers transcript is NOT in the repository** (third-party content). The
    annotation points at `transcripts/gate-smashers-uml-class-diagram.json`, which is
    git-ignored and exists only on the machine that ran the evaluation. Whisper is not
    deterministic, so re-transcribing the video would shift segment indexes and invalidate the
    annotation. Without that exact file, `evaluate.ts` does **not** re-score this lecture: it
    keeps the rows recorded in `results.csv` and says so. Only Lecture 7 is reproducible from a
    fresh checkout. The Gate Smashers numbers below come from the one real run that had the
    file.
- **Annotator: `claude-assistant` (an AI assistant), not a teammate.** Treat the reference as a
  provisional annotation. **Inter-annotator agreement: n/a.** `evaluate.ts` computes it
  automatically (F1 + WindowDiff between annotators) as soon as a second, independent file
  for the same `lectureId` is added under `annotations/`.
- **Boundaries** are "after segment *i*" positions.
- **Precision / recall / F1** use a **±1-segment tolerance** with one-to-one matching: one
  prediction cannot claim two reference boundaries.
- **WindowDiff** follows Pevzner & Hearst (2002), with *k* = half the mean reference section
  length in segments, rounded and at least 1. Lower is better; 0 means identical.
  `metrics.test.ts` checks the implementation against NLTK's documented example (0, 0.3, 0.8).
- **Methods:**
  - `fixed_window`: 300 s sections. This is what the pipeline currently runs.
  - `embedding_similarity` (the proposed method): an **unsupervised heuristic** (cosine
    similarity between adjacent segments over pretrained sentence embeddings). It is **not a
    trained segmentation model** — nothing is trained.
  - **`embedding_similarity` was NOT run**, because Member C's embedder
    (`server/src/services/embeddings`) does not exist yet. `evaluate.ts` runs it automatically
    once that module lands. Its row is `n/a`, never an estimate.
- The table that used to be in this file (and the earlier `results.csv`, plus
  `lecture-1/2-annotation.json`) was **removed**. It was not produced by any script: it
  reported `embedding_similarity` scores without an embedder, and a lecture with no transcript.

## Results (real run, 2026-11-01 — `results.csv`)

| Method | Lecture | Segs | Reference | Predicted | P | R | F1 | WindowDiff (k) |
| --- | --- | ---: | --- | --- | ---: | ---: | ---: | ---: |
| fixed_window | Gate Smashers UML | 23 | 1 4 7 11 14 19 | 11 | 1.000 | 0.167 | 0.286 | 0.476 (2) |
| embedding_similarity | Gate Smashers UML | 23 | 1 4 7 11 14 19 | not run | n/a | n/a | n/a | n/a |
| fixed_window | Lecture 7 (synthetic) | 45 | 7 16 24 35 | 11 22 33 | 0.000 | 0.000 | 0.000 | 0.525 (5) |
| embedding_similarity | Lecture 7 (synthetic) | 45 | 7 16 24 35 | not run | n/a | n/a | n/a | n/a |

Boundary times:
- Gate Smashers: predicted 11 @ 316 s; reference 48, 125, 213, 316, 401 and 493 s.
- Lecture 7: predicted 331, 621 and 916 s; reference 221, 467, 674 and 965 s.

## Segmentation failure cases (observed in the run above)

1. **Fixed cuts miss every boundary by 2–4 segments (Lecture 7, F1 = 0).**
   - The 331 s cut (after segment 11) falls in the middle of the learning-rate examples. The
     real change, from the recap/landscape to the gradient and update rule, is at segment 7.
   - The 916 s cut (after 33) splits the chain-rule/computational-graph explanation; the
     reference boundary is at 35.
   - None is within ±1, so precision and recall are both 0.
2. **Section length mismatch (Gate Smashers, recall 0.167).**
   - The lecture's sections are about 80 s long, and 300 s windows on a 9.7-min video give
     only one cut.
   - That cut (316 s) coincides with a real boundary by chance. F1 = 0.286 overstates the
     method: precision is 1.0 over a single prediction.
3. **A misplaced boundary produces a mixed section, then a misleading label and summary.**
   - Lecture 7 section 2 (segments 23–33) was labelled "Backpropagation and Gradient Flow" by
     the LLM.
   - Most of the section is actually SGD noise and learning-rate decay, and its summary spends
     two of three sentences on SGD.
   - The segmentation error passes straight into what students would read.
4. **TF-IDF fallback labels are meaningless on Hindi–English text.**
   - LLM labelling hit Groq's 8 000 tokens-per-minute limit (HTTP 429) after the retries, so the
     labeller fell back to TF-IDF.
   - The resulting Gate Smashers labels were **"हैं में account"** and **"account सकते हैं"**:
     Hindi function words (हैं, में, सकते) are not in the stop list.
   - These labels stay `pending_review`, so a teacher sees them before any student does. Still,
     the fallback needs a Hindi stop list.

## Summarisation failure cases (real LLM run, 2026-11-01)

How the run was set up:
- The run covered both lectures above. The pipeline stages ran as the app runs them:
  chunking → `fixed_window` segmenting → summarising.
- Model: `openai/gpt-oss-120b` via Groq.
- Throwaway in-memory MongoDB; no shared data was touched.
- The full run output (`summarisation-run.json`) contains the third-party transcript text, so
  it is git-ignored and kept locally only. The cases below quote only the short excerpts they
  need. Lecture 7 can be re-run from the repo; its LLM output will differ run to run.

What came out:
- All 6 summaries were created **`pending_review`**.
- Every LLM quote was located in the transcript: 0 were discarded.
- The extractive fallback was not needed.
- 2 of the 6 sections needed the strict retry (`summary-v2-strict`).

Faithfulness check: a sentence is supported when at least 50% of its content words occur in the
section (`FAITHFULNESS_THRESHOLD`).

1. **Flagged sentence — a false positive (Lecture 7, section 0, faithfulnessScore 0.667).**
   - Flagged: *"The lecture reframes the loss as a function of the model parameters θ and
     describes training as searching for the θ that minimizes this loss."*
   - Support is 0.45. The missing words were *lecture, reframes, θ, describes, searching,
     minimizes*.
   - The claim **is** supported. Segment 2 says *"Think of it as a function of theta … training
     is just the search for the theta where that number is smallest."*
   - The check has no stemming (search/searching), no symbol↔word mapping (θ/theta) and no
     paraphrase awareness (minimizes/smallest).
   - The fixtures show the same pattern: η vs "eta", and 32–512 vs "thirty two … five hundred
     twelve".
   - `unsupportedSentences` is a review aid, not proof of error.
2. **Missed fabrication — a false negative (Gate Smashers, section 1, score 1.0).**
   - The summary begins *"पैसेशन में inheritance concept बताया गया है…"*.
   - "पैसेशन" is not a word, and it does not occur in the transcript. The ASR there has the
     garbled *"जनलाइजेशल"* (generalisation).
   - The sentence also adds *"cardinality"*, a term the lecturer never says (he says
     "numbering").
   - Support was still 0.65, because the rest of the sentence's words are in the passage. The
     token-overlap check cannot catch a single invented word or term inside an otherwise
     grounded sentence.
3. **Rewriting into another script lowers support without catching anything (Gate Smashers,
   section 0).**
   - Prompt rule 4 says "keep technical terms as spoken".
   - The model still rewrote the lecturer's Latin-script terms into formal Devanagari:
     *क्लास* for "class", *दृश्यता* for "visibility", *सॉफ्टवेयर के घटकों*.
   - Token overlap cannot match across scripts, so the third sentence dropped to 0.56 support,
     just above the 0.5 threshold, even though its content is in the passage.
   - The result is the worst of both: correct sentences come close to being flagged, while the
     check still gives no signal on the invented word in case 2.

## Files

- **`evaluate.ts`:** metrics (`boundaryMetrics`, `windowDiff`, `boundaryFlags`, `defaultK`) and
  the runner.
- **`metrics.test.ts`:** metric unit tests.
- **`annotations/*.json`:** `{ lectureId, annotator, transcript, boundaries: [{ afterSegmentIndex, note }] }`.
- **`transcripts/`:** local only, git-ignored (see `.gitignore`). It holds the frozen Gate Smashers
  transcript the annotation indexes refer to.
- **`results.csv`:** generated by `evaluate.ts`; do not edit by hand.
- **`summarisation-run.json`:** local only, git-ignored. The verbatim output of the real
  summarisation run behind the cases above.
