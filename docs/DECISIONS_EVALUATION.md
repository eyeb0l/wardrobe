# Evaluating Decisions image checks

The evaluation runner tests the same questions, image preparation and confidence rule used by **Check photo against pieces** and **Check crop quality**. It starts offline and never generates images, accepts a photograph, changes a wardrobe record or invents human labels.

The initial dataset has 25 selection hints: 20 outfit cases covering faithful results, changed garment details, missing/hidden pieces, anatomy, framing, ambiguity and permitted plain tights; five crop cases covering completeness, selection and visible detail. These are planned cases, not 25 reviewed examples. The template's labels are all `null` and its review status is false.

## Prepare a private dataset

```sh
npm run decisions:eval -- --init data/decisions-evaluation/dataset
```

This creates `suite.json` and an `images/` directory without API access. It refuses to overwrite an existing suite. Keep datasets, images, annotations and run outputs under ignored `data/` or another private directory, never in Git. Directories are created with mode 0700 and evaluation files with mode 0600.

Use representative frozen copies from the intended wardrobe, with current garment cutouts. For hosted data, use a completed private snapshot; do not evaluate a stale local collection as if it were the hosted wardrobe. The runner deliberately accepts only contained local image files. It never connects to the collection or accepts remote URLs or identity-reference inputs.

For each case, assign a `family` based on the underlying source outfit or photograph. Variations of the same source must use the same family and stay in one split. The scaffold's families are placeholders until real images are selected. Calibration is used to compare thresholds; confirmation is held back and reported only at the frozen production threshold. Label the examples before seeing model output.

An outfit case looks like this:

```json
{
  "id": "outfit-example",
  "family": "source-outfit-one",
  "kind": "outfit-review",
  "split": "calibration",
  "evidence": [
    { "label": "result", "file": "images/outfit-example.png" },
    { "label": "garment_0", "file": "images/top-reference.png" },
    { "label": "garment_1", "file": "images/bottom-reference.png" }
  ],
  "metadata": {
    "garments": [
      { "id": "top-reference", "name": "Blue blouse", "part": "upperbody" },
      { "id": "bottom-reference", "name": "Black trousers", "part": "lowerbody" }
    ]
  },
  "expected": {
    "fidelity": "concern",
    "visibility": "clear",
    "anatomy": "clear",
    "composition": "clear",
    "extras": "clear"
  },
  "review": { "humanReviewed": true, "reviewedAt": "2026-10-06T12:00:00Z" }
}
```

The example illustrates the schema; its labels are not evidence about any real photograph. Crop cases use labels `source` and `target`, metadata `{ category, name }`, and expected check IDs `complete`, `isolated` and `detail`. Every independent check needs `clear`, `concern` or `unknown`. Use `unknown` when the visual evidence cannot support a judgment, rather than treating obscured detail as correct or defective. Human review dates are required for a live run.

Outfit evidence must contain the result and one cutout per metadata garment, labeled `garment_0`, `garment_1`, etc. Bounded garment metadata accepts `id`, `name`, `part`, `color`, `tags` and `outerConstruction`; reference labels are derived from order. Ground truth, review status, case/family names, selection hints and notes are never sent to the provider. The runner rejects arbitrary metadata fields and paths escaping the dataset, including symlinks. PNG, JPEG and WebP sources use the production 30 MiB/50-million-pixel limits and 768-pixel JPEG preparation; each request is at most 8 MiB and the prepared suite at most 64 MiB.

## Review an offline plan

```sh
npm run decisions:eval -- \
  --manifest data/decisions-evaluation/dataset/suite.json \
  --out data/decisions-evaluation/plans/initial
```

No key or network access is needed. The output lists pending images/labels and writes `ledger.json`, `report.json` and `report.md`. Cases with supplied images are decoded and hashed, so missing, corrupt or changed images fail before any provider dispatch. Draft cases without images remain pending and cannot be mistaken for evaluated successes.

Use a new run directory after editing a plan's images, metadata, labels or case selection. A frozen run binds those values, prepared image hashes, model, endpoint hash, rubric, production threshold and pricing. The ledger omits photograph bytes, paths, garment metadata, API credentials and provider error bodies. Retain the separate source dataset for reproducibility.

## Run an explicitly bounded live evaluation

Live runs send the selected images and garment metadata to OpenAI and use paid API credits. Reuse the existing key through the environment or Node's `--env-file`; do not copy it into the manifest or run output.

```sh
node --env-file=.env scripts/decision-evaluation-runner.mjs \
  --manifest data/decisions-evaluation/dataset/suite.json \
  --out data/decisions-evaluation/runs/calibration-01 \
  --split calibration --run --max-calls 17
```

`--run` and `--max-calls` are required. The limit is 1–100 requests and applies to the whole frozen run across restarts. Select named cases with `--cases id-one,id-two`. All selected cases must have complete human labels, a review date and evidence. The CLI's explicit live command is separate from deciding to prepare an evaluation; running this document's preparation steps does not call the API.

Calls run sequentially, bypass the application result cache, share the production validation and use a 12-second request deadline. There are no automatic retries. Intent is persisted and synced before dispatch; successful, refused, failed and interrupted attempts are never sent again on resume. An interrupted dispatch keeps unknown usage and consumes its call allowance. Provider/transport/validation failures stop the current batch for inspection. A deliberate later resume can evaluate remaining cases, while preserving prior failed attempts. A lock prevents concurrent runners; verify the previous process stopped before manually clearing a leftover `.runner-lock`. Never delete a ledger to resume.

The call limit is a request limit, **not a guaranteed dollar cap**. Request usage becomes available after dispatch. Approve a bounded case set and spending allowance before executing paid calls, then reconcile measured usage with the provider account. There is no general token-count endpoint or output cap asserted for Decisions by this runner.

## Read the report

Reports contain per-check confusion matrices and denominator counts, plus each case's independent predictions. They distinguish:

- **Missed defects:** human `concern` returned as `clear`.
- **False warnings:** human `clear` returned as `concern`.
- **Unsupported clearance:** human `unknown` returned as `clear`.
- **Uncertainty/refusals:** routed to human review, retained separately from correct classifications and technical failures.
- **Unevaluated checks:** pending or failed requests, excluded from scored denominators but shown in coverage counts.

The calibration report replays thresholds 0.50, 0.60, the frozen production threshold (currently 0.75), 0.85 and 0.90 using saved validated answers; no additional API calls are needed. Confirmation stays at the frozen production threshold. Repeating the same runner command without `--run` regenerates reports offline, retains historical usage and reports zero **new** provider calls. Each cohort reports independent family counts and flags fewer than 30 families as a small sample. The 25-case pilot is for initial calibration, not a statistically strong assurance of quality.

Latency includes request wall time, measured image preparation and their sum. The combined value is not a hosted end-to-end benchmark. p95 is exploratory at this sample size. Include useful successes, subtle failures and ambiguous examples; do not select only obvious errors or tune on the confirmation set. Inspect individual mistakes alongside the aggregate report.

## Complete usage and cost accounting

The shared client retains input, cached-input, cache-write, output, reasoning, total-token and optional compute-unit counters through an allowlist. Missing, negative or inconsistent fields stay `null`. Billing counters from an invalid answer are retained; HTTP/timeout failures without counters remain unknown.

Runtime app calls also write private records under `decision-usage/` in the selected local/cloud store. Records capture purpose, model/provider, request hash, dispatch intent/outcome, request ID, duration, image/question counts, refusal count and usage. Cache and shared callers link to the producer attempt and contribute zero additional provider usage. Evidence, prompts, names, image paths/URLs, key values, arbitrary provider fields and error bodies are omitted. Persistence failures cannot hide a result or cause a retry, but may leave reporting coverage incomplete. This is separate from generation/refusal telemetry and does not change saved jobs or approvals.

```sh
npm run decisions:usage -- --target local
# With the existing private cloud storage environment loaded:
npm run decisions:usage -- --target cloud
```

The report groups by purpose/model/provider. Unknown counters, unfinished intents and failed calls remain visible. Empty history is not proof of no spending if logging was unavailable.

The [official Decisions guide](https://developers.openai.com/api/docs/guides/decisions#pricing-and-availability), verified 2026-10-06, gives `gpt-6-luna` input pricing of $0.10 per million with no separate cache-read, cache-write or output charges. The [pricing page](https://developers.openai.com/api/docs/pricing) lists long-context input at $0.20 per million. The built-in estimate retains that short/long range rather than guessing the context threshold. It applies only to the standard global OpenAI endpoint/model; custom providers/models remain unpriced. Regional premiums require an explicit applicable pricing record. Price snapshots may become stale; verify before a paid run. Estimates use reported input counts and are not invoices.

`--pricing pricing.json` freezes explicit alternative rates. It requires version 1, exact `model`, `verifiedAt`, official `source` and a `basis`: `input-only` with input/maximum-input rates; `tokens` with input/cached-input/cache-write/output rates and a `maxInputTokens` context bound; or `compute-units` with a per-unit rate. Token rates are USD per million, compute-unit rates USD per unit. Missing usage, out-of-bound token pricing and unpriced models contribute unknown cost, never invented zero spend. Rate records are operator-supplied assumptions and do not verify account billing or access.

After the pilot, calibrate prompts/thresholds and verify them on new held-back families. Keep human acceptance and fuller audits available. Audit triage should initially run beside the fuller evaluator so missed defects can be measured before any audit is skipped. This evaluation does not enable production, grant automatic acceptance or claim accuracy from synthetic fixture tests.

## Verification

```sh
node --test scripts/decision-evaluation.test.mjs scripts/decision-usage.test.mjs scripts/decisions.test.mjs scripts/decision-review.test.mjs
npm test
npm run build:vercel
git diff --check
```

Tests use synthetic image bytes and mocked responses to verify request parity, label isolation, report arithmetic, uncertainty, refusals, pricing, call caps, cache bypass, interruption/resume, source drift, path containment, storage outages and privacy. They make no live API requests and establish no visual-quality result.
