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

Three named choice questions judge suitability, evidence sufficiency and statement level for each candidate. Suitability choices map to ordinal weights `0, 1/3, 2/3, 1`; statement choices map to `0, 1/2, 1`. Probability-weighted values preserve comparable continuous rankings without relying on undocumented score-scale behavior. IDs always come from server candidates. A refusal in any question, an unknown evidence answer or evidence confidence below `0.6` makes that candidate unknown.

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

- Discovery covers every candidate in batches of 12. A shared deadline of 12 seconds includes image preparation and provider work. A later failure can reuse completed cached batches on an explicit retry; no automatic paid retries occur.
- Source images are limited to 30 MiB and 50 million decoded pixels. Preparation rotates, flattens transparent cutouts onto white, strips metadata and resizes to at most 768 by 768 pixels. It preserves originals. Provider bodies are limited to 8 MiB; discovery metadata to 24,000 UTF-8 bytes. Image evidence is labeled explicitly.
- The shared client validates exact model, answer count/order/names/types, allowed choices and probability distributions. Provider errors are sanitized. Timeouts bound fetch and response parsing even if a transport ignores abort.
- A process cache holds up to 64 validated result sets for 15 minutes. Keys incorporate purpose/version, model, endpoint, a credential hash, metadata and actual prepared visual evidence. Duplicate in-flight calls share work; at most two distinct requests run per process.
- A separate image-preparation cache holds up to 64 entries and 16 MiB. Hosted cache identity comes from a fresh immutable Blob lookup; mutable local files are hashed from bytes. Warm hosted repeats can reuse prepared images without downloading originals again. Cold starts can repeat work.
- Each actual hosted dispatch reserves one existing text API allowance. Cache hits and duplicate callers reserve none. Failed or uncertain dispatches count. `inputTokens` reports newly dispatched input usage, zero for cached work, or null when absent. Private `decision-usage/` records retain all supplied counters and distinguish provider, cache and shared callers; interruptions and missing counters remain unknown. Usage logging never persists visual advice or changes an approval.
- Provider work uses the existing lease-release hook when supplied, then checks current metadata, review state and image identities after reacquiring ownership. A changed/deleted image or record returns 409 instead of stale advice. Disconnected discovery requests stop subsequent batches; already dispatched work may finish and populate the cache.

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
