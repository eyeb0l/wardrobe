---
name: generate-outfits
description: Curate outfits and create modeled photos from clothes already imported into this local Wardrobe. Use for wardrobe-based outfit ideas, styling, or lookbooks.
---

# Generate Outfits

Create a complete local outfit collection from `data/library.json`: select strong combinations, generate a square modeled image for each, verify every result, and save the finished manifest and images under `data/`.

## Scope and inputs

Ask for the outfit count unless the user already supplied a positive number; do not silently choose one. Honor the requested season, occasions, dress codes, and styling direction; otherwise create a balanced everyday mix.

For a modeled collection, completion means the requested number of reviewed images and the saved manifest, not just suggestions or prompts. If the user explicitly requests suggestions only, stop at that scope.

## Requirements

- Read and follow the built-in `imagegen` skill before generating images.
- Require `data/library.json` and enough distinct top-and-bottom combinations for the requested count. Modeled photos also require a local identity reference: use `WARDROBE_MODEL_REFERENCE` when set, otherwise `data/model-reference.png`. Resolve relative paths from the repository root.
- Keep every source garment and identity image local and unchanged.
- Never add `data/`, the identity reference, garment images, or generated photos to Git.
- Select wardrobe garments only from the current database with successfully resolved local assets. The styling basics below do not require wardrobe records.

## Parallel work

Use subagents when the user requests more than eight outfits or explicitly asks for parallel generation. Keep one main agent responsible for the complete wardrobe inventory, global combination uniqueness, garment-usage balance, manifest reconciliation, and final QA.

Assign each worker a disjoint set of outfit IDs plus the exact identity and garment reference paths. Require every worker to return the outfit ID, filled prompt, reference list, generated path, status, and visual-review notes. Never allow two workers to generate or write the same outfit ID. Run workers in waves when concurrency is limited, reconcile results after every wave, and resume only missing or failed IDs.

## 1. Inspect the wardrobe

Read `data/library.json`. Resolve `/api/import/library/FILENAME` assets to `data/imported/FILENAME`. Group items by:

- `upperbody` — tops
- `wholebody_up` — jackets and outer layers
- `lowerbody` — bottoms
- `accessories_up` — optional accessories
- `shoes` — optional shoes

Create checkerboard contact sheets of at most 12 garment cutouts and inspect them. Use both metadata and visual evidence; do not style from filenames or colors alone.

If the wardrobe cannot support the requested number of genuinely distinct outfits, tell the user the maximum useful count and ask whether to continue with that number.

## 2. Curate the combinations

Each outfit contains exactly one top and one bottom, with an optional jacket, shoes, and restrained accessory.

You may add simple unpatterned black or brown tights, sheer or opaque, when seasonally or stylistically appropriate, even without a wardrobe item. Treat them as optional styling basics alongside invisible basics such as socks; plain neutral shoes remain allowed when no shoes were selected. Do not invent other visible garments or accessories. Note any added tights and their color/opacity in the outfit reason and generation prompt, without fabricating garment IDs or counting tights variants as distinct wardrobe combinations.

Use these styling principles:

- Favor tonal or analogous color harmony for cohesion.
- Use complementary contrast selectively and keep one color or garment dominant.
- Let one graphic, pattern, texture, or saturated piece carry the statement.
- Balance visual weight and silhouette: pair fuller bottoms with a cleaner top; keep heavier layers over a simple base.
- Use outer layers to frame the base look, repeat a present color, or add one controlled contrast.
- Keep layered looks physically plausible and make every selected garment visibly identifiable.
- Diversify garment usage instead of repeatedly leaning on the easiest neutral pieces.

Cover a useful mix of the user’s requested contexts. Without specific direction, balance casual, smart-casual, warm-weather, layered, dark-tonal, and statement looks as the wardrobe permits.

Keep working files in a temporary directory outside `data/` (referred to here as `$WORK`). Build `$WORK/outfits.json` with the final target count:

```json
{
  "version": 1,
  "outfits": [
    {
      "id": "navy-camel-classic",
      "name": "Navy & Camel Classic",
      "occasion": ["smart-casual", "office"],
      "garmentIds": ["import-...", "import-..."],
      "reason": "Deep navy and camel create controlled warm-cool contrast.",
      "setting": "a quiet warm-stone courtyard with restrained greenery",
      "image": "outfit-images/navy-camel-classic.png",
      "status": "planned"
    }
  ]
}
```

Use stable lowercase hyphenated IDs. Reject duplicate garment combinations even when names or settings differ.

## 3. Prepare references and prompts

For each outfit, order references as identity, exact top, exact bottom, then any selected outer layer, shoes, or accessory. Include every selected wardrobe garment and no unrelated references; added styling basics need no reference.

Read [references/outfit-image-prompt.md](references/outfit-image-prompt.md) and fill its template from the exact outfit record. Inspect every outer-layer reference before choosing the layered clause; never infer a zipper, buttons, placket, opening, or closure.

Rotate restrained warm, natural settings across the collection while keeping one cohesive editorial art direction.

## 4. Generate every outfit

Create one square 1:1 modeled PNG per outfit with Imagegen. Keep working outputs outside `data/` until they pass review.

Generate in bounded batches when the collection is large. Track every outfit as `planned`, `generated`, `accepted`, or `failed`; resume only missing or failed IDs.

## 5. Verify and correct

Compare every output against the identity and all garment references. Inspect contact sheets of at most 12 modeled outfits, then open questionable images individually.

Require:

- recognizable identity, face, hair, age, build, and body proportions
- every selected garment present and recognizable
- exact garment color, material, fit, construction, graphics, logos, text, proportions, and closures
- complete head-to-shoes framing with readable outfit and realistic anatomy
- natural layering without invented openings or hidden inner pieces
- no unselected visible garments or accessories except simple unpatterned black or brown sheer/opaque tights when appropriate, and plain neutral shoes when no shoes were selected; invisible basics such as socks are also allowed
- no extra person, text overlay, watermark, product mockup, or synthetic AI polish

Regenerate identity drift, missing or redesigned garments, fake closures or text, anatomy failures, or cropped feet. Do not mark an outfit accepted based on plausibility alone.

## 6. Deliver locally

After all requested outfits pass, save exactly one accepted image per unique outfit:

1. Create `data/outfit-images/` if needed.
2. Copy each accepted PNG to `data/outfit-images/OUTFIT-ID.png`.
3. Set every accepted manifest image to `/api/import/outfits/OUTFIT-ID.png` only if the app exposes that endpoint; otherwise keep the repository-relative `outfit-images/OUTFIT-ID.png` path.
4. Atomically write the exact requested collection to `data/outfits.json`.
5. Reopen every copied file and verify that the count of images, unique outfit IDs, and accepted manifest records all equal the number the user requested.

Do not claim the current gallery displays outfits unless the app has an outfit route. The completed local assets and manifest are still the deliverable.

## Finish

Report the requested and completed count, output paths, any regenerated failures, and the styling mix. Display up to 12 modeled outfits in chat and point the user to the local folder for the rest.
