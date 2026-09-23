# Next vision evaluation: real retailer images and measured API cost

Historical plan frozen on 2026-09-20, before the GPT-6 migration. The user authorized reuse of their existing API key and approved a **US$10 total API usage cap**, including retries. Execution is recorded in [the results report](vision-benchmark-api-results.md). No production model change was part of this evaluation; see the [current model configuration](model-migration.md).

## Decision to make

Choose the cheapest model/effort configuration that produces acceptable results for the app's actual vision tasks, with quality, failure rate and latency reported separately. Keep Luna/medium as the baseline. A larger model may earn its cost on only one task, so report per-task results as well as the existing weighted overall score (detection 35%, outfits 30%, shopping 20%, scenes 10%, accessories 5%).

The Codex pilot had ceiling effects, historical generated/cutout images, one run per configuration and one model reviewer. Its fine score differences do not establish a winner. This evaluation replaces agent sessions with independent Responses API requests and a new frozen dataset.

## Dataset target: 60 cases

| Task | Cases | Main coverage |
|---|---:|---|
| Garment identification | 30 | 24 real retailer images from 12 product families, usually two different views each; six additional stress/negative cases |
| Outfit curation | 10 | Frozen current owned inventory, full-size contact-sheet set, varied briefs, excluded pairs, plausible layers and ambiguous openings |
| Shopping assessment | 10 | New retailer candidates: useful gaps, near-duplicates, plausible but weak additions, ambiguous and unclear examples |
| Scene planning | 5 | Different garments and recent-scene histories; garment visibility, colour fidelity and genuinely different settings |
| Accessory suggestions | 5 | Actual saved outfit photos with different necklines, patterns, formality and already-worn accessories |

Target at least four retailers and all six app garment categories. Potential sources include Abercrombie, COS, ARKET, Next and M&S; inclusion depends on being able to capture a useful public image. Avoid one retailer dominating the set. Do not select only polished isolated photos: mix plain product shots, worn outfits, overlapping garments, cropped/detail shots, dark-on-dark construction, white-on-white detail, sheer/lace fabrics, asymmetry, shoe pairs and small accessories. Stress cases include screenshots with UI/text, identifiable partial garments and images containing no identifiable wearable item. Use naturally occurring cases where possible; label any constructed adversarial examples separately.

For importer detection, annotate every independently identifiable visible wearable item required by the production prompt, not just the product for sale. A model photograph of a cardigan may also require trousers, shoes and jewelry; the catalogue title is not a complete answer key. For shopping, annotate the indicated candidate according to the actual candidate-selection rules.

For paired views, send each view as a separate detection request. Do not give the detector a second image if the app only sends one. Freeze the exact variant, original page and asset URL, capture timestamp, original bytes, post-app-preprocessing bytes and SHA-256 hashes. Use neutral fixture filenames. Keep the dataset private. Refresh the hosted wardrobe through the existing read-only snapshot workflow for curation/shopping; it must not be replaced with the old local library.

Use the retailer's actual image asset for image-only cases, without titles/descriptions in the request. Website screenshots form a separately reported stratum because visible product text can legitimately help recognition. Keep product descriptions available to annotators but hidden from image-only participants. Do not score a hidden zip, unseen rear detail or fibre composition as something the model should infer. Preserve ambiguity with acceptable alternatives or an uncertainty label.

Access check: the [Abercrombie rib half-sleeve cardigan listing](https://www.abercrombie.com/shop/us/p/100-cotton-rib-half-sleeve-cardigan-63374319?categoryId=89155&faceout=model&gridProductPosition=21&pagefm=navigation-grid&prodvm=navigation-grid&seq=01) exposed model-image links and a button-front/V-neck description when opened. Region redirection changed the displayed variant, demonstrating why the captured variant must be recorded. Some other search results returned moved or unavailable pages. This is a source candidate, not an annotated or downloaded fixture yet.

## Ground truth and splits

Prepare item labels and bounding boxes from the frozen image before seeing candidate answers. Use two independent visual annotation passes and log disagreements; model-assisted agreement is not human ground truth. Review ambiguous cases directly, and ask the user for taste judgments only where they materially determine acceptability. Reject or mark uncertain labels that cannot be resolved from visible evidence. Product descriptions can verify which garment is listed but cannot override what is actually visible.

For box scoring, match predicted and labelled items one-to-one by category and overlap, penalize extra/missing detections, and report crop coverage as well as IoU. A high average must not conceal a box that cuts off a sleeve or waistband. Exact hex equality is not a sensible colour target; use perceptual/semantic tolerances. Do not equate a highlight with a second garment colour.

Freeze task-specific acceptance rules before running. Require valid output, no critical factual/selection error and usable task-specific results. Examples: correct item set and usable crops; exact distinct feasible outfit pairs; no invented opening; a shopping verdict with valid owned-only pairings and no claimed fit certainty. Record lesser quality deductions separately. Avoid defining acceptance after seeing which model wins.

Split by product family and fixture context, never by image alone. A product's alternate view, colourway, near-duplicate or appearance in a shopping case must not cross screening and confirmation sets. Different briefs on the same wardrobe context are correlated; account for that in analysis. Keep initial pilot cases out of the new final score.

Screening set: 10 cases (4 detection, 2 curation, 2 shopping, 1 scene, 1 accessories). Confirmation set: the remaining 50 (26, 8, 8, 4, 4 respectively). The shared frozen wardrobe is a constant app context, not an independent statistical sample. Retailer/product diversity, especially the number of product families, limits generalization.

## Configurations and run order

Screen these five configurations, with two independent calls per screening case:

- gpt-5.6-luna / low
- gpt-5.6-luna / medium (baseline)
- gpt-5.6-luna / high
- gpt-5.6-terra / low
- gpt-5.6-sol / low

This targets 100 screening calls. Start with two representative screening cases across the five configurations (10 calls, included in that count), to check access, usage and cost. Finalize common per-task output limits and budget estimates before the scored run; if this calibration changes request settings, exclude those initial answers and count replacements as additional paid calls within the same cap. No silent model substitutions if an ID or effort is unavailable.

Advance Luna/medium and the strongest useful challenger to the 50 unseen cases, targeting two independent calls per case/configuration: 200 further calls. Prefer a challenger that offers a measurable cost saving at acceptable quality, or a meaningful quality gain for extra cost; report both dimensions rather than selecting by quality/token-price alone. Freeze the chosen challenger and decision rule before opening confirmation results. High-effort Terra/Sol and medium-effort Terra/Sol are outside this budgeted shortlist; conclusions must not claim they were ruled out by API evidence.

Randomize/interleave matched cases/configurations with bounded concurrency. Each call has the same case-specific prompt, images, schema and context, and no conversation or previous response. No participant web browsing or tools. Preserve first answers, refusals, incomplete outputs and timeouts; no manual correction before scoring. Repeated calls are not new independent garments.

## Replaying the app

Capture request payloads through the existing production request-building paths with an injected/mock transport or extracted shared pure builders. Do not maintain separately rewritten prompts. Validate payload parity before a live call. Stop at the vision response; do not run image generation, publish garments/outfits or mutate the hosted collection.

Use actual upload preprocessing, not a convenient benchmark-only resize. Preserve omitted image detail for detection/scenes and high detail for curation/accessories/shopping. Use the production schemas, reference-image selection, inventory labels, recent-setting context, excluded-pair rules and relevant timeouts, including the 30-second scene limit. A long-running result that misses the app's deadline is an operational failure even if its eventual text is good.

Document evaluation-only differences: explicit effort, standard service tier, bounded output tokens and store:false. Validate that these are supported. Set the same output allowance within each task across models; insufficient allowances can unfairly truncate higher-effort answers. The API's max_output_tokens includes reasoning and visible output, and responses expose usage and returned service tier. [Responses reference](https://developers.openai.com/api/reference/cli/resources/responses/methods/create)

Keep the app's ordinary cache behavior observable; record cache reads/writes rather than assuming equal cache hits. Report observed cost and a separately labelled standardized cache scenario if needed. Do not use Batch latency as an estimate of interactive app latency.

## US$10 spending control

Planning allocation: about $3 for screening, $6 for confirmation, $1 for failures/reconciliation. These are allocation targets, not a promise that all 300 calls fit. The $10 cap governs every paid request, including calibration, retries and any API-based grading. Prefer Codex-based blinded reviewers so scoring does not use this API budget; Codex still consumes account usage.

Before sending each request, reserve a conservative upper bound for that request's input, cache-write and maximum output cost under verified current rates. Include outstanding requests in the ledger. Keep uncertain timed-out request charges reserved until reconciled; never assume cancellation makes a request free. Do not retry an uncertain paid call automatically. Apply bounded output limits and concurrency; stop before admitting a request that could exceed the cap. If a reliable cost bound cannot be established, stop live execution until it can.

Record actual usage-derived charges as responses complete; reasoning tokens are already included in output totals and must not be charged twice. Log cached tokens, cache writes where exposed, service tier, retries and incomplete results. Treat any unexposed billable component as uncertainty requiring conservative reservation. Do not print the key or write it into fixture/result files. Use the existing authorized key after a silent presence/configuration check; no new key is requested. The cap refers to USD API usage charges, before any account-level taxes or currency conversion.

If measured costs exceed the initial forecast, preserve balanced matched blocks and stop at the cap. Do not selectively drop poor answers, count budget exhaustion as a model failure, or declare a complete winner from an incomplete/unbalanced comparison. Report actual spend, remaining allowance, completed coverage and what remains unresolved. Increasing the cap requires the user to change it.

## Scoring and final decision

Report schema/task acceptance rate, critical errors, detection precision/recall and crop quality, task-specific quality, observed cost per acceptable answer, and median/tail request latency. Failed attempts stay in the cost numerator; only acceptable completed answers enter the denominator. Also show cost per attempted request. Distinguish model-response latency from end-to-end preprocessing/storage time. Do not manufacture acceptability by averaging away a serious mistake.

Use blinded pairwise review for subjective outputs, randomized left/right order, ties allowed and verbosity not rewarded. A second independent reviewer checks close/disputed judgments. If reviewers differ on taste, show a small set of representative pairs to the user. Show concrete errors alongside aggregates.

Bootstrap paired differences by underlying product/case family, retaining all views/repeats in that cluster. Report wide intervals honestly, and describe p95 as exploratory at small sample sizes. The previous 94–100 scores are not calibrated probabilities and should not be compared directly with the harder new set. [Evaluation guidance](https://developers.openai.com/api/docs/guides/evaluation-best-practices)

Choose the lowest observed cost per acceptable result among configurations meeting the predeclared quality and operational requirements. If the confirmation set is inconclusive, retain the baseline and report the uncertainty. If a premium model helps only curation/shopping, propose task-specific routing with its measured cost impact. Do not change production as part of this evaluation.

## Execution deliverables

1. Frozen private images, source/variant manifest, annotated contact sheets, adjudicated labels and split assignments.
2. Request-parity checks, offline cost-ledger tests and a dry-run call/budget manifest.
3. Small calibration batch, then balanced screening and confirmation within the approved cap.
4. Raw responses, usage/cost ledger, blinded comparisons, error gallery and per-task cost/quality/latency report.

This document preserves the planned protocol. The results report records actual coverage, execution changes, measured spending and limitations.
