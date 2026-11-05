# Image and vision model migration

The importer defaults to `gpt-image-2.5-sunburst` for cutouts and modelled photos, `gpt-6.1-terra` for garment detection, and `gpt-6-luna` for modelled-scene planning. Existing library images are never regenerated automatically.

The manual difficult-detection retry uses `gpt-6.1-sol` at medium reasoning effort. The default vision requests omit `reasoning.effort`, which OpenAI documents as medium for [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna) and [GPT-6.1 Terra](https://developers.openai.com/api/docs/models/gpt-6.1-terra). Detection moved from Luna to Terra after the [GPT-6 detection evaluation](vision-gpt6-detection-evaluation.md). Sol is used only when the user chooses **Retry with Sol**; it is not an automatic fallback. The private Preview deployment was checked with a copied wardrobe before the original GPT-6 production release. Historical GPT-5.6 evaluations remain linked below as baselines, not claims about GPT-6 quality.

## Configuration

Set overrides in local `.env` and restart Vite. Hosted configuration uses production environment variables; follow [HOSTING.md](HOSTING.md) when changing a deployment.

| Variable | Default / precedence |
| --- | --- |
| `OPENAI_DETECTION_MODEL` | `gpt-6.1-terra`; import clothing detection |
| `OPENAI_VISION_MODEL` | `gpt-6-luna`; scene planning, outfit curation, accessories and shopping assessment. Does not affect detection |
| `OPENAI_IMAGE_MODEL` | `gpt-image-2.5-sunburst`; fallback for both image stages |
| `OPENAI_GARMENT_MODEL` | Overrides `OPENAI_IMAGE_MODEL` for cutouts |
| `OPENAI_MODELED_MODEL` | Overrides `OPENAI_IMAGE_MODEL` for modelled photos |
| `OPENAI_IMAGE_QUALITY` | `high` for both image stages |
| `OPENAI_IMAGE_COMPLEXITY` | Unset (model default). Sent only to GPT Image 2.6 models, because 2.5 rejects the field |
| `OPENAI_GARMENT_COMPLEXITY` | Overrides `OPENAI_IMAGE_COMPLEXITY` for cutouts |
| `OPENAI_MODELED_COMPLEXITY` | Overrides `OPENAI_IMAGE_COMPLEXITY` for modelled photos |
| `OPENAI_MARKUP_COMPLEXITY` | `low`; marked edits on GPT Image 2.6. Does not inherit `OPENAI_IMAGE_COMPLEXITY` |

## API compatibility

The [importer](../scripts/import-job-api.mjs) sends multipart `/images/edits` requests with PNG references and output, 1024×1024 cutouts, and 1536×1024 modelled photos. It uses direct `fetch`, with no SDK or `input_fidelity` parameter. Every image request sets `moderation=low`. New cutouts request `background=transparent`; the saved API PNG is passed through a local near-opaque interior correction before review. Older chroma-key jobs retain their original cleanup stage. A garment-model override must support transparent PNG output.

Detection sends image input to `/responses` with a strict clothing JSON schema, including Dresses and `isCleanProductShot`. Original-image import requires one detected item, this classification and the app's background checks to pass.

Each modelled attempt first makes a separate `/responses` scene-planning request using the approved cutout, garment metadata, recent settings and user direction. Planning must return a nonempty `setting` of at most 600 characters; invalid planning stops before the image request. The planned setting and exact image prompt are saved with the job, and the accepted setting is saved with the garment. Account for this text request when measuring latency and cost.

### GPT Image 2.6

`gpt-image-2.6-sunburst` and `gpt-image-2.6-flare` work with the importer's existing request shape, but the default stays on 2.5 until a visual comparison supports a change. Checks on 5 November 2026, using one synthetic garment at `quality=low` on `/images/edits`, found:

| Request | Result |
| --- | --- |
| 2.6 Sunburst with `background=transparent` | Worked, with and without `complexity=low` |
| 2.5 Sunburst with `complexity=low` | HTTP 400 `invalid_value` on `complexity` |
| 2.6 Sunburst with `markup` and an extra reference image | Worked; the mark was removed from the output |
| 2.5 Sunburst with `markup` | Worked; the mark was removed from the output |
| 2.6 Sunburst with `markup` and `background=transparent` | Worked; the output was transparent |
| Billed output image tokens at 1024×1024 | 2.6: 824. 2.5: 196 |

These are single calls on a simple image. They establish that the requests are accepted, not comparative quality. 2.5 and 2.6 list the same token rates, but the token counts above differ, so compare measured cost rather than assuming the same price per image. OpenAI also says higher complexity can introduce unwanted changes, which matters for garment fidelity, so compare it per stage. Marked edits moved and resized the garment in these checks even though the request asked to keep everything else, which is why the marked-edit prompt also tells the model not to reframe.

### Marked edits

A marked edit sends the photo under review as the first `image[]`, followed by the identity and garment references, with the marks as a transparent PNG `markup` layer scaled to exactly the photo's dimensions. It does not replan the scene. The request is validated and the marks saved before any paid call, and they apply only to that exact photo: the client sends the photo's URL, and a changed photo returns 409. An explicit retry without marks discards them, and an outfit collection retry keeps them. Cutouts cannot be marked yet because the post-processing for that path has not been evaluated.

## Prompt behaviour

- Detection defines categories, paired items, visible-only evidence, record ordering, the eight-item limit and bounding-box extents. Estimated colours and uncertain fabric, brand or closure details must not become invented facts.
- Extraction prioritises the source image over metadata, preserving asymmetry, the visible side and matching pairs without inventing an unseen front. The requested background is truly transparent; pale opaque fabric and genuine transparent openings must be preserved. Older chroma-key jobs keep their saved key and cleanup recipe.
- Upload review offers **Gently tidy garment** as an optional alternative to ordinary extraction. It requests subtle correction of accidental tilt/perspective and distracting wrinkles, preserving natural drape, texture, volume, intentional pleats/creases, construction and all identifying details. The choice is saved with the import job and reused on retries, including hosted tasks. It uses the same extraction call, then holds the result for review; **View original** opens the source for comparison. Other preparation options retain their existing behaviour. AI editing is not pixel-preserving; inspect the result before approving.
- Modelled images use Image 1 for identity and Image 2 for the garment; reference clothing must not leak through. Identity, garment fidelity and visibility outrank scenery. Preserve garment lettering without added captions. Supporting clothes are limited to necessary plain neutral pieces and permitted basics, including unpatterned black/brown tights.

Scene and image prompts share [modeled-photo-prompts.mjs](../scripts/modeled-photo-prompts.mjs). Settings follow the garment and recent scenes, with no fixed backdrop list. The import skill renders these prompts through [modeled-photo-prompt.mjs](../scripts/modeled-photo-prompt.mjs); keep creative direction in the shared module.

The bundled import and outfit skills generate through Imagegen, independently of the app's API model configuration. Their reference-fidelity and visual-review requirements still apply. In the outfit template, renumber optional references to match the actual attachment order. See [SKILL_STORAGE.md](SKILL_STORAGE.md) for storage and publication rules.

## Compare real results

The automated tests mock OpenAI: they verify request formats, model defaults/overrides, reference order, shared prompts, scene-planning failures, review flow and output processing. They do not establish provider access, comparative model quality, latency, cost, recognition accuracy or visual consistency.

For an authorised visual evaluation, use a separate `WARDROBE_DATA_DIR` and explicitly set `WARDROBE_MODEL_REFERENCE` to the intended reference; changing the data directory does not move that default. Keep sources, references and results out of Git, and use the same inputs across runs.

1. Include a simple top, asymmetric garment, printed text/logo, layered outfit, shoes, and a multicoloured garment. Repeat each case at least three times.
2. Compare detection models on the same sources (see the [GPT-6 detection evaluation](vision-gpt6-detection-evaluation.md) for the latest run): correct item count, categories, useful crops, paired footwear, and no fabricated details. An invalid or tight crop can harm extraction regardless of the image model.
3. For image comparisons, reuse identical approved crops and cutouts so vision differences do not confound the result. Start with identical prompts, planned settings, `high` quality, dimensions and reference order on GPT Image 2 and Sunburst. Preserve pre-migration prompts from Git for the baseline, then compare prompt changes and scene variety separately.
4. Inspect cutout silhouette, original colours, asymmetry, markings, transparent edges, and missing pieces. Compare modelled identity, exact garment construction, unobstructed details, anatomy, and framing against both references.
5. Record accepted/rejected results, reasons, latency, retries, and API usage. Compare cost per accepted image rather than assuming identical quality labels imply identical cost or consistency.

To compare GPT Image 2.5 and 2.6, restart the app between configurations with the same separate data directory, so telemetry collects both:

```sh
# Baseline
OPENAI_IMAGE_MODEL=gpt-image-2.5-sunburst

# Candidate. Repeat with each complexity under test; unset uses the model's default (high).
OPENAI_MODELED_MODEL=gpt-image-2.6-sunburst
OPENAI_GARMENT_MODEL=gpt-image-2.6-sunburst
OPENAI_MODELED_COMPLEXITY=medium
OPENAI_GARMENT_COMPLEXITY=low
```

Then read `imageUsage` and `cohorts` from the [telemetry report](GENERATION_TELEMETRY.md#read-only-report), which separate results by model, complexity and moderation. Its candidates are generated results, so track approvals separately. Each configuration needs its own review of the images themselves.

Unless the photo is marked, regenerate starts from the source references and correction text, without attaching the previous output. Modelled regeneration also replans the scene. Describe the desired result explicitly and request the previous setting if it should be retained. Saved modelled photos remain unchanged until the replacement is approved; manually uploaded replacements also require approval.
