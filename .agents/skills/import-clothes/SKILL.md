---
name: import-clothes
description: Extract garments from photos as transparent cutouts, optionally create modeled photos, and import them into this Wardrobe. Use for photo-folder imports, modeled garment photos, or cutout-only delivery.
---

# Import Clothes

Turn photos of worn clothing into source-faithful transparent catalog PNGs and modeled editorial photos, then add the approved results to the selected Wardrobe store.

## Inputs

Read [the shared storage workflow](../../../docs/SKILL_STORAGE.md) first. The migrated cloud wardrobe is the default import destination; local mode requires an explicit local request. Obtain the source-image folder unless the user already supplied it. Resolve relative paths from the repository root. Confirm this is the Wardrobe repository by checking for `package.json`, `scripts/import-job-api.mjs`, and `data/` in `.gitignore`.

A request to add clothes to Wardrobe authorizes direct import after QA; the default deliverables are cutouts and modeled photos. For cutout-only requests, use the supplied new output-folder name or ask for one, and skip modeled generation and database import.

For an import or modeled-photo request, take a fresh task snapshot into `$WORK/snapshot` using the shared workflow. Use its library for duplicate checks and its original identity image for the selected reference. Honor the user's selection, otherwise use `default` if available. Do not fall back to a laptop reference when cloud access fails. Ask for a missing reference before modeled generation; source inventory and cutout work can continue. A cutout-only folder delivery needs neither cloud access nor an identity reference.

Complete the requested delivery mode through visual review and saved outputs. Temporary prompts or manifests alone are not completion.

## Rules

- Read and follow the built-in `imagegen` skill before generating or editing an image.
- Preserve source and identity originals. Private working copies may be used for the authorized generation; keep them, snapshots, credentials, and generated clothing photos out of Git.
- Produce one clothing item per PNG, except an established matching pair such as shoes.
- Remove the wearer, skin, hair, mannequin, hanger, props, other layers, and scene.
- Preserve only source-supported color, material, silhouette, construction, pattern, and legible marks.
- Prefer omission over invented logos, text, pockets, seams, fasteners, hardware, or trim.
- Deduplicate only when source photographs establish that two appearances are the same physical item.
- Hold items whose defining construction cannot be recovered without substantial invention.
- Never place temporary crops, prompts, manifests, or QA files in `data/`.

## Parallel work

Use bounded batches for large folders or more than eight generated items; delegate only when the user or active instructions authorize parallel agent work. Give each worker a disjoint set of source files or manifest slugs and require it to return the slug, prompt, reference paths, chroma path, modeled path, and visual-review notes.

Keep one main agent responsible for the global item inventory, physical-identity deduplication, manifest reconciliation, database write, and final contact-sheet QA. Never let two workers generate or write the same slug. Run batches in waves when concurrency is limited, and resume only missing or failed slugs.

## Temporary workspace

Reuse the `$WORK` directory from the snapshot workflow, or create one for cutout-only delivery. Keep intermediate files outside the live store and tracked repository files, for example:

```bash
if [ -z "${WORK:-}" ]; then
  WORK="$(mktemp -d "${TMPDIR:-/tmp}/wardrobe-import.XXXXXX")"
fi
mkdir -p "$WORK"/{source-jpg,crops,chroma,items,modeled,qa}
```

Use `$WORK` for intermediate files; retain it until delivery succeeds.

## Workflow

### 1. Inventory sources

Use `rg --files` first. Include JPEG, PNG, WebP, HEIC/HEIF, TIFF, BMP, and AVIF. Exclude `data/`, `dist/`, `node_modules/`, and `.git/`.

Create upright RGB JPEG working copies at quality 95 or better without upscaling. Make labeled contact sheets of at most 12 photos and inspect every sheet. Inventory every deliberately worn top, jacket, bottom, accessory, and pair of shoes.

### 2. Build the manifest

Write `$WORK/manifest.json` using this final shape:

```json
{
  "items": [
    {
      "slug": "navy-fair-isle-cardigan",
      "file": "navy-fair-isle-cardigan.png",
      "modeledFile": "navy-fair-isle-cardigan.png",
      "modelReferenceId": "default",
      "name": "Navy Fair Isle Cardigan",
      "part": "wholebody_up",
      "color": "#172033",
      "secondaryColor": "#f2efe6",
      "tags": ["knit", "fair isle", "zip"],
      "status": "accepted",
      "sourceRefs": ["IMG_1284.jpg", "IMG_1289.jpg"],
      "unknowns": []
    }
  ]
}
```

Use only these `part` values:

- `upperbody` — tops
- `dresses` — dresses, kept as one complete garment
- `wholebody_up` — jackets and outerwear
- `lowerbody` — bottoms
- `accessories_up` — accessories
- `shoes` — shoes

Use lowercase hyphenated slugs, six-digit hex colors, at most 12 short lowercase tags, and `null` when there is no genuinely distinct secondary color. Keep working records as `status: "generate"` or `status: "hold"`; change a record to `accepted` only after final QA. The import script ignores every non-accepted record. Set `modelReferenceId` to the reference actually used. Omit both modeled fields for cutout-only delivery.

### 3. Prepare focused references

For each generated item, crop the strongest view with about 12% padding and preserve enough context to distinguish the target from underlayers. Add at most one complementary crop when it shows important construction unavailable in the primary view. Inspect labeled crop contact sheets before generation.

### 4. Generate evidence-bound cutouts

Use Imagegen with the primary crop and only a genuinely complementary second crop. Ask for the complete empty item centered on a perfectly uniform chroma background with generous padding and no shadow. State the exact source-supported construction and all uncertain details that must be omitted.

Default to `#00ff00`; use `#ff00ff` for green garments unless magenta is prominent. Otherwise choose a maximally distant saturated RGB key. Never use a key color present in the garment.

Save generated chroma images to `$WORK/chroma/SLUG.png`. Compare every result against its source before accepting it.

### 5. Remove the chroma background

Prefer the helper bundled with the built-in Imagegen skill:

```bash
python3 "${CODEX_HOME:-$HOME/.codex}/skills/.system/imagegen/scripts/remove_chroma_key.py" \
  --input "$WORK/chroma/SLUG.png" \
  --out "$WORK/items/SLUG.png" \
  --auto-key border \
  --soft-matte \
  --transparent-threshold 12 \
  --opaque-threshold 220 \
  --despill \
  --force
```

If removal damages the item, regenerate with a more distant key instead of forcing the matte.

### 6. Verify

For every final PNG, verify:

- PNG format with an RGBA alpha channel
- transparent corners and border
- visible content with padding and no clipped extremity
- no body part, underlayer, adjacent garment, prop, shadow, or chroma halo
- source-faithful category, proportions, color, material, construction, pattern, and marks
- exactly one output for every accepted manifest record

Inspect checkerboard contact sheets of at most 12 items and compare sensitive results individually with their source crops. Regenerate critical or major failures. For cutout-only delivery, mark passing records `accepted`; when modeled photos are in scope, accept the record only after both images pass review.

### 7. Generate modeled photos

When modeled photos are in scope, read [references/modeled-photo.md](references/modeled-photo.md) for the 3:2 generation brief, reference order, output naming, and visual acceptance criteria. Skip this stage for cutout-only delivery.

### 8. Import into Wardrobe

Proceed after QA when direct import was requested. If import was not authorized, present the accepted item count and names and obtain approval before writing to the database.

Run the deterministic importer from the repository root, validating first:

```sh
node --env-file=.env.cloud .agents/skills/import-clothes/scripts/import-to-wardrobe.mjs \
  --target cloud --items "$WORK/items" --modeled "$WORK/modeled" \
  --manifest "$WORK/manifest.json" --dry-run
node --env-file=.env.cloud .agents/skills/import-clothes/scripts/import-to-wardrobe.mjs \
  --target cloud --items "$WORK/items" --modeled "$WORK/modeled" \
  --manifest "$WORK/manifest.json"
```

The entrypoint uses `scripts/import-reviewed-clothes.mjs`. It fully validates accepted PNGs, derives stable item IDs from cutout content, reads the latest live library under the cloud writer lease, and publishes originals privately before updating that library. Reimporting an identical cutout updates its metadata and supplied modeled photo without duplicating the item. It preserves unrelated items and fields, uses immutable modeled filenames, and leaves WebP display-copy creation to the app. This does not replace physical-item deduplication or visual QA. `--dry-run` performs no destination writes.

Verify the returned IDs and item count against the live `/api/import/wardrobe` through authenticated access, then inspect the production gallery and modeled images. Do not restart a local server or rerun the migration to make cloud changes appear. For an explicit local import, omit `--env-file=.env.cloud`, pass `--target local`, and follow the shared local writer-lock instructions; optional `--data-dir PATH` selects that local store.

For cutout-only delivery, create the requested new child folder under the repository root and copy only accepted PNGs into it. Do not write the database.

## Finish

Report the delivered count, skipped/held items or unrecoverable fragments, and destination. For cloud imports, link the hosted gallery and state its verification result. For local or cutout-only delivery, provide absolute output paths and make clear that production was not updated. Display up to 12 final cutouts in chat when supported; do not expose private Blob URLs.
