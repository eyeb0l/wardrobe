<div align="center">

# Wardrobe

Your clothes, extracted and organized with gpt-image.

[![License: MIT](https://img.shields.io/badge/license-MIT-191919?style=flat-square)](LICENSE)
[![Node 22+](https://img.shields.io/badge/node-22%2B-191919?style=flat-square)](package.json)

[See the original post →](https://x.com/cdngdev/status/2076812846793650485)

</div>

![Wardrobe gallery](docs/screenshots/gallery.png)

![Modeled wardrobe editor](docs/screenshots/editor.png)

## Quick start

```bash
git clone https://github.com/tandpfun/wardrobe.git
cd wardrobe
npm install
cp .env.example .env
npm run dev
```

⚠️ The importer stays disabled until you add `OPENAI_API_KEY` to `.env` and place a PNG reference photo of yourself at `data/model-reference.png`.

Open [localhost:5173](http://localhost:5173).

For personal access from other devices, see the [private Vercel hosting guide](docs/HOSTING.md). It covers account-only authentication, durable cloud storage, the initial data copy, and safe updates.

## Use with Codex

This repo includes three Codex skills for importing clothes, creating modeled outfits, and assessing potential purchases against your wardrobe.

```text
$import-clothes Import the clothes from ~/Pictures/outfits, create modeled photos, and add them to this wardrobe.
$generate-outfits Create modeled outfit ideas from my wardrobe.
$shopping-assistant Would the piece in this screenshot be a good addition to my wardrobe?
$shopping-assistant Review my wishlist in the browser and shortlist the pieces that add the most to my wardrobe.
$shopping-assistant Find a navy wool cardigan under £100 on my preferred sites and compare it with what I own.
```

Open the cloned repo in Codex and use the relevant prompt. The import skill asks for a local model-reference PNG when needed, reviews every cutout and modeled photo, then writes to `data/library.json` and `data/imported/`. The outfit skill asks how many looks to create, then curates, generates, verifies, and saves the complete collection under `data/`.

The [Shopping Assistant skill](.agents/skills/shopping-assistant/SKILL.md) compares supplied photos or screenshots with your selected model reference and owned pieces, then gives advice directly in Codex. When requested, it uses available browser or computer tools to review a live wishlist or search retailer sites, checking product details and comparing candidates with each other. It reuses the app's local wardrobe and reference conventions; advice does not automatically import purchases or save a result to the Shopping tab.

### For agents

If you are setting up Wardrobe for a user, ask how they want to import their clothes:

- **Codex:** Ask for a folder or camera-roll location and a model-reference PNG, then extract, model, and import the individual pieces by following [the bundled import skill](.agents/skills/import-clothes/SKILL.md). Afterward, offer to create a requested number of modeled looks with [the outfit-generation skill](.agents/skills/generate-outfits/SKILL.md).
- **Web UI:** Help the user configure their own `OPENAI_API_KEY` and `data/model-reference.png`, then let them import through the app.

## What it does

- Detects every garment in a photo with the OpenAI Responses API
- Extracts clean product cutouts with the OpenAI Images API
- Offers **Use original image** for a likely single-item product shot on white or transparent background; this skips generative extraction and preserves the uploaded image for review. **Extract garment** remains available and is the default for ordinary photos.
- Generates an optional modeled editorial preview, or accepts a manually uploaded modeled photo for review
- Shows saved outfit collections with their styling notes and exact wardrobe pieces
- Curates and generates new outfits through the configured API, with progress, retries, and review before saving
- Keeps originals, jobs, generated images, and the JSON database local in `data/`
- Checks potential purchases against your model reference and wardrobe in **Shopping**
- Supports drag, drop, paste, editing, review, regeneration, and approval
- Filters Tops, Dresses, Jackets, Bottoms, Accessories, and Shoes. Existing dresses filed under Tops can be moved to Dresses in the item editor.

## Manual modeled photos

If image generation refuses a request or otherwise fails, choose **Copy prompt** beside **Retry** to copy the full prompt from that attempt, including its submitted correction. Copying makes no API call. For imports created before prompt recording was added, that button appears after a new generation attempt. If clipboard access is unavailable, the app shows selectable prompt text.

You can create the photo yourself with another image model, supplying the same identity and garment images in the order described in the prompt. The copied text does not include image attachments; outfit correction prompts may also reference the previous attempt. Review the output for your likeness, exact garment details and complete framing before uploading it. Wardrobe does not automatically switch models or call another provider.

- **Wardrobe piece:** open **Update modelled shot** (or **Create modelled shot**), then **Upload modeled photo**. This is also available while reviewing a failed or completed modeled generation. The crop is locked to horizontal 3:2. Choose a source at least 768 pixels wide and 512 pixels tall; 1536 × 1024 or larger is recommended.
- **Outfit:** open its generation review and choose **Upload modeled photo** beneath the retry controls. The crop is locked to square. Choose a source at least 512 × 512 pixels; 1024 × 1024 or larger is recommended. Wait for the collection's active generation to finish first.

After choosing a photo, drag it inside the crop preview, adjust zoom and position, or use the arrow keys on the preview. **Reset crop** restores the widest centered framing; **Cancel crop** leaves the current image untouched. **Use crop** prepares and uploads the selected area for review. Choosing a file alone uploads nothing. Both slightly off-ratio images and portrait/landscape sources are supported; the output always has exact 3:2 or square pixel dimensions. Zoom stops before the crop becomes too small, and the app never upscales or stretches a crop.

Modeled uploads accept JPEG/PNG/WebP/HEIC sources up to 50 MB and 64 megapixels. Cropping uses the decoded original with its orientation applied; its preview is separate from the full-resolution source. The crop is compressed locally to at most 2 MB with a maximum 2400-pixel edge, preserving the exact ratio. The server independently verifies the prepared file, decodes it fully, checks its displayed dimensions (including EXIF orientation), and rejects animated, malformed, oversized or incorrectly shaped images. The server does not further crop or stretch the prepared image. The prepared image is stored as a metadata-free PNG at its prepared resolution, with responsive compressed WebP versions served through the same image pipeline as generated photos.

Uploading only creates a review candidate. **Approve** / **Accept into collection** saves it; rejecting a replacement preserves the existing wardrobe photo. Opening the review, copying a prompt and uploading a photo do not generate images or require another model call.

For contributors: use `POST /api/import/jobs/:id/stages/modeled/upload` or `POST /api/outfits/jobs/:jobId/outfits/:outfitId/upload` with `{ "imageDataUrl": "data:image/png;base64,..." }` (JPEG and WebP also accepted). Prepared bytes are capped at 2 MB and the JSON body at 3 MB. Keep these routes inside the existing mutation locks, storage adapter and approval flow; never write straight to the saved library or collection. Keep originals and use the existing display-image routes for compressed delivery. Prompt copying must use the recorded attempt prompt rather than just the editable correction field.

## Configuration

Wardrobe uploads support JPEG, PNG, WebP and HEIC/HEIF through the file picker, drag-and-drop and paste. JPEG, PNG and WebP files up to 2 MB are uploaded byte-for-byte unchanged, including their resolution, transparency and metadata. Larger files are compressed locally to at most 2 MB, with a maximum 2,400-pixel edge; PNG/WebP compression preserves transparency. HEIC is converted locally to JPEG for compatibility, keeping its resolution when the converted file fits the limit. Inputs are limited to 50 MB and 64 megapixels. The importer then uses its existing lossless PNG normalization and review workflow.

| Variable | Default |
| --- | --- |
| `OPENAI_API_KEY` | Required |
| `OPENAI_VISION_MODEL` | `gpt-5.6-luna` |
| `OPENAI_IMAGE_MODEL` | `gpt-image-2.5-sunburst` |
| `OPENAI_IMAGE_QUALITY` | `high` |
| `WARDROBE_MODEL_REFERENCE` | `data/model-reference.png` |
| `WARDROBE_DATA_DIR` | `data` |

The web importer and outfit generator use these values from `.env` when Vite starts; restart after changing them. `OPENAI_GARMENT_MODEL` and `OPENAI_MODELED_MODEL` can override the image model for each stage. Outfit planning uses `OPENAI_VISION_MODEL`; outfit photographs use `OPENAI_MODELED_MODEL`, falling back to `OPENAI_IMAGE_MODEL`. `OPENAI_API_BASE_URL` optionally overrides the API base URL (default `https://api.openai.com/v1`). Keys remain on the server. The import and outfit Codex skills use Codex's Imagegen tool, whose model is selected by Codex rather than this app's `.env`. The Shopping Assistant skill normally gives advice directly in Codex without a separate app API call.

To offer additional model reference photos, add `data/model-reference-2.png`, `data/model-reference-3.png`, and so on (or place them in `WARDROBE_DATA_DIR` if configured). The photo set by `WARDROBE_MODEL_REFERENCE` stays the default. Choose a thumbnail in the importer's **Model reference** picker before approving a garment or regenerating its modeled image. One reference is used per generation; the choice is saved with the import and reused on retries. Use **Refresh photos** to discover newly added files without restarting. Photos stay local and must not be committed to Git.

See [model migration and prompt checks](docs/model-migration.md) for compatibility notes and a repeatable visual comparison. Run `npm test` for local API contract tests and `npm run check` for the production build.

## Outfit collections

Open **Outfits** or visit `/outfits` to browse the saved collection. Open a look to see its full photograph, styling notes, and the wardrobe pieces it uses. Collections written by the Codex outfit skill are loaded from `data/outfits.json`; their images are served from `data/outfit-images/`.

Below the pieces in a saved look, choose **Suggest accessories** for a short list of optional finishing touches. This sends the existing outfit photo to `OPENAI_VISION_MODEL` (default `gpt-5.6-luna`) through the configured API and returns text only. Suggestions are stored locally in `data/outfit-accessories.json` and reused when you reopen the look; changing the photo, configured vision model, styling context, or accessory recipe makes fresh suggestions available. Outfit photographs and wardrobe records are not modified.

Choose **Generate outfits**, enter a count from 1 to 12, add optional styling direction, and choose a model reference. Planning uses the actual garment images and metadata, then creates one square modeled photograph per combination. Each outfit contains one top and one bottom, with optional outerwear, shoes, and an accessory. New combinations avoid the existing collection and active candidates.

Generation progress and review candidates persist in `data/outfit-jobs/`. Review each image against its wardrobe references, then accept it into the collection, reject it, or retry with a specific correction. Accepting adds the new look while preserving existing outfits. An interrupted request becomes a retryable failure on server restart; restarting never automatically repeats paid API calls. Use the retry control to continue failed work.

All collection data, source images, references, and generated photographs stay in the ignored local `data/` directory. Generating sends the selected reference and garment images to the configured API. The gallery works without an API key; generation needs a configured key, a model reference, and enough unused top-and-bottom combinations.

### Saving Codex collections and recovering local data

The app permits one outfit writer process per configured data directory. Stop its Wardrobe server before saving a reviewed Codex batch, then run this command from the repository root:

```sh
node scripts/save-outfit-collection.mjs /path/to/staged/outfits.json
```

The staged version-1 manifest must contain accepted records whose PNGs are under its sibling `outfit-images/` directory; keep the entire staging directory outside live data. The helper reads `WARDROBE_DATA_DIR` from the environment or `.env` (or accepts `--data-dir PATH`), adds records to the existing collection, and uses immutable image filenames. Identical retries succeed; conflicting IDs or image contents are rejected. Restart the server after saving. Use this helper instead of editing the live manifest or replacing images directly.

Writer ownership is recorded in `.outfit-store.lock`. A provably dead process on the same host can be recovered automatically; unreadable locks, locks from another host, and interrupted `.outfit-store.recovery` guards require inspection with all writers stopped. Never delete a live process's lock or run two app copies against the same directory.

Back up the **whole configured data directory together**, with the server stopped: `outfits.json`, `outfit-jobs/` (including candidates and job state), `outfit-images/`, `outfit-accessories.json`, the wardrobe library, imported images, and local references. Back up separately configured model-reference files too. Atomic file replacement helps interrupted writes, but does not replace backups or guarantee survival after power loss. Restore a consistent backup together and exclude transient `.outfit-store.lock`, `.outfit-store.recovery`, and `.outfit-store-owner-*.tmp` files from restores; acquire fresh ownership when the app starts.

Damaged collection or job files are reported and preserved for repair or restoration. A missing manifest with surviving outfit images or jobs is treated as missing data, not a new empty wardrobe. Unsupported future versions must remain untouched; use a compatible app version. Any future migration should back up the original first, validate records before and after conversion, and preserve unknown fields.

Invalid individual accessory suggestions become cache misses. If the entire `outfit-accessories.json` is corrupt, stop the server, preserve a copy, and inspect it. For malformed JSON or a damaged version-1 cache, move the file aside under a distinct backup name, then restart and request suggestions explicitly; this only rebuilds optional suggestions. Leave a readable unsupported-version cache untouched and use a compatible app version. Do not reset collection or job files as part of accessory-cache recovery.

## Shopping assistant

Open **Shopping** or visit `/shopping`. Choose, drop or paste a listing screenshot or an in-store garment photo, select a model reference, and optionally describe the occasion, price or fit you have in mind. Choose **Check this piece** for a recommendation, visual styling considerations, possible wardrobe overlap, and combinations using your existing pieces. Unclear images can produce **A closer look is needed** rather than a purchase recommendation. Advice cannot establish exact sizing, fabric quality or value from a photograph alone.

Photos are prepared on your device before upload. JPEG, PNG, WebP and HEIC/HEIF inputs up to 50 MB are accepted; decoded images are limited to 64 megapixels. The browser resizes to a maximum 1,600-pixel edge, re-encodes to JPEG under 2 MB, and drops embedded metadata such as EXIF location. HEIC conversion uses native browser decoding when available, with the lazily loaded [heic-to decoder](https://github.com/hoppergee/heic-to) as a local fallback. The server validates and normalizes the image again before analysis.

Analysis uses `OPENAI_VISION_MODEL` and the same API key and reference settings as Outfits. Pressing the check button sends the prepared image, chosen model reference, notes, and labeled wardrobe image sheets to the configured API. Browser edits and deletions are reflected in the comparison; item images are resolved from the local library. Shopping does not add purchases to the wardrobe. Drafts and results remain in memory while switching tabs, and are cleared on page reload; shopping uploads and results are not saved to `data/`. An API key, a model reference and readable wardrobe images are required. Requests are never automatically retried.

## License

[MIT](LICENSE)

Open a saved wardrobe item and choose **Regenerate modelled shot** to choose a model reference and optional direction. The existing shot stays in place while a replacement is generated and reviewed; **Approve** replaces it and **Reject** keeps the original. Items without a shot offer **Create modelled shot**.
