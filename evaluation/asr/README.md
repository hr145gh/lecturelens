# evaluation/asr — ASR accuracy evaluation (Member A, PA.2)

**The speech-recognition model is a pretrained hosted service — AssemblyAI Universal-2, with
Groq-hosted Whisper large-v3-turbo as the fallback — that we did not train or fine-tune.**

## Status

**Not run yet — there are no results.** Two things are missing, and neither can be invented:

1. **Reference transcripts.** `reference/c1.txt`–`c4.txt` must be typed by a person listening to the
   clips. Until a file has text below its `#` comment lines, `evaluate.ts` skips that clip.
2. **A provider API key.** `ASSEMBLYAI_API_KEY` (and/or `GROQ_API_KEY`) in `server/.env`.

`results.csv` stays header-only and `FAILURES.md` stays empty until both exist.

## The glossary experiment is prompting, not training

`glossary.txt` holds 54 technical terms from the course's sample lectures. With
`ASR_USE_GLOSSARY=true` (or glossary "on" in `evaluate.ts`) they are sent with each request: as
`word_boost` for AssemblyAI Universal-2 and as the `prompt` for Whisper. **This is prompting — it
biases the pretrained model toward these spellings for one request. Nothing is trained, fine-tuned
or stored by the provider as a model change.** The before/after comparison measures only that bias.

## Sample: what is measured, and why it is small

| | |
| --- | --- |
| Source | One real lecture recording, 9 min 42 s — **a publicly available third-party video (Gate Smashers: UML class diagrams) in Hindi–English code-mixed speech, not one of our course lectures**. Used for testing only; the audio is never committed or redistributed (`clips/` is git-ignored). `manifest.json` → `sourceRecording` (md5-checked) |
| Clips | `c1`–`c4`: four consecutive ~2-minute clips cut at measured pauses (0–484.5 s, **8 min 4 s of unique speech**) · `c1-noisy`: `c1` with synthetic pink noise at a measured 10.0 dB SNR |
| Total audio | 604 s ≈ **10 minutes** (the noisy clip reuses `c1`'s reference) |
| Conditions | `clean` (provisional — relabel if the typist hears background noise/music) and `noisy`. **`accented`: none** — it needs a recording of a speaker with a different accent; add one before claiming anything about accents |

**Language.** The speaker code-mixes Hindi and English. References must follow Whisper's script
convention — Hindi words in Devanagari, English words in Latin script — or script differences
would be counted as errors. WER on code-mixed speech is not comparable with published
English-only WER figures.

**Glossary mismatch.** `glossary.txt` holds the course's machine-learning terms, but this recording is
about UML class diagrams, so termAccuracy will mostly be `n/a` and the glossary on/off comparison
cannot show an effect on this sample. A fair keyterm experiment needs either a course recording
(ML content) or a UML glossary written from the topic — not from this recording's ASR output, which
would make the comparison circular.

It is small on purpose: an accurate reference must be typed by hand, verbatim, and 10 minutes
(roughly 1,200–1,500 words) is what a person can transcribe carefully. Measured precisely it shows
large effects, but it is **one speaker, one lecture, one room**: the numbers describe this sample,
not ASR accuracy in general. As a rule of thumb, with ~1,300 reference words a WER near 10 % has a
binomial standard error of about ±0.8 points (±1.6 at 95 %), and errors cluster, so treat
differences under ~2 points between glossary on and off as noise.

## Normalisation (applied identically to reference and hypothesis — `metrics.ts`)

1. Unicode NFKC, then lowercase.
2. Numbers to words: thousands separators dropped (`50,000` → `fifty thousand`); decimals read digit by
   digit after "point" (`0.25` → `zero point two five`); `%` → `percent`; American style without "and"
   (`105` → `one hundred five`).
3. Hyphens, dashes and slashes → space (`mini-batch` → `mini batch`).
4. Apostrophes removed (`let's` → `lets`).
5. Every other character that is not a letter, combining mark or digit → space (marks are kept so
   Devanagari vowel signs survive: "हैं" stays "हैं").
6. Whitespace collapsed to single spaces, trimmed.

## Metrics

- **WER** (word error rate) = (substitutions + deletions + insertions) ÷ reference words, from a
  Levenshtein edit distance over the normalised word tokens (implemented in `metrics.ts`, no library).
  0 is perfect; lower is better; it can exceed 1 when the ASR inserts many words.
- **CER** (character error rate) = the same edit distance over the characters of the normalised text
  (single spaces between words included) ÷ reference characters. Less harsh than WER on near-misses
  ("decent" for "descent").
- **termAccuracy** = of the glossary-term occurrences in the reference, the share also present in the
  hypothesis: Σₜ min(refCountₜ, hypCountₜ) ÷ Σₜ refCountₜ, matching whole normalised word sequences.
  A term inside a longer one counts for both ("gradient" in "gradient descent"). `n/a` when the
  reference contains no glossary term. Higher is better.
- **wordCount** = reference words after normalisation (the WER denominator).

## How to run

```sh
npx tsx evaluation/asr/make-clips.ts                # cut clips/*.wav from the source recording (md5-checked)
# type reference/c1.txt … c4.txt by listening to clips/c1.wav … c4.wav
npx tsx evaluation/asr/evaluate.ts                  # ASR_PROVIDER or --provider=assemblyai|groq
npx tsx evaluation/asr/evaluate.ts --fresh          # ignore cached transcripts in hypotheses/
```

Each clip is transcribed twice by **one** provider (no fallback, so "off" and "on" are comparable).
Transcripts are cached in `hypotheses/` so re-scoring never re-bills. Output: a table on stdout,
`results.csv` (`clip, condition, glossary, wer, cer, termAccuracy, wordCount`) and
`failure-candidates.md` — every word error with its approximate time, as raw material for
`FAILURES.md` (listen before writing a case up).

## Files

| File | |
| --- | --- |
| `glossary.txt` | 54 course terms (keyterms) |
| `manifest.json` | Clips, cut points, conditions, references, source checksum |
| `reference/*.txt` | Hand-typed references (to be typed) |
| `clips/` | Generated audio — git-ignored (cut from a real lecture) |
| `make-clips.ts` · `evaluate.ts` · `metrics.ts` | Clip cutting · evaluation run · WER/CER/term accuracy |
| `results.csv` · `FAILURES.md` | Results and documented failure cases (empty until the run) |
| `fixtures/` | Unit-test fixtures in each provider's response format — hand-built, **not recorded** responses |
