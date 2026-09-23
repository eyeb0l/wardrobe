# Wardrobe vision API evaluation

**Historical GPT-5.6 results (2026-09-20).** This report covers the initial evaluation. Its recommendation applies to the compared GPT-5.6 configurations; the current app defaults to GPT-6 Luna and offers a manual GPT-6 Sol detection retry. See [model migration](model-migration.md) and the [detection-rescue follow-up](chroma-cleanup-and-detection-rescue.md) for the later Terra medium results and cumulative spending.

Completed on 2026-09-20: 300 planned API attempts, 292 returned responses, eight unresolved transport failures, and no outstanding active calls or ungraded returned answers. Approved API cap: US$10 including failures. Recorded usage is **$1.626180137**, with a conservative total upper bound of **$1.759296937** including every uncertain call. At this phase’s close, **$8.240703063** of the cap remained; production settings and the hosted collection were unchanged.

**Recommendation at the time: retain `gpt-5.6-luna` at its effective medium effort.** High effort improved the continuous quality score slightly, but did not improve usable-answer acceptance and was more expensive and slower. This was the best-supported value choice among the tested configurations, not proof that all other model/effort combinations are inferior.

At the time of this evaluation, the app selected `gpt-5.6-luna` and omitted `reasoning.effort` in its detection, curation, shopping, scene and accessory request builders. OpenAI documented medium as that Luna model's default; the evaluation made medium explicit. [Historical model documentation](https://developers.openai.com/api/docs/models/gpt-5.6-luna)

The private reproducibility bundle is `data/vision-eval-api-2026-09-20/`. Source images, wardrobe/person images, labels and raw responses stay in this ignored, access-restricted directory.

## Protocol and evidence

- Frozen suite: `preparation/frozen-v2/suite.json`; 60 cases: 30 detection, 10 curation, 10 shopping, 5 scene, 5 accessory.
- Thirty public retailer images: 12 garment families with two views each, 3 natural cropped/detail stress cases, 3 food negatives. Four retailers: ARKET, Abercrombie, Next and M&S.
- Fresh read-only cloud snapshot: 67 visible owned items, 16 accepted outfits, 2 person references. Curation uses all 63 eligible non-dress items in six contact sheets; shopping uses all 67.
- Exact production middleware request capture and actual browser upload preprocessing; all 60 payloads reconstruct, 40 original hashes, 63 input-image hashes and 7 production-source hashes verify. Prompts and schemas are not rewritten for the models.
- Explicit model effort, standard service tier, store:false and common per-task output caps are evaluation-only overrides. Detection/curation/shopping caps: 16,384 output tokens; scenes/accessories: 8,192, including reasoning. App deadlines retained, including 30-second scene deadline.
- Two independent model-assisted visual annotation passes, followed by root adjudication before paid outputs. Alternative labels preserved for genuine ambiguity. These are not independently verified human labels.
- Subjective answers graded with answer-to-model identities, effort, cost and latency hidden. The root grader and shopping reviewer saw aggregate screening rankings before some later anonymous grading; answer mappings remained hidden. Mechanical validation checks schema, item geometry, inventory ownership, distinct pairs, role counts and production rejection conditions. Output errors remain in the cost numerator.
- Frozen weighting: detection35%, curation30%, shopping20%, scenes10%, accessories5%. Acceptance requires no serious error, mean subjective criterion >=3/4 and each >=2/4. Detection adds IoU>=0.5, visible-box coverage>=85% for every required item, exact required item set and clean classification. Quality score is separate from acceptance.

## Screening

All 100 planned responses completed. Usage-derived API cost: **$1.097154986**. Calibration's 10 calls were included; there were no retries or altered prompts.

| Configuration | Accepted calls | Weighted acceptance | Quality /100 | Total API cost | Cost / accepted answer | Median response |
|---|---:|---:|---:|---:|---:|---:|
| Luna low | 11/20 | 56.9% | 90.6 | $0.03301 | $0.00300 | 7.9s |
| Luna medium | 13/20 | 69.4% | 93.2 | $0.03878 | $0.00298 | 10.4s |
| Luna high | 14/20 | 70.6% | 92.3 | $0.04951 | $0.00354 | 14.1s |
| Terra low | 13/20 | 63.1% | 90.8 | $0.32944 | $0.02534 | 10.9s |
| Sol low | 13/20 | 66.3% | 93.0 | $0.64641 | $0.04972 | 12.1s |

This small screening set selects a challenger; it does not establish a universal model ranking. Under the predeclared rule, Luna/high advances against baseline Luna/medium: it has the highest challenger weighted acceptance, and is cheaper than the quality-comparable tied Sol/low. Selection was written before confirmation outputs in `confirmation-selection.json`.

## Confirmation

The remaining 50 unseen cases were attempted twice per configuration: **200 matched calls**, including all eight transport failures as unsuccessful outcomes. All 50 cases have both scheduled repeats in the primary analysis; no failures or missing charges were discarded.

| Held-out result | Luna medium | Luna high |
|---|---:|---:|
| Accepted calls | 62/100 | 61/100 |
| Weighted acceptance | 69.81% | 69.76% |
| Weighted quality /100 | 88.83 | 91.08 |
| Total API cost, including uncertain-charge bounds | $0.21698–$0.28353 | $0.31205–$0.37861 |
| Cost per accepted answer, including all attempts | $0.00350–$0.00457 | $0.00512–$0.00621 |
| Median response time | 17.2s | 23.0s |
| Exploratory p95 response time | 57.3s | 70.7s |

Weighted acceptance gives detection and outfit accuracy the agreed priority; it is distinct from the unweighted accepted-call count. Quality is a continuous rubric score and does not override serious errors. Costs include failed calls, with full possible charges retained where usage was not returned.

High minus medium acceptance was **−0.05 percentage points**, with a paired-family bootstrap interval of **−6.91 to +9.92 points**. High's quality score improved **2.25/100** (conditional interval +0.98 to +4.24). The premium-switch rule required at least +5 acceptance points and an acceptance lower bound above zero; both conditions failed. Detection regressed 1.92 points and curation improved 6.25 points, so the detection/curation guardrail itself passed. Retain medium; the acceptance comparison is inconclusive rather than a proven capability win for either effort.

The bootstrap used 10,000 seeded family draws; one draw lacked shopping cases and was discarded, leaving 9,999. It is conditional on the observed contexts and shared wardrobe, and does not estimate variability across wardrobes or fully model within-context generation noise. These exploratory intervals are not universal confidence guarantees.

| Task | Luna medium accepted | Luna high accepted | Interpretation |
|---|---:|---:|---|
| Detection | 22/52 (42.3%) | 21/52 (40.4%) | Strict whole-image item and crop acceptance remains the weakest area. |
| Outfit curation | 14/16 (87.5%) | 15/16 (93.8%) | High gained one accepted call; too small to justify routing by itself. |
| Shopping | 12/16 (75.0%) | 11/16 (68.8%) | Person-reference confusion and incomplete outfits matter more than fluent prose. |
| Scene planning | 8/8 | 8/8 | No acceptance distinction in this small sample. |
| Accessories | 6/8 | 6/8 | Two transport failures per configuration; all returned answers accepted. |

The eight uncertain attempts occurred in two consecutive batches affecting both efforts equally: repeat 2 of accessories-03, accessories-05, detection-r07-a and shopping-r02. Each configuration had four such failures. No response or usage was received, so the underlying model completion and final charge cannot be established. They were never retried. This shared transport incident is not evidence of a model-specific reliability defect.

An **exploratory sensitivity check**, excluding only those eight paired transport failures and averaging the remaining repeats within each case, produced 72.31% medium versus 72.26% high weighted acceptance. The acceptance difference and decision were unchanged. This sensitivity does not replace the primary failure-inclusive result or reduce the reserved budget.

### What the failures suggest

Detection often found the main garment correctly but missed a small accessory, drew an inadequate box around an obscured underlayer, or joined separate clothing into one dress. In confirmation, item-set or crop flags appeared on 27 medium and 28 high calls; other acceptance failures also include inaccurate attributes and false clean-product flags. The all-items rule means a small earring error can fail an otherwise good main-garment detection. The [private visual gallery](../data/vision-eval-api-2026-09-20/confirmation-gallery.html) shows the actual processed inputs, frozen labels and predicted boxes.

Curation still repeated excluded pairs in two medium answers and one high answer. Shopping sometimes used the retailer model's coloring instead of the supplied person reference, or omitted a necessary top/bottom from a proposed look. These point to focused follow-up work on crop validation, deterministic pair exclusions, and clearer separation of candidate/person images. Those changes were not made during this evaluation.

The screen did not justify paying for Terra/low or Sol/low: neither improved weighted acceptance over Luna/medium, while cost per accepted answer was about 8.5× and 16.7× higher respectively on the same screening cases. This remains screening evidence; neither received the larger held-out confirmation, and higher efforts were not tested.

## Execution and cost accounting

Pricing was checked against OpenAI's [pricing page](https://developers.openai.com/api/docs/pricing) and [cache accounting](https://developers.openai.com/api/docs/guides/prompt-caching). Each request is token-counted before admission, including its images/schema. The runner reserves conservative cache-write input cost plus the maximum possible output, retains uncertain charges, and admits complete matched batches only within the shared $10 ledger. No image generation or API-based judging runs. Codex annotation/grading consumes Codex account usage outside this API ledger.

Calibration ran sequentially; screening used five concurrent candidates per matched block. Confirmation began with two, then safely checkpointed after 24 responses with no paid request in flight. It resumed with four concurrent requests across two matched blocks. No requests or schedules changed; checkpointing did not cancel or duplicate a paid call. Latency is provider response time under these recorded conditions, excluding preprocessing, and is not a controlled load benchmark. Cache hits/writes are observed rather than assumed. Pre-admission token-count transport failures were resumed against the same durable schedule; they did not cause a paid generation request to be repeated. Reported API cost is calculated from returned usage at the verified rates, rather than an account invoice.

## Limits

The wardrobe/person context is shared throughout. Repeats are not independent garments. Correlated ARKET styling is grouped across r01/r02/r03, and retailer views/shopping cases stay in one split. Confirmation inference clusters product families, with joint resampling across detection/shopping; other tasks have their own context families. Curation has only one wardrobe family, so variation across people cannot be estimated.

No website-UI screenshot stratum was captured. Shopping has no truly blank/unclear candidate or exact duplicate control in this round. Most accessory photos have no jewelry; one clearly shows existing gold hoops. Three near-white isolated product backgrounds have unresolved white-versus-gray semantics, so either clean flag is accepted and that ambiguity is recorded. The Next r08 listing title disagrees with its asset; the image and the visible pale blazer are authoritative.

All 51 budget-runner, production-capture, scoring and paired-analysis tests passed. The actual example gallery was visually checked at desktop and narrow widths; all images loaded locally and boxes aligned with the rasters.

The tested API shortlist excludes Terra/Sol at higher efforts and Luna none/xhigh/max. No claim is made about their price/performance. All conclusions are conditional on these prompts, images, labels, acceptance thresholds and model-assisted judgments.


## Reproduction and completion evidence

The private bundle contains `freeze-record.json`, the frozen suite/gold/rubric, `confirmation-selection.json`, anonymous grading packets and mappings, `reviewer-provenance.json`, `run/ledger.json`, raw responses, `completion-audit.json`, `final-scores.json`, `confirmation-analysis.json`, the separately labelled sensitivity analysis, and the example gallery. Screening and confirmation are reported separately; pooling the 20-call configurations against the 120-call configurations would compare different case coverage.

The completion audit confirms the union of the screening and confirmation schedules contains exactly 300 unique attempt IDs, no unscheduled attempts or duplicate response IDs, 292 grades for 292 returned responses, zero pending grades, zero active requests, and all 200 confirmation outcomes. Config totals are 120 each for Luna medium/high and 20 each for Luna low, Terra low and Sol low. Returned usage reconciles with the ledger; eight uncertain calls retain $0.133116800 in reservations.

Re-scoring and rendering are offline. Run the scoring script with the frozen suite, ledger, gold and grades; run `analyze-vision-api-eval.mjs` on `final-scores.json` with `luna-medium luna-high`. Do not rerun paid requests to reproduce the report. The runner will preserve the same schedule and never replay uncertain attempts.


## Later diagnostic extension

The [handbag diagnostic](vision-handbag-diagnostic.md) adds 20 separately reported calls to the same $10 budget. The original 300-call accounting snapshot is preserved as `run/benchmark-300-ledger.json`; use that snapshot to reproduce this report. The live `run/ledger.json` includes the extension. None of this report's original scores or selection decisions changed.
