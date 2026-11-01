# ASR failure cases

**No cases are documented yet.** Each case must come from a real transcription of the evaluation
clips, checked by listening — none has been run (no provider API key; references not typed; see
`README.md` → Status). Do not fill this file from memory or from expectations of what ASR "usually"
gets wrong.

## How to fill it (at least 6 cases)

1. Type the references, run `npx tsx evaluation/asr/evaluate.ts`.
2. Open `failure-candidates.md`: every word error, with the approximate time in the clip.
3. Listen at that time in `clips/<clip>.wav`; add the clip's start in `manifest.json` to give the time
   in the original lecture.
4. Write the case up below. Cover the different causes (technical term, crosstalk, accent, noise,
   number formatting) where the data has them — and say so where it does not (e.g. no accented clip yet).

| # | Lecture · clip | Time (lecture / clip) | ASR produced | Actually said | Glossary on fixes it? | Cause |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | | | | | | |
| 2 | | | | | | |
| 3 | | | | | | |
| 4 | | | | | | |
| 5 | | | | | | |
| 6 | | | | | | |
