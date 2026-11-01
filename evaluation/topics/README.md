# Topic segmentation evaluation

Sample size: 2 annotated lectures, 1 annotator each (Member B). The second sample
is a hand-created segmentation annotation rather than a teammate annotation; a
second independent annotator is still needed for inter-annotator agreement.

Tolerance: ±1 segment for boundary precision, recall, and F1. WindowDiff uses
windows of 3 segment boundaries.

The proposed method is an unsupervised heuristic over pretrained embeddings.
It is explicitly **not a trained topic-segmentation model**.

## Real evaluation output

| Method | Lecture | Precision | Recall | F1 | WindowDiff |
| --- | --- | ---: | ---: | ---: | ---: |
| Fixed window | 6650c3a0c3b2e41d8a100001 | 0.000 | 0.000 | 0.000 | 0.512 |
| Embedding similarity | 6650c3a0c3b2e41d8a100001 | 0.750 | 0.600 | 0.667 | 0.209 |
| Fixed window | 6650c3a0c3b2e41d8a100002 | 1.000 | 1.000 | 1.000 | 0.091 |
| Embedding similarity | 6650c3a0c3b2e41d8a100002 | 1.000 | 1.000 | 1.000 | 0.182 |

## Segmentation failure cases

1. **Late topic transition:** The lecture moves into mini-batches but a local
   similarity spike splits one minute later than the hand boundary.
2. **Short digression:** A brief administrative aside creates an isolated
   low-similarity window and is mistaken for a topic boundary.
3. **Repeated terminology:** Consecutive explanation windows remain semantically
   similar even when the lecturer changes to a new example.
4. **Fixed-window endpoint:** The fixed-window method can cut mid-sentence or
   mid-example because its segment duration does not follow semantic boundaries.

## Summary failure cases to record

1. **Sentence boundary merged claims:** `Learning rates that are neither too large nor too small converge reliably` was flagged unsupported because the passage only describes separate large/small examples.
2. **ASR quote mismatch:** A model quote containing normalised speech punctuation failed exact matching and was shortened or discarded rather than given a timestamp.
3. **Short section evidence:** A section with fewer than two distinctive transcript spans could not justify two quotes, so unlocatable evidence was discarded.
