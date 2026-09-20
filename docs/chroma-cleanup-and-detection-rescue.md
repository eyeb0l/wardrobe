# Garment colour preservation and difficult detection

The handbag report exposed a reproducible cleanup bug: global cyan suppression altered legitimate blue fabric and reduced its opacity. The cleanup now identifies the actual key-coloured background and confines colour unmixing to its boundary. Opaque garment interiors and existing transparent cutouts retain their colour and alpha. Matching background in handle openings is removed too. Ambiguous near-key edges remain intact and fail strict cleanup rather than being neutralized.

This changes `scripts/import-job-api.mjs`; production detection remains `gpt-5.6-luna` with reasoning effort omitted. The earlier evaluation compared that behaviour with explicit medium. A Terra retry button is a possible later product change, not part of this patch.

## Fidelity evidence

The user's original transparent handbag was composited over the app-selected cyan key, then processed through the old and new cleanup. This is a controlled replay, not the unavailable historical generated-source image. No image model was called.

| Same 50 × 50 body sample | Mean red | Mean green | Mean blue | Mean alpha |
| --- | ---: | ---: | ---: | ---: |
| Original, standard framing | 37.8952 | 52.8840 | 72.8728 | 255 |
| Old cleanup | 36.9536 | 26.1496 | 46.6796 | 219 |
| Fixed cleanup | 37.8952 | 52.8840 | 72.8728 | 255 |

The visual replay shows the old purple shift and the restored blue. The original already-transparent input also preserves the sample exactly. Images and detailed measurements remain private in `data/vision-eval-api-2026-09-20/cleanup-fix/`.

Exact key-coloured fabric cannot reliably be distinguished from a same-coloured background hole using a single flattened image. Key selection still avoids the item's declared primary and secondary colours. This patch fixes the demonstrated deterministic recolouring; it does not guarantee that the image generator itself will never change garment details.

## Terra rescue protocol

Twelve images: eight difficult/intermittent cases and four controls. Three configurations, two repeats each, 72 fresh calls: Luna medium, Terra low and Terra medium. The same production detection instructions, schema, image bytes, existing labels and strict acceptance rubric are reused. The supplied transparent handbag has an alpha-derived and visually checked box label frozen before the new calls. Textual fidelity is graded from anonymized answers; matching and box coverage are scored deterministically.

This is a failure-selected exploratory suite. Earlier Terra outputs were already seen for three difficult images, including a known Terra win. Several images share a product family. Repeats are correlated. Fresh Luna baselines and controls measure variability and regressions but do not remove selection bias.

Before responses, the exploratory rule required at least two distinct difficult images rescued, at least a 10 percentage point improvement in difficult-case acceptance, and no more than one accepted control call lost relative to Luna. Prefer the cheaper effort that meets these conditions. A positive result supports further testing of a user-triggered retry, not automatic routing or a wholesale model change.

All calls use the original US$10 ledger, including conservative reservations for earlier uncertain requests. No response-generation retries, image-generation calls or paid API judges are used. Freeze hashes, response files, anonymous grades and the cost ledger are stored privately under `data/vision-eval-api-2026-09-20/`.

## Implementation validation

- `npm test`: 375 tests passed, including 19 new cleanup regressions.
- `npm run check`: production build passed; existing HEIC bundle size warning remains.
- Fresh read-only review found a border-touching transparent-cutout issue. After its fix, the review reproduction was pixel-identical and no actionable findings remained.
- Final full-image replay: mean premultiplied RGB error over the visible union fell from 21.0642 to 0.6355 channel levels; mean alpha error fell from 31.8625 to 0.8703. The original transparent input has zero pixel difference after the same standard framing.
- The actual strict cleanup entry point accepts the final synthetic handbag replay with zero unresolved pixels; one local run took 2.80 seconds. This is a single-image timing, not a performance benchmark.

The patch is local and has not been deployed. Existing wardrobe images have not been replaced; the changed cleanup applies to subsequent processing when released.

## Detection results

All 72 planned calls were sent: 69 usable responses and three 210-second transport timeouts, one per configuration on the same food-negative control/repeat. Timeouts count as failures and retain their full reservations. No retries were issued. All 69 usable answers were graded with answer-to-model mapping hidden; the grader knew the set of candidate models. Exactly two frozen subjective ratings were required per answer. Strict acceptance also requires the complete required item set, usable boxes and correct clean-product classification.

| Configuration | Difficult cases accepted | Controls accepted | Median latency, all calls | Observed API cost, 24 calls | Cost including unresolved reservation |
| --- | ---: | ---: | ---: | ---: | ---: |
| Luna medium | 3/16 (18.75%) | 5/8 | 14.09 s | $0.03960 | $0.06211 |
| Terra low | 4/16 (25%) | 5/8 | 11.98 s | $0.31097 | $0.53605 |
| Terra medium | 8/16 (50%) | 5/8 | 14.22 s | $0.34412 | $0.56920 |

Medians use the mean of the two middle observations. The generic HTML report uses the scorer's lower-middle convention; the difference is only presentation. Request latency excludes token counting and queueing. Prompt caching and repeated inputs affect these measured prices and times; these are not uncached production forecasts.

Terra medium rescued **5 of 13** fresh Luna failures across **four difficult images**, with **zero regressions among Luna's three difficult-case successes**. Difficult-case acceptance improved by 31.25 percentage points. Control totals were unchanged, but one control call improved and a different control call regressed. Terra low rescued four failures but lost all three Luna successes on the difficult subset, leaving only a 6.25-point net gain; its controls had two gains and two regressions.

Medium meets the frozen exploratory fallback rule; low does not. Examples supporting medium: the small earring with brown knit (both repeats), a tight sweater/skirt/boots crop (one rescued repeat), the user's transparent handbag (one repeat), and a layered plum outfit (one repeat). It still failed both repeats of the denim/cream separates image, busy blazer image and scarf/skirt image. The handbag improvement was recognizing a usable clean product shot; this is separate from repairing the deterministic colour bug.

A counterfactual policy that retried all 13 failed difficult Luna calls with Terra medium would spend $0.19228 extra and rescue five: **3.85 cents extra per rescue**, or **4.30 cents including the initial Luna attempts** in that failed subset. This uses gold failure labels unavailable to the app and is not a deployment traffic estimate. A future user-triggered retry could supply the failure signal and should present the new result for review rather than discard the prior result automatically.

**Decision:** retain Luna as the default. Terra medium is the better candidate for a future manual difficult-detection retry. This small, selected test does not justify switching every workflow or automatically routing by model confidence. No retry UI or production model change was made.

## Accounting and reproduction

This 72-call extension recorded **$0.694681607** usage. Its conservative upper amount is **$1.167361157**, including $0.47267955 held for the three new uncertain requests. Across all 392 evaluation attempts, observed usage is **$2.395269344** and the conservative committed amount is **$3.001065694**, below the original **$10 total cap**. Eleven uncertain attempts remain reserved across all phases. These upper amounts are budget reservations, not confirmed billed charges. Codex subagent use is separate from the API ledger.

Private artifacts:

- `data/vision-eval-api-2026-09-20/detection-rescue/`: frozen suite, protocol, labels, hashes, phase ledger, cumulative ledger, anonymized grades, scores, paired analysis and `report.html` with reference/predicted boxes.
- `data/vision-eval-api-2026-09-20/cleanup-fix/`: old/new controlled replay, comparison image, full-image metrics and final source/test validation hashes.

The shared live ledger remains `data/vision-eval-api-2026-09-20/run/ledger.json`; earlier historical ledger snapshots were preserved. Private images and responses are ignored by Git. The evaluator adds a named `rescue` phase and explicit `terra-medium` configuration while retaining the original cumulative cap and reservation safeguards.
