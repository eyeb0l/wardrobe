# Image and vision model migration

The importer defaults to `gpt-image-2.5-sunburst` for both image stages and `gpt-5.6-luna` for garment detection. Model overrides remain available in `.env`; restart Vite after changing them. Existing library images are not regenerated automatically.

## API compatibility

The existing multipart `/images/edits` requests, PNG output, `high` quality, and 1024×1024 cutout / 1536×1024 modeled dimensions are supported by Sunburst. The app continues generating a solid chroma background and removing it locally. Changing to native transparent generation would also require changing the cleanup stage; it is a separate change. No `input_fidelity` or SDK change is needed for the current request shape.

Luna supports image input and structured output through `/responses`. The importer uses a strict clothing JSON schema, including the Dresses category and a clean-product-photo classification used to offer original-image import. OpenAI describes Luna as roughly the earlier nano tier, so a newer name alone does not establish better recognition than 5.4 mini. Image quality remains `high`; higher settings are not automatically enabled.

Sources checked September 13, 2026: [Sunburst](https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst), [Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna), [image generation](https://developers.openai.com/api/docs/guides/image-generation), [image prompting](https://developers.openai.com/api/docs/guides/image-prompting).

## Prompt changes

- Detection defines the existing categories, paired items, visible-only evidence, record ordering, the eight-item limit, and bounding-box extents. Estimated colors and uncertain fabric, brand, or closure details must not become invented facts.
- Extraction treats the source image as authoritative over metadata. It preserves asymmetry and the visible side, allows matching pairs, and avoids inventing an unseen front. It no longer asks the model to recolor a garment to avoid the chroma key. Key selection now considers both recorded colors; this cannot guarantee a safe key for every multicolored item.
- Modeled images explicitly assign identity to Image 1 and garment appearance to Image 2. Identity-reference clothing must not leak into the result. Identity, garment design, and visibility take priority over scenery. Existing printed text is preserved while added captions are excluded.

The bundled Codex import and outfit skills run through the Imagegen tool rather than the web API. Their reference-fidelity and visual-review requirements still apply. When filling the outfit template, renumber optional references to match the actual attachment order.

## Compare real results

The automated tests mock OpenAI: they verify request formats, model defaults/overrides, image-reference order, the review flow, and local output processing. They do not measure model access, latency, cost, recognition accuracy, or visual consistency.

For a visual evaluation, use a separate `WARDROBE_DATA_DIR` and the same source photos and identity reference across runs. Keep photos and results out of Git.

1. Include a simple top, asymmetric garment, printed text/logo, layered outfit, shoes, and a multicolored garment. Repeat each case at least three times.
2. Compare 5.4 mini and Luna detection on the same sources: correct item count, categories, useful crops, paired footwear, and no fabricated details. An invalid or tight crop can harm extraction regardless of the image model.
3. For image comparisons, reuse identical approved crops and cutouts so vision differences do not confound the result. Start with identical prompts, `high` quality, dimensions, and reference order on GPT Image 2 and Sunburst. Preserve a copy of the pre-migration prompts from Git for the baseline, then compare the revised prompts separately.
4. Inspect cutout silhouette, original colors, asymmetry, markings, transparent edges, and missing pieces. Compare modeled identity, exact garment construction, unobstructed details, anatomy, and framing against both references.
5. Record accepted/rejected results, reasons, latency, retries, and API usage. Compare cost per accepted image rather than assuming identical quality labels imply identical cost or consistency.

The web UI's regenerate action starts again from the source references plus the correction text; it does not attach the previous output. Describe the desired result explicitly rather than referring to an unseen previous image.
