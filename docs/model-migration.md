# Image and vision model migration

The importer defaults to `gpt-image-2.5-sunburst` for cutouts and modeled photos, and `gpt-5.6-luna` for garment detection and modeled-scene planning. Existing library images are never regenerated automatically.

## Configuration

Set overrides in local `.env` and restart Vite. Hosted configuration uses production environment variables; follow [HOSTING.md](HOSTING.md) when changing a deployment.

| Variable | Default / precedence |
| --- | --- |
| `OPENAI_VISION_MODEL` | `gpt-5.6-luna`; detection and scene planning |
| `OPENAI_IMAGE_MODEL` | `gpt-image-2.5-sunburst`; fallback for both image stages |
| `OPENAI_GARMENT_MODEL` | Overrides `OPENAI_IMAGE_MODEL` for cutouts |
| `OPENAI_MODELED_MODEL` | Overrides `OPENAI_IMAGE_MODEL` for modeled photos |
| `OPENAI_IMAGE_QUALITY` | `high` for both image stages |

## API compatibility

The [importer](../scripts/import-job-api.mjs) sends multipart `/images/edits` requests with PNG references and output, 1024×1024 cutouts, and 1536×1024 modeled photos. It uses direct `fetch`, with no SDK or `input_fidelity` parameter. Cutouts are generated against a solid chroma background, then made transparent by the app's cleanup stage. Native transparent generation would require changing that stage as well.

Detection sends image input to `/responses` with a strict clothing JSON schema, including Dresses and `isCleanProductShot`. Original-image import requires one detected item, this classification and the app's background checks to pass.

Each modeled attempt first makes a separate `/responses` scene-planning request using the approved cutout, garment metadata, recent settings and user direction. Planning must return a nonempty `setting` of at most 600 characters; invalid planning stops before the image request. The planned setting and exact image prompt are saved with the job, and the accepted setting is saved with the garment. Account for this text request when measuring latency and cost.

## Prompt behavior

- Detection defines categories, paired items, visible-only evidence, record ordering, the eight-item limit and bounding-box extents. Estimated colors and uncertain fabric, brand or closure details must not become invented facts.
- Extraction prioritizes the source image over metadata, preserving asymmetry, the visible side and matching pairs without inventing an unseen front. The garment must not be recolored to avoid the chroma key. Key selection considers both recorded colors but cannot guarantee safety for every multicolored item.
- Modeled images use Image 1 for identity and Image 2 for the garment; reference clothing must not leak through. Identity, garment fidelity and visibility outrank scenery. Preserve garment lettering without added captions. Supporting clothes are limited to necessary plain neutral pieces and permitted basics, including unpatterned black/brown tights.

Scene and image prompts share [modeled-photo-prompts.mjs](../scripts/modeled-photo-prompts.mjs). Settings follow the garment and recent scenes, with no fixed backdrop list. The import skill renders these prompts through [modeled-photo-prompt.mjs](../scripts/modeled-photo-prompt.mjs); keep creative direction in the shared module.

The bundled import and outfit skills generate through Imagegen, independently of the app's API model configuration. Their reference-fidelity and visual-review requirements still apply. In the outfit template, renumber optional references to match the actual attachment order. See [SKILL_STORAGE.md](SKILL_STORAGE.md) for storage and publication rules.

## Compare real results

The automated tests mock OpenAI: they verify request formats, model defaults/overrides, reference order, shared prompts, scene-planning failures, review flow and output processing. They do not establish provider access, comparative model quality, latency, cost, recognition accuracy or visual consistency.

For an authorized visual evaluation, use a separate `WARDROBE_DATA_DIR` and explicitly set `WARDROBE_MODEL_REFERENCE` to the intended reference; changing the data directory does not move that default. Keep sources, references and results out of Git, and use the same inputs across runs.

1. Include a simple top, asymmetric garment, printed text/logo, layered outfit, shoes, and a multicolored garment. Repeat each case at least three times.
2. Compare 5.4 mini and Luna detection on the same sources: correct item count, categories, useful crops, paired footwear, and no fabricated details. An invalid or tight crop can harm extraction regardless of the image model.
3. For image comparisons, reuse identical approved crops and cutouts so vision differences do not confound the result. Start with identical prompts, planned settings, `high` quality, dimensions and reference order on GPT Image 2 and Sunburst. Preserve pre-migration prompts from Git for the baseline, then compare prompt changes and scene variety separately.
4. Inspect cutout silhouette, original colors, asymmetry, markings, transparent edges, and missing pieces. Compare modeled identity, exact garment construction, unobstructed details, anatomy, and framing against both references.
5. Record accepted/rejected results, reasons, latency, retries, and API usage. Compare cost per accepted image rather than assuming identical quality labels imply identical cost or consistency.

Regenerate starts from the source references and correction text, without attaching the previous output. Modeled regeneration also replans the scene. Describe the desired result explicitly and request the previous setting if it should be retained. Saved modeled photos remain unchanged until the replacement is approved; manually uploaded replacements also require approval.
