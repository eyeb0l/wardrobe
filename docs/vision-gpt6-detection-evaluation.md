# GPT-6 detection evaluation

Run on 2026-10-27. This evaluation asked two questions:

1. Can GPT-6.1 Terra replace GPT-6.1 Sol for the manual difficult-detection retry?
2. Is Terra meaningfully better than GPT-6 Luna for default import detection?

**Decisions:**
- Import detection now defaults to `gpt-6.1-terra` through the new `OPENAI_DETECTION_MODEL` setting.
- The manual retry stays on `gpt-6.1-sol`.
- Scene planning, outfit curation, accessories and Shopping stay on `OPENAI_VISION_MODEL` (`gpt-6-luna`).

The earlier [GPT-5.6 evaluation](vision-benchmark-api-results.md) and [detection-rescue follow-up](chroma-cleanup-and-detection-rescue.md) provided the images, labels and acceptance rule. Their GPT-5.6 scores are not directly comparable.

## Prices

Standard tier, short context, USD per million tokens. Checked on 2026-10-27 against the [pricing page](https://developers.openai.com/api/docs/pricing):

| Model | Input | Cached input | 30-minute cache write | Output |
|---|---:|---:|---:|---:|
| GPT-6 Luna | $0.10 | $0.01 | $0.125 | $0.50 |
| GPT-6.1 Terra | $1.00 | $0.05 | $1.25 | $5.00 |
| GPT-6.1 Sol | $2.00 | $0.10 | $2.50 | $10.00 |

## Protocol

- **Images:** 31 frozen detection images. These are the 30 retailer images from the 2026-09-20 suite plus the user's transparent handbag. They are scored against the same adjudicated labels, which were not changed.
- **Requests:** captured from the current production middleware.
  - The 30 retailer uploads reproduce the frozen request images byte for byte.
  - The handbag reuses its frozen processed PNG, because no browser-prepared upload was kept. Upload preparation and server normalisation are unchanged since the freeze.
  - The prompt includes one wording change made after the freeze. The schema is unchanged.
- **Evaluation-only settings:** explicit medium effort, standard tier, `store: false` and a 16,384-token output cap. Production omits effort; OpenAI documents medium as the default for all three models.
- **Retry comparison:** the 12 detection-rescue images (8 hard, 4 controls) ran on Luna, Terra and Sol.
- **Import comparison:** all 30 retailer images ran on Luna and Terra.
- **Repeats and spend:** two independent calls per image and configuration, so 148 calls in total. All 148 completed, with no timeouts, retries or uncertain charges. Measured API usage was **$0.800538** against a separate US$3 cap.
- **Acceptance (unchanged from 2026-09-20):** the answer must
  - find the exact required item set;
  - give every required box IoU ≥ 0.5 and visible coverage ≥ 0.85;
  - set an acceptable clean-product flag;
  - finish within 210 s;
  - have no critical error;
  - score two blind attribute ratings with a mean ≥ 3/4 and neither below 2.
- **Grading:** answers were shuffled under anonymous IDs. The grader was the same model-assisted agent that ran the evaluation, and could not see the model mapping while grading. In practice the subjective grades decided no outcome: every acceptance or rejection was already settled by the mechanical checks.
- **Decision rules:** written down before any paid call. The Terra-for-Sol swap required:
  - Terra hard-case acceptance within one accepted call of Sol;
  - rescues on at least two distinct hard images;
  - no more than one control call lost relative to Luna.

  "Meaningfully better than Luna" required a gain of at least 10 percentage points, with a paired product-family bootstrap lower bound above zero.

## Retry comparison

| Configuration | Hard accepted | Controls accepted | Mean quality | API cost, 24 calls | Per call | Median / p95 latency |
|---|---:|---:|---:|---:|---:|---:|
| Luna medium | 6/16 | 5/8 | 89.1 | $0.0193 | $0.0008 | 10.4 s / 20.9 s |
| Terra medium | 8/16 | 8/8 | 95.4 | $0.1577 | $0.0066 | 7.2 s / 19.1 s |
| Sol medium | 10/16 | 8/8 | 96.9 | $0.3623 | $0.0151 | 12.0 s / 32.5 s |

Per image (accepted calls out of 2 for Luna / Terra / Sol):

| Hard image | Luna / Terra / Sol | Control image | Luna / Terra / Sol |
|---|---|---|---|
| r02-a (layered plum set) | 0 / 0 / 0 | r01-a | 1 / 2 / 2 |
| r04-a (earring with knit) | 2 / 2 / 2 | r03-a | 2 / 2 / 2 |
| r07-b (cardigan under jacket) | 0 / 0 / 0 | r10-b | 0 / 2 / 2 |
| r08-a (eight-item blazer outfit) | 0 / 0 / 0 | s04 (food negative) | 2 / 2 / 2 |
| r09-b (worn slingbacks) | 2 / 2 / 2 | | |
| r12-b (scarf/top/skirt crop) | 1 / 0 / 2 | | |
| s03 (tight skirt and boots crop) | 0 / 2 / 2 | | |
| User handbag | 1 / 2 / 2 | | |

Terra failed the swap rule because it came in two accepted calls behind Sol. Every difference between the two is on r12-b: Terra missed the scarf ends or the bag in both calls, and Sol was accepted in both. Terra did rescue Luna failures on two hard images (s03 and the handbag), and it lost no controls.

Terra costs about 44% of Sol per call and is faster. However, the evidence does not support calling it equivalent on the cases a user would retry. Sol remains the retry model, and it is now a step up from the Terra default rather than a sibling of it.

## Import comparison

The import comparison covers the 30 retailer images, 60 paired calls per model. The handbag is reported only in the retry comparison.

| Configuration | Accepted | Mean quality | API cost, 60 calls | Cost per accepted | Median / p95 latency |
|---|---:|---:|---:|---:|---:|
| Luna medium | 28/60 (46.7%) | 91.1 | $0.0471 | $0.0017 | 10.6 s / 20.9 s |
| Terra medium | 39/60 (65.0%) | 95.4 | $0.3838 | $0.0098 | 7.8 s / 17.0 s |

- **Acceptance gain:** Terra was **+18.3 percentage points** ahead. The paired bootstrap over 11 product families (10,000 draws) gives a 95% interval of **+2.1 to +38.9 points**. Both pre-registered conditions are met.
- **Paired outcomes:** Terra rescued 14 of Luna's 32 failed calls, across 9 images, and regressed 3 calls on 3 images.
- **Failure flags (calls):** Terra had 13 item-set errors and 12 unusable crops, against Luna's 21 and 21. Both models had 4 false clean-product flags.
- **Invented items:** Luna invented leggings under the s03 skirt in both calls. Terra invented none.

Both models still failed every call on r02-a (layered plum set), r07-b (cardigan under jacket) and r08-a (eight-item blazer outfit), so the import flow's crop review and Sol retry remain necessary.

At these measured rates, a Terra detection costs about $0.0064, compared with $0.0008 for Luna. Images and prompt prefixes are cached differently across workloads, so treat these as observed values, not a forecast.

## Limits

- **Correlated sample:** this is a small set of correlated retailer images, with two repeats each. The import interval is wide, and its lower bound is close to zero.
- **Failure-selected retry set:** the retry set was chosen from earlier failures, and 11 of its 12 images also appear in the import set.
- **Labels:** model-assisted adjudications from 2026-09-20, not independent human annotation.
- **Not covered:** website product imports, camera photos and the other vision workloads. High or low effort was not tested.

## Reproduction

The private bundle lives in `data/vision-eval-gpt6-2026-10-27/` and is ignored by Git. It contains:
- `prepare.mjs`, the frozen `suite.json` / `gold.json` / `protocol.json` / `rubric.json`, and `freeze-record.json`;
- the cost ledger and raw responses under `run/`;
- the blind packets, private mapping and anonymous grades under `blind/`;
- `grades.json`, `scores.json` and `analysis.json`.

To reproduce the scores offline, run from the repository root:

```sh
B=data/vision-eval-gpt6-2026-10-27
node scripts/score-vision-api-eval.mjs $B/suite.json $B/run/ledger.json $B/gold.json $B/grades.json $B/scores.json
node $B/analyze.mjs
```

Do not rerun paid requests: the runner never replays an attempted call.
