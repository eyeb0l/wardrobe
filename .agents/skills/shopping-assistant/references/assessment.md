# Assess a potential purchase

Use this reference for supplied images and for each candidate found during personal shopping.

## Resolve the comparison context

Follow [the shared storage workflow](../../../../docs/SKILL_STORAGE.md) and read a fresh task snapshot from the selected target. The hosted wardrobe is the default. Do not use repository `data/` as current production evidence.

| Context | Snapshot source |
| --- | --- |
| Owned items | `$WORK/snapshot/library.json` |
| Original garment images | `/api/import/library/FILENAME` maps to `$WORK/snapshot/imported/FILENAME` |
| Available original references | `snapshot.json` lists IDs and files copied from the selected store |
| Default reference | `model-reference.png`, ID `default`, when present |
| Other references | `model-reference-N.png`, ID `model-reference-N`, N ≥ 2 |

Use original cutouts and identity images for close inspection. Responsive WebP copies are appropriate for the app's display but should not replace source evidence. The snapshot is read-only context; shopping advice never publishes it back.

Honor a reference selected by the user or already chosen in the active Shopping draft. Otherwise use the configured default and identify that choice briefly. If it is missing, use another reference only when the user has selected it or confirms the choice. Continue wardrobe-only analysis while requesting a needed reference; do not invent personal suitability. With no usable wardrobe, give only the supported visual assessment and explain that ownership, duplication and combinations remain unverified.

Edits and deletions are saved in the shared library; fresh snapshots include current metadata and exclude hidden items. The app migrates legacy browser edits before loading that library. If migration fails or the visible app differs from the snapshot, report the discrepancy and refresh after it is resolved. Resolve images only through server-owned library records.

Resolve downloaded originals within the snapshot directory, report unreadable items, and inspect all usable categories: `upperbody`, `dresses`, `wholebody_up`, `lowerbody`, `accessories_up`, `shoes`. Dresses are complete garments. An unavailable file is not evidence that the user owns no similar piece.

For a larger wardrobe, create labeled contact sheets in a temporary directory and inspect every sheet. The existing `outfitContactSheets(items)` export in `scripts/outfit-api.mjs` makes sheets of up to 12 items; it needs each item's `file` and `name`. Keep the exact ordered ID/name mapping with the sheets. Open promising matches individually when a thumbnail cannot establish construction or duplication. Use garment names in advice, not internal ITEM numbers.

## Inspect and prepare the candidate

Use Codex's image understanding for the assessment. Open attached screenshots/photos or local image paths. Preserve original uploads; use temporary working copies when conversion is necessary. For several photos, establish whether they show different garments or complementary views of one piece. In a wishlist screenshot, review each identifiable requested card. Ask which piece is intended only when that ambiguity prevents useful advice.

Keep garment colors, silhouette, visible closures and printed details evidence-bound. Look closely at relevant product details instead of enlarging an unreadable thumbnail through generative editing.

### HEIC and large images

For supported images that can be inspected directly, retain the original. Convert HEIC/HEIF locally when needed, preserving orientation. Avoid public image-conversion services for personal photos.

The app already provides browser-side preparation in `src/image-upload.mjs`; this module depends on browser APIs and is not a standalone Node CLI. It uses native decoding with a lazy `heic-to/csp` fallback. Through the app, choosing a Shopping image prepares a preview; analysis happens only after **Check this piece**. Use that separation when only local conversion/preview is needed. Follow the active browser tool's supported file and image APIs; do not invent an upload or extraction method. A local decoder is also suitable if its actual HEIC support is verified; a library advertising HEIF support may support only AVIF in its installed build.

Current app limits and behavior:

- Inputs: at most 50 MB and 64 megapixels.
- Wardrobe preparation: JPEG/PNG/WebP at most 2 MB remain byte-for-byte unchanged. Larger files reduce to at most 2 MB and a 2,400-pixel maximum edge; transparent cutouts retain alpha. HEIC needs conversion; sources of at most 2 MB retain resolution when the converted image also fits.
- Shopping preparation: `prepareShoppingImage` in `src/shopping-image.mjs` always normalizes to JPEG, at most 2 MB and a 1,600-pixel edge, removing embedded metadata. This is the analysis endpoint's required format.

When conversion is unavailable, explain which image could not be inspected and request a compatible export; continue with other readable evidence. Never present filenames or a failed preview as a visual assessment.

## Make the recommendation

Use the app's four decision meanings: **good addition**, **consider**, **skip**, or **unclear**. Tie the decision to evidence rather than a numeric score.

Cover the relevant questions in concise prose:

- **Personal styling:** how the candidate's colors and proportions may relate to the person reference. Keep comments neutral and specific; do not infer identity, sensitive traits, attractiveness or a need to change their body. A photo cannot establish exact fit or comfort.
- **Wardrobe usefulness:** plausible combinations, occasions supported by the brief, and roles the candidate adds. A new direction can be worthwhile without matching everything already owned.
- **Overlap:** actual near-duplicates and whether the difference adds useful variety. Similar colors alone do not make two items interchangeable.
- **Before deciding:** missing measurements, unclear construction, readable versus unverified fabric claims, or price/condition information that could change the verdict.
- **Ways to wear it:** up to four useful combinations with real owned pieces. Include the candidate implicitly and name the other pieces. A dress does not require a top-and-bottom formula. Do not invent shoes, accessories or ownership to complete a look.

For a shortlist, consider duplication between candidates as well as duplication with the wardrobe. Clearly label a combination that requires buying multiple new items. Return fewer suggestions, or none, when the evidence does not support more.

## Relationship to the web app

Native skill advice can be delivered directly in chat. Do not claim that advice or a shortlist was saved to Shopping: the app currently holds its draft and result in page memory, clearing them on reload.

When the user asks to run the web app itself, inspect its current setup and use its authenticated production UI or current API contracts. Preview deployments have no production API access. `GET /api/shopping/config` returns readiness and available references. `POST /api/shopping/analyze` takes `{image, modelReferenceId, notes, wardrobeItems}` and sends the candidate, selected reference, notes and wardrobe sheets to the configured AI provider. It returns `{assessment, context, analyzedAt}`. The assessment fields are `itemName`, `verdict`, `summary`, `personalFit`, `wardrobeFit`, `overlap`, `watchOuts` and `pairings`; each pairing contains `itemIds` and `reason`.

Use `scripts/shopping-api.mjs` as the source for current validation limits and schema when JSON/API parity is requested; ordinary chat advice need not reproduce JSON. Preserve the configured model. A request for native skill advice alone does not authorize an additional external API run. Honor an already authorized app run; do not repeat a paid check automatically after a timeout or uncertain outcome.
