---
name: generate-outfits
description: Curate outfits and create modeled photos from clothes already imported into this Wardrobe. Use for wardrobe-based outfit ideas, styling, or lookbooks.
---

# Generate Outfits

Create a complete outfit collection from the current Wardrobe: select strong combinations, generate a square modeled image for each, verify every result, and add the finished outfits and images to the saved collection.

## Scope and inputs

Ask for the outfit count unless the user already supplied a positive number; do not silently choose one. Honor the requested season, occasions, dress codes, and styling direction; otherwise create a balanced everyday mix.

For a modeled collection, completion means the requested number of reviewed images and the saved manifest, not just suggestions or prompts. If the user explicitly requests suggestions only, stop at that scope.

## Choose the live context

Read [the shared storage workflow](../../../docs/SKILL_STORAGE.md) first. Use the migrated cloud wardrobe by default; local mode is only for an explicit local request. Take a fresh task snapshot into `$WORK/snapshot`, then use that copy's `library.json`, `outfits.json`, original cutouts, and selected identity reference. Do not curate from the repository's old `data/` snapshot or treat local saves as production updates.

Read and follow the built-in `imagegen` skill before generation. Require enough distinct top-and-bottom combinations and the user's selected reference (default when no other is selected). Preserve original reference files. Keep task files and generated images outside the live store and Git. Suggestions-only work does not require generating or saving photographs.

## Parallel work

For more than eight outfits, use bounded batches; delegate only when the user or active instructions authorize parallel agent work. Keep one main agent responsible for the complete wardrobe inventory, global combination uniqueness, garment-usage balance, manifest reconciliation, and final QA.

Assign each worker a disjoint set of outfit IDs plus the exact identity and garment reference paths. Require every worker to return the outfit ID, filled prompt, reference list, generated path, status, and visual-review notes. Never allow two workers to generate or write the same outfit ID. Run workers in waves when concurrency is limited, reconcile results after every wave, and resume only missing or failed IDs.

## 1. Inspect the wardrobe

Read `$WORK/snapshot/library.json` and `$WORK/snapshot/outfits.json`. Reconcile visible browser-only edits and hidden items when relevant. Reserve existing outfit IDs and garment combinations so the new batch adds distinct looks without replacing saved outfits. Preserve all existing records and unknown fields. Resolve `/api/import/library/FILENAME` assets to `$WORK/snapshot/imported/FILENAME`, preserving the saved garment IDs. Use originals, not WebP display copies. Group items by:

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

Use the temporary `$WORK` directory established by the snapshot workflow. Build `$WORK/outfits.json` with the final target count:

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
      "status": "planned",
      "modelReferenceId": "default"
    }
  ]
}
```

Set `modelReferenceId` to the reference actually selected. Use stable lowercase hyphenated IDs that are unused in the saved collection. Reject duplicate garment combinations even when names or settings differ. The working manifest contains only the newly requested batch; its count is separate from the total saved collection.

## 3. Prepare references and prompts

For each outfit, order references as identity, exact top, exact bottom, then any selected outer layer, shoes, or accessory. Include every selected wardrobe garment and no unrelated references; added styling basics need no reference.

Read [references/outfit-image-prompt.md](references/outfit-image-prompt.md) and fill its template from the exact outfit record. Inspect every outer-layer reference before choosing the layered clause; never infer a zipper, buttons, placket, opening, or closure.

Rotate restrained warm, natural settings across the collection while keeping one cohesive editorial art direction.

## 4. Generate every outfit

Create one square 1:1 modeled PNG per outfit with Imagegen. Keep working outputs in `$WORK` until they pass review.

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

## 6. Save to the selected wardrobe

After all requested outfits pass, place exactly one accepted PNG per unique outfit at `$WORK/outfit-images/OUTFIT-ID.png`. In `$WORK/outfits.json`, keep the image path `outfit-images/OUTFIT-ID.png` and set `status` to `accepted`. Stage only this new batch.

From the repository root, validate against the live collection, then publish:

```sh
node --env-file=.env.cloud scripts/save-outfit-collection.mjs \
  "$WORK/outfits.json" --target cloud --dry-run
node --env-file=.env.cloud scripts/save-outfit-collection.mjs \
  "$WORK/outfits.json" --target cloud
```

The helper preserves previous records and unknown fields, validates current garment IDs, and uses the cloud writer lease. Images get immutable content-hash filenames. An identical rerun is safe; a conflicting outfit ID is rejected. Do not stop the hosted app, write a local manifest as a substitute, or rerun the initial migration.

Read the returned `outfits` and `manifestPath`, verify the new batch has the requested count of unique accepted records, and inspect the original results and the authenticated production `/outfits` gallery. Check that prior records remain present. The gallery total can exceed the requested batch count. If saving or verification fails, keep the staged batch, reconcile the current store, and complete only the missing work; do not regenerate already accepted photographs merely because a save was uncertain.

For an explicit local request, omit `--env-file=.env.cloud`, pass `--target local`, and follow the shared workflow's local writer-lock instructions. Local saving does not update production.

## Finish

Report the requested and completed count, destination (cloud or local), gallery verification, any unresolved failures, and the styling mix. Link the hosted `/outfits` page for cloud delivery; use absolute output paths for explicit local delivery. Display up to 12 reviewed photographs in chat when supported; do not share private Blob URLs.
