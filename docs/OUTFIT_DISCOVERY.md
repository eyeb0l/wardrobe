# Image-aware discovery and checks with OpenAI Decisions

Wardrobe uses the [Decisions API](https://developers.openai.com/api/reference/resources/decisions/methods/create) for small, constrained visual judgments. This replaces the TypeSafe Jev adapter. Decisions receives actual saved photographs and garment cutouts alongside bounded metadata.

## Enable

Use the existing server-only OpenAI key and set:

```dotenv
WARDROBE_DECISIONS_ENABLED=1
OPENAI_DECISIONS_MODEL=gpt-6-luna
```

The flag defaults off. `OPENAI_API_KEY` and the existing `OPENAI_API_BASE_URL` configuration are shared with other OpenAI features. No new credential or SDK dependency is required. Do not prefix these variables with `VITE_`, expose the key to the browser or commit secrets. The old `WARDROBE_JEV_ENABLED` and `TYPESAFE_API_KEY` variables are unused; they do not enable Decisions or provide a fallback provider.

For hosted use, add the new flag to the intended deployment environment and redeploy while retaining All Deployments authentication. Enabling a flag is separate from verifying API access. The public reference lists Decisions as a beta API; account access, actual latency, visual quality and Decisions billing must be checked in a separately authorized bounded live evaluation. Offline fixtures prove integration contracts, not model accuracy or savings.

## Saved-look search and owned-piece swaps

- **Find a saved look** searches accepted looks against an occasion or mood. Each candidate includes its saved photo and the actual cutouts of its selected garments.
- **Best match / More understated / More striking** and **Favour pieces in fewer saved looks** reorder the existing judgments locally. Saved appearances are not wearing history.
- **Change one piece** compares up to six owned alternatives in the same category. Decisions sees the original outfit photo, original piece, fixed-piece cutouts and candidate cutouts. Its prompt explicitly distinguishes the existing photograph from the proposed replacement. It does not generate a preview or change the saved look.

| Route | Request / result |
| --- | --- |
| `GET /api/outfits/discovery/config` | `{ enabled, ready }`; no credential |
| `POST /api/outfits/discovery/rank` | `{ brief }`; scores all eligible accepted looks |
| `POST /api/outfits/discovery/swaps` | `{ brief, outfitId, garmentId }`; scores available same-category owned alternatives |

POSTs require same-origin JSON, a nonempty brief of at most 500 characters and a body of at most 4 KiB. The server reads current inventory; requests cannot supply arbitrary source files or candidate records. Hidden/deleted garments, missing cutouts and unavailable saved photos are excluded. All selected pieces must still exist.

OpenAI receives the brief, bounded names/categories/tags/approximate colour names, occasions, styling notes and labeled visual evidence. Private storage URLs, local paths, credentials, identity-reference files, generation prompts and arbitrary internal record fields are omitted. The selected photos themselves can depict the user. Images are sent as inline JPEG data URLs, as required by Decisions; they are never fetched through caller-provided URLs.

Three named choice questions judge suitability, evidence sufficiency and statement level for each candidate. Suitability choices map to ordinal weights `0, 1/3, 2/3, 1`; statement choices map to `0, 1/2, 1`. These probability-weighted values are ordinal heuristics, not calibrated quality percentages. The common rubric does not establish calibration across independent requests. IDs always come from server candidates. A refusal in any question, an unknown evidence answer or evidence confidence below `0.6` makes that candidate unknown.

Every eligible candidate is judged independently against the same fixed rubric: one candidate, its own visual evidence and three choice questions per request. Saved-look search includes that look's photo and garment cutouts; each swap request includes just one alternative plus the original photo and fixed pieces. Two requests run concurrently. There is no metadata shortlist, cohort promotion, reduction or shared finalist comparison in the runtime flow. All candidate judgments are merged in canonical ID order before local sorting. `candidateCount` reports all evaluated candidates and `scoringMethod` is `absolute`.

The selected implementation shares its one-candidate path with the evaluation runner. It removes dependence on the other candidates shown in a request, but does not establish that independently produced scores are calibrated or that a stable answer is correct. Style and saved-usage refinements operate on all eligible judgments. A failed, cancelled or timed-out candidate makes the whole search fail; it never publishes partial recommendations. Unknown evidence stays unknown. Cached completed judgments can be reused by a later explicit search, within the existing cache and freshness limits.

The existing display threshold requires sufficient evidence and suitability at least `0.5`. Local style preferences add up to `0.2`, and lower saved usage adds up to `0.15`, only for sorting already qualifying candidates. These values are uncalibrated product heuristics. Empty results remain an explicit no-match state. Errors preserve ordinary browsing.

## Optional image checks

Checks run only when the user clicks a button. Opening, polling, generation, crop approval and photo acceptance do not invoke Decisions automatically.

| Control and route | Evidence and judgments |
| --- | --- |
| **Check crop quality**; `POST /api/import/jobs/:id/preflight` | Original source and current detected crop; item completeness, selection clarity and visible detail |
| **Check photo against pieces**; `POST /api/outfits/jobs/:id/outfits/:outfitId/check` | Current review photo and every selected garment cutout; fidelity, visibility, anatomy, framing and extra pieces |

These routes accept an empty JSON object, require a current review state, and retain the existing origin, authentication and quota boundaries. They return `{ checks, status, cached, inputTokens, usage, model }` with independent `clear / concern / unknown` judgments. Per-question refusals and confidence below `0.75` become unknown. The combined status is `needs-review`, `uncertain` or `no-obvious-issues`; none is an acceptance decision.

### Preview outfit-review candidate

For the isolated, protected Preview environment, set the server-only `WARDROBE_DECISIONS_OUTFIT_RUBRIC_VERSION=2` alongside `WARDROBE_DECISIONS_ENABLED=1`. Selection additionally requires Vercel's `VERCEL_ENV=preview` and the existing `WARDROBE_PREVIEW_ENABLED=1`. The outfit config's `imageChecks.rubricVersion` and check responses report the selected version. Production, local development, and crop checks retain version 1 even if the candidate selector is present. Removing the selector returns Preview outfit checks to version 1.

The candidate asks all five questions together over the complete review photo and selected garment cutouts. It adds no neckline crops or automatic region selection. Its wording separates garment redesign from missing/hidden pieces and additional pieces, and names structural garment differences more explicitly. The confidence cutoff remains 0.75. Results are suggestions shown only after the existing manual Check photo against pieces action; they never approve, reject, regenerate, alter metadata or bypass fuller audits.

The small live synthetic comparison found preserved garment-detail answers when batching the questions, while extra close-ups introduced uncertainty. Earlier cases still contained high-confidence missed defects, including a duplicated hand and competing garments. Human review remains necessary, including after a no-obvious-issues result. These observations support guarded Preview use rather than automatic acceptance or audit triage.

During normal Preview use, preserve new cases privately and label their visible checks before evaluating a frozen candidate with the [evaluation runner](DECISIONS_EVALUATION.md). Include matching photos, subtle garment differences, anatomy failures and competing garments; keep derivatives in the same source family. Existing runtime usage records measure dispatch, failures, refusal outcomes and costs, but do not collect human accuracy labels or prove defect detection. No background quality checks or automatic paid retries are added.

Plain black/brown tights, invisible basics and plain neutral shoes when no shoe reference was supplied remain permitted by the outfit rubric. Identity matching, exact fit and hidden details remain human review responsibilities. Checks do not approve, reject, crop, regenerate, change metadata or persist advice in manifests. The existing detection API still supplies garment names, categories, colours, tags and bounding boxes.

## Bounds, freshness and cost controls

- Discovery makes at most one request per eligible candidate, with two requests concurrent. A shared deadline of 12 seconds includes image preparation, queue waiting and all candidate judgments. Each newly dispatched candidate reserves one text allowance. Larger collections need more request waves and may exceed the deadline; no automatic retry or partial result is returned. A later explicit search can reuse completed cached judgments.
- Source images are limited to 30 MiB and 50 million decoded pixels. Preparation rotates, flattens transparent cutouts onto white, strips metadata and resizes to at most 768 by 768 pixels. It preserves originals. Provider bodies are limited to 8 MiB; discovery metadata to 24,000 UTF-8 bytes. Image evidence is labeled explicitly.
- The shared client validates exact model, answer count/order/names/types, allowed choices and probability distributions. Provider errors are sanitized. Timeouts bound fetch and response parsing even if a transport ignores abort.
- A process cache holds up to 64 validated result sets for 15 minutes. Keys incorporate purpose/version, model, endpoint, a credential hash, metadata and actual prepared visual evidence. Duplicate in-flight calls share work; at most two distinct requests run per process. Excess work queues within its original timeout and uses the supplied writer-lease release hook while waiting; a stale revision after reacquisition frees the acquired slot without dispatching. Quota reservation and dispatch intent are serialized while provider work overlaps.
- A separate image-preparation cache holds up to 64 entries and 16 MiB. Hosted cache identity comes from a fresh immutable Blob lookup; mutable local files are hashed from bytes. Warm hosted repeats can reuse prepared images without downloading originals again. Cold starts can repeat work.
- Each actual hosted dispatch reserves one existing text API allowance. Cache hits and duplicate callers reserve none. Failed or uncertain dispatches count. `inputTokens` reports newly dispatched input usage, zero for cached work, or null when absent. Private `decision-usage/` records retain all supplied counters and distinguish provider, cache and shared callers; interruptions and missing counters remain unknown. Usage logging never persists visual advice or changes an approval.
- Provider work uses the existing lease-release hook when supplied, then checks current metadata, review state and image identities after reacquiring ownership. A changed/deleted image or record returns 409 instead of stale advice. Disconnected discovery requests stop subsequent candidates; already dispatched work may finish and populate the cache.

## Validation

```sh
node --test scripts/decisions.test.mjs scripts/outfit-discovery.test.mjs scripts/decision-review.test.mjs scripts/import-job-api.test.mjs
npm test
npm run check
npm run build:vercel
git diff --check
```

Use synthetic fixtures for contract, cache, quota, timeout, refusal, origin, deletion/replacement and review-state tests. Browser verification should cover image checks, search, refinements without another request, swaps, empty/error states and phone widths.

Before relying on the model judgments, compare live outputs with human-reviewed representative cases. Measure missed defects, unnecessary flags, ranking usefulness, input usage and latency. Keep uncertain cases visible and human acceptance in place; do not skip fuller audits or enable automatic rejection based only on fixture tests.

The [Decisions evaluation runner](DECISIONS_EVALUATION.md) prepares a private 25-case scaffold, shares the production image-review rubric, freezes run inputs and human labels, replays calibration thresholds offline, and reports complete usage with rate-based cost ranges. `npm run decisions:eval` is offline unless `--run` and a call cap are explicitly supplied. Runtime usage can be summarized with `npm run decisions:usage -- --target local|cloud`.

### Batch sensitivity

The separate [discovery sensitivity runner](../scripts/discovery-sensitivity-runner.mjs) evaluates the historical batch/finalist discovery baseline against a private frozen collection. That baseline is retained for experiments and is not the runtime discovery method. It measures screening-score changes, winner agreement, top-three overlap, omitted finalists and final ranking stability. Identical layouts repeat to estimate ordinary model variation. Reversed batch order preserves membership even when the last batch is partial; seeded shuffles change membership and order. Results are stability measurements, not human relevance labels or proof of recommendation quality.

Prepare an offline plan, which requires more than 12 eligible saved looks and sends no images:

```sh
node scripts/discovery-sensitivity-runner.mjs \
  --data-dir PRIVATE_SNAPSHOT --out PRIVATE_PLAN_DIR \
  --brief "A relaxed everyday outfit" --brief "An understated dinner outfit"
```

Review `maximumProviderCalls`, then use a fresh private run directory and the approved cap for a separately authorized paid run:

```sh
node --env-file=.env scripts/discovery-sensitivity-runner.mjs \
  --data-dir PRIVATE_SNAPSHOT --out PRIVATE_RUN_DIR \
  --brief "A relaxed everyday outfit" --brief "An understated dinner outfit" \
  --run --max-calls APPROVED_CALL_CAP
```

The runner bypasses provider-result caches, reserves calls in an exclusive durable `run.json` before dispatch, writes sanitized usage records and reports latency and known/unknown costs. Existing ledgers cannot be overwritten or resumed; failed/uncertain trials stop the run without retries, and unattempted trials remain explicit. It reads an already available local snapshot and does not download production data or change garments, saved looks or approvals.

An initial 2026-10-08 live run used 20 saved looks, three briefs, four layouts and two repeats (72 calls; no failures). Identical-layout screening scores repeated exactly, but shuffled membership/order moved individual scores by up to `0.49` and changed the screening winner in five of six comparisons. The shared final pass alone did not improve winner/top-three stability on that sample. Reversing batch order preserved finalists but changed their final scores; canonical finalist ordering was added afterward and checked offline against those real cohorts. The live run did not evaluate that subsequent ordering change. The sample has no human ranking labels and establishes sensitivity, not which recommendations are better. Keep the private run ledger and report separate from source control.

### Human accuracy comparison

The [three-method runner](../scripts/discovery-comparison-runner.mjs) compares independent absolute judging, the frozen screening/finalist baseline, and shuffled-cohort consensus on the same private frozen examples. Prepare the human review before running any model judgments:

```sh
node scripts/discovery-comparison-runner.mjs \
  --init PRIVATE_LABELS.json --data-dir PRIVATE_SNAPSHOT \
  --brief "A relaxed everyday outfit" \
  --brief "An understated dinner outfit" --brief "A bold evening outfit"
node scripts/discovery-comparison-review.mjs PRIVATE_LABELS.json
```

The loopback review shows saved photos and the same garment references used by the models, with no model results. Grade every candidate as unsuitable (0), partly suitable (1), good (2), excellent (3), or unknown. Mark one to three preferred good/excellent picks per brief, or explicitly mark none suitable. Save progress is reversible; Finish review confirms the complete labels. The runner rejects unfinished labels, protocol edits and changed snapshot metadata or candidate membership. Human labels are retained for offline scoring and never included in provider requests.

Method settings are frozen in `COMPARISON_PROTOCOL` before labeling:

| Method | Work and variants |
| --- | --- |
| Absolute | One candidate per request, judged against the same fixed rubric; scores sorted afterward. One layout, two repeats. |
| Current (frozen baseline) | Historical screening and shared final comparison, with original and two seeded initial layouts; two repeats each. |
| Shuffled consensus | Three shuffled screenings nominate within-cohort finalists. Nomination count, then normalized within-cohort rank, choose up to 12 for the same shared final comparison. Two seed ensembles, two repeats each. Raw scores from different cohorts are never averaged. |

All methods share the visual preparation, rubric, evidence/confidence gates, suitability cutoff, canonical finalist order and two-request concurrency limit. The experiment allows a common 60-second trial deadline so independent judging can finish; each provider request remains capped at 12 seconds. It separately reports whether each trial fits the product's 12-second overall deadline. This experiment changes no production recommendation logic.

For the prepared 20-look, three-brief review, there are 60 human grades, 36 trials and at most 258 paid provider calls. Offline planning requires no credentials or paid calls:

```sh
node scripts/discovery-comparison-runner.mjs --manifest PRIVATE_LABELS.json
# After human review and authorization of the paid run:
node --env-file=.env scripts/discovery-comparison-runner.mjs \
  --manifest PRIVATE_LABELS.json --run --out FRESH_PRIVATE_RUN_DIR \
  --max-calls APPROVED_CALL_CAP
```

Results report graded nDCG@3, precision@3, preferred-pick recall and winner agreement separately from repeat/layout stability. Unknown human labels are omitted from relevance metrics and their coverage is reported; no-suitable agreement is measured for explicit no-match cases. Cases receive equal aggregate weight despite different variant counts. Failures, unattempted trials, latency, provider usage and estimated costs remain explicit. The runner bypasses result caches, reserves calls in an exclusive durable ledger, stops on the first failed trial and makes no automatic retries. Use this small set to compare methods, not to tune settings and then claim held-out accuracy.

After a stopped run, `--continue-unattempted-from PRIVATE_RUN_DIR/run.json` prepares the remaining plan offline or runs it with the usual `--run --out FRESH_PRIVATE_RUN_DIR --max-calls TOTAL_CAP` flags. It requires identical confirmed labels, model, frozen protocol and deadline, and a finished prior ledger. Every previously attempted trial is skipped, including failures; earlier ledgers remain unchanged. The new ledger carries the complete history and the original failure remains in the combined report. The cap covers all reservations across both runs, not an additional allowance. This continues unattempted trials without retrying failed trials or tuning the methods.

### Selected absolute-scoring candidate

The 2026-10-08 human-labeled comparison used the same 20 saved looks under three briefs, with 60 human grades and preferred picks finalized before any model results. All 36 planned trials were attempted: 35 succeeded, one screening trial failed with provider HTTP 504 and was not retried. A fresh ledger continued only unattempted trials, keeping 257 calls within the 258-call cap. The failed call returned no usage; known-usage cost was estimated at $0.43–$0.86, with the actual invoice unknown. Raw photographs, labels and ledgers remain private and outside source control.

| Method | Case-weighted nDCG@3 | Preferred-pick recall@3 | Mean latency |
| --- | ---: | ---: | ---: |
| Independent absolute | 0.877 | 66.7% | 7.14 s |
| Screening/finalist baseline | 0.698 | 37.8% | 4.40 s |
| Shuffled consensus | 0.748 | 50.0% | 8.98 s |

These accuracy and latency averages include successful trials; the baseline has five rather than six successful everyday trials. nDCG@3 measures ordering against graded relevance (1 is ideal), not a probability of correctness. Identical-input repeats had identical scores for all methods. Consensus preserved its winner across the two ensembles for every brief, yet two winners were not preferred human picks. Consensus had the strongest dinner result; absolute judging led overall and for the other two briefs. All successful trials fit the 12-second deadline on this local 20-look collection.

Absolute judging is selected for the draft implementation, with the evaluated rubric and concurrency bound unchanged. Three briefs from one collection do not establish general quality, cross-request calibration or latency for larger wardrobes. Continue measuring these separately; keep uncertain/no-match behavior and manual control in place.
