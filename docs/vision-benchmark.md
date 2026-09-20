# Vision model evaluation

The app has five vision workloads: import detection, modeled-photo scene planning, outfit curation, accessory suggestions and shopping assessment. They default to `gpt-5.6-luna` through `OPENAI_VISION_MODEL`. None of their Responses requests sets `reasoning.effort`. Official documentation checked on 2026-09-20 lists **medium** as the default for Luna, Terra and Sol. Deployed environment overrides were not inspected.

## Reproduce the offline screening pilot

```sh
node scripts/prepare-vision-benchmark.mjs data/vision-benchmark/NEW-RUN
node scripts/score-vision-benchmark.mjs data/vision-benchmark/NEW-RUN
```

Preparation reads local historical wardrobe files and creates private fixtures under ignored `data/`. It does not read credentials, call a provider, regenerate images, update the library, or publish anything. A frozen suite cannot be overwritten. The current fixture recipe requires named garments and one existing outfit photo; missing inputs fail explicitly. Do not interpret its local inventory as the current hosted collection.

The source prompts and detection/curation/shopping schemas are extracted from trusted repository code; the scene prompt uses its shared builder and the contact sheet uses the production renderer. Source and image SHA-256 hashes are saved. Accessory and scene schemas reproduce the small production contracts. Source extraction deliberately fails if delimiters change; review extraction after production prompt/schema edits.

The initial pilot has ten cases: isolated floral dress; matching black shoes; worn shirt/jeans/shoes; no-clothing negative; everyday curation; outer-construction curation; fresh scene; accessories; shopping duplicate with instruction-like notes; and no-clothing shopping. The duplicate case tests notes injection, not text embedded in an image.

Use fresh Codex agents with no conversation history, identical participant instructions, explicit model and effort, and identical suite bytes. Participants may read only the suite and its specified images, and write their own answer file. Each must visually inspect all eight unique images. No rubric, sibling output, code inspection, web lookup, API calls or feedback is allowed. Save one JSON object keyed by case ID under `results/<anonymous-letter>.json`. A private run map records requested configuration; agent metadata establishes what was requested, not a returned API model snapshot.

For the 2026-09-20 run, requested configurations are Luna low/medium/high, Terra low/high and Sol low/high. One pass per configuration is a screening pilot, not a statistically reliable winner determination. Cases share one agent context within a run, so within-run carryover cannot be eliminated by instructions alone. A later API evaluation must use independent requests per case.

## Scoring

Preparation copies the seed `scripts/vision-benchmark-rubric.json`, recalculates alpha bounds for the two cutouts, and hashes it alongside the suite in `preregistration.json`. Inspect the seed annotations and frozen images before participants run, especially if local assets have changed. If annotations change, re-hash the rubric before starting. The worn-photo boxes are manual estimates tied to the initial photograph. The 2026-09-20 weighting follows the user's preference for balanced quality with detection and outfit accuracy first:

| Task | Weight |
|---|---:|
| Detection | 35% |
| Outfit curation | 30% |
| Shopping | 20% |
| Scene planning | 10% |
| Accessories | 5% |

Detection uses item/category F1 (30%), mean bounding-box IoU (30%), visually grounded attributes (20%) and clean-product decision (20%). Alpha extents provide boxes for isolated cutouts; worn boxes are manually estimated and should be treated as approximate. The plain swatch is a synthetic negative control. Other task dimensions use anchored 0–4 reviewer ratings. Average within tasks before applying task weights, so more detection cases do not silently increase their weight.

The offline scorer checks the schema subset actually used, raw box overflow, exact outfit role counts, owned IDs, excluded/repeated pairs, outer-construction consistency and empty-image behavior. It is not a general JSON Schema implementation. Have a reviewer grade anonymous responses against visible images and the frozen rubric; do not infer aesthetic quality from schema validity. Save `grading.json` keyed by anonymous candidate then case ID, with `attributeScore` (0–4) for detection or `ratings` (0–4 in criterion order) for other tasks, plus `criticalFlags` and `notes` in every case. When present, the scorer also produces weighted `scores.json`; measured API cost and latency deliberately remain null.

Report schema validity and critical errors alongside scores. A false clean decision, fabricated major item, unsupported full-front opening, invented ownership, excluded pair or successful instruction injection must not disappear inside an average. Report accepted-case rate and cost per acceptable result when actual costs exist.

## What this pilot can establish

It compares visual reasoning and instruction following **inside Codex** on a small, frozen, mostly easy set of historical cutouts and generated photos. It cannot establish production latency, actual billed API cost, strict schema reliability, image-generation quality, or population-level error rates. Tool image handling is not the API's image-detail contract. Detection inputs in this pilot include transparent cutouts and a resized generated outfit, rather than representative raw camera uploads. Shopping's duplicate candidate is a PNG cutout rather than the app's normalized JPEG. A 12-item sheet is smaller than the full wardrobe. These are disclosed differences, not production parity.

The app's import detection and scene requests omit image detail. Curation/accessories/shopping request high detail. Scene planning has a 30-second timeout, so an otherwise excellent high-effort model could be unsuitable there. Codex dispatch, tools and shared-context generation time cannot measure that timeout risk.

## Price and final selection

Published standard short-context USD rates per million tokens, checked 2026-09-20:

| Model | Uncached input | Cached input | Output |
|---|---:|---:|---:|
| GPT-5.6 Luna | $0.20 | $0.02 | $1.20 |
| GPT-5.6 Terra | $2.00 | $0.20 | $12.00 |
| GPT-5.6 Sol | $4.00 | $0.40 | $20.00 |

Sources: [Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna), [Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra), [Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol), [pricing](https://developers.openai.com/api/docs/pricing). Long context, cache writes, service tier and regional processing can change rates. Sol pricing is promotional at the time of the check. Image tokenization and reasoning usage must be measured, not assumed equal across models or efforts.

Do not label score divided by token price as measured price/performance. An explicitly hypothetical equal-usage request with 10,000 uncached billed input tokens and 1,000 billed output tokens costs $0.0032 / $0.032 / $0.06 for Luna / Terra / Sol. This excludes cache writes, regional adjustments and nonstandard tiers and is not a measured request from this pilot. Reasoning tokens belong in billed output totals; do not add them twice.

Before changing production, replay independent exact app requests on at least 30–50 held-out real cases, including camera photos, overlays, occlusion, multiple sheets, difficult constructions, nonduplicate shopping candidates and real failure examples. Repeat shortlisted configurations at least three times per case; randomize/interleave order. Include explicit Luna medium as baseline. Test medium for other models and none/higher efforts only if warranted by the first comparison and supported by the runner.

Capture requested/returned model, reasoning effort, schema and byte hashes, usage including cached/reasoning details, service tier, request duration, timeouts, retries and accepted-case score. Use an approved hard API spending cap. Calculate total actual cost divided by acceptable cases, and plot quality against cost and latency. Prefer the cheapest configuration that clears the agreed quality and critical-error gates; use task-specific routing if a larger model earns its cost only on a subset. Review taste judgments with the user. A second independent reviewer should check close or disputed results.
