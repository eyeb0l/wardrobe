<div align="center">

# Wardrobe

Import your clothes, create modeled outfits, and assess potential purchases against what you own.

[Open Wardrobe →](https://wardrobe.iriss.dev/) · Private access through Vercel Authentication.

[![License: MIT](https://img.shields.io/badge/license-MIT-191919?style=flat-square)](LICENSE)
[![Node 22](https://img.shields.io/badge/node-22.x-191919?style=flat-square)](package.json)

[Original project post →](https://x.com/cdngdev/status/2076812846793650485)

</div>

![Wardrobe gallery](docs/screenshots/gallery.png)

![Modeled wardrobe editor](docs/screenshots/editor.png)

## Run locally

Requires Node.js 22.x and npm.

```bash
git clone https://github.com/eyeb0l/wardrobe.git
cd wardrobe
npm ci
cp .env.example .env
npm run dev
```

Open [localhost:5173](http://localhost:5173). Browsing saved clothes and outfits needs no API key. To enable the web importer, add `OPENAI_API_KEY` to `.env`, place a PNG identity reference at `data/model-reference.png`, and restart.

Local development uses the configured data directory; it does not sync with the hosted wardrobe. For private access across devices, follow the [Vercel hosting guide](docs/HOSTING.md), including authentication, cloud storage and the initial data copy.

## Storage and privacy

| Mode | Persistent storage |
| --- | --- |
| Local app | `data/`, or `WARDROBE_DATA_DIR`: library, jobs, originals, generated images and accessory suggestions |
| Hosted app | Neon Postgres for records and jobs; private Vercel Blob for images, behind Vercel Authentication |
| Codex skills | The hosted wardrobe by default; local storage only when explicitly requested |

Generating or analyzing sends the relevant images and context to the configured API. Keys stay on the server. Keep credentials, identity photos, snapshots and generated assets out of Git. Shopping drafts and results remain in browser memory and disappear on reload in either mode.

Use the [backup guide](docs/BACKUPS.md) for cloud backups and recovery, and the [local storage guide](docs/LOCAL_STORAGE.md) for local writer locks, consistent backups and damaged-file recovery.

## Import and edit clothes

The importer detects up to eight visible clothing items per photo with the Responses API, then creates product cutouts and modeled previews with the Images API. Review each stage before approval. It supports drag-and-drop, paste, metadata editing, regeneration and manual modeled-photo uploads.

For difficult detections, choose **Retry with Sol** in crop review or after a no-clothing result. This paid retry uses Sol at medium effort; review its candidates before replacing the crop. Luna remains the default. See [retry behaviour and limits](docs/terra-detection-retry.md).

New generated cutouts request a transparent PNG from Sunburst, then correct near-opaque garment interiors locally before normal review. Light/dark backgrounds and zoom help inspect edges and details. Older chroma-key jobs retain their automatic and manual edge cleanup controls. Both paths resume from saved bytes without another generation charge; saved wardrobe images are not changed retroactively. See [automatic garment cleanup](docs/automatic-garment-cleanup.md) for checks and recovery behaviour.

For a likely single-item product shot, **Use original image** skips generative extraction. Existing transparency is preserved; opaque backgrounds are removed on the device with a browser worker, then shown against a checkerboard for review. Only a transparency mask is returned to the app: garment colours and dimensions come from the stored original. **Extract garment** remains the default for ordinary photos. If detection gets it wrong, you can manually select **Use original image** after checking that the full original contains one isolated item without a person or other products.

Browser removal uses Transformers.js 4.3.0 (Apache-2.0) and the MIT-licensed [BiRefNet_lite 512 ONNX model](https://huggingface.co/studioludens/birefnet-lite-512), pinned to revision `4a3c40c36c94093cc1e724d9ea428b8fa4b57dc7`. The first opaque photo downloads approximately 175 MiB of weights plus the browser runtime; weights are cached where browser storage permits. Model assets come from Hugging Face; the photograph stays on the device during inference. No generative API request or background-removal service is used. A worker keeps the UI responsive and supports cancellation; failures leave the crop unchanged and never automatically spend credits on extraction. Vercel hosts the JS/WASM files and saves the mask result through the existing authenticated API. Inference is independent of Vercel function execution limits. Mobile speed and memory use vary by device.

The gallery filters Tops, Dresses, Jackets, Bottoms, Accessories and Shoes. Reclassify existing dresses in the item editor. Open a saved item and choose **Update modelled shot** or **Create modelled shot** to select a reference and optional direction. A replacement remains a review candidate until **Approve**; **Reject** keeps the existing photo.

### Upload preparation

The file picker, drop and paste accept JPEG, PNG, WebP and HEIC/HEIF sources up to 50 MB and 64 megapixels. Import uploads preserve JPEG/PNG/WebP files of at most 2 MB byte-for-byte, including resolution, transparency and metadata. Larger files are compressed locally to at most 2 MB and a 2,400-pixel edge; PNG/WebP compression preserves transparency. HEIC converts locally to JPEG; a source of at most 2 MB keeps its resolution if the converted result also fits. The server normalizes import images to PNG before review.

Modeled-photo and Shopping uploads use their own preparation rules below.

## Outfit collections

Open **Outfits** or `/outfits` to browse photographs, styling notes and the exact wardrobe pieces used. Choose **Generate outfits**, request 1–12 looks, add optional styling direction, and select a model reference. Planning uses garment images and metadata; each combination gets a square modeled photograph.

Optional **Find a saved look** searches your accepted outfits with a brief such as “dinner, slightly overdressed, but not corporate.” Refine the matches toward understated or statement looks, or favour pieces that appear in fewer saved outfits. Open a saved look and use **Change one piece** to compare replacement cutouts from your own wardrobe. Suggestions do not alter the saved outfit or generate photographs. Enable these features with the server-only TypeSafe key and flag described in [Outfit discovery](docs/OUTFIT_DISCOVERY.md).

The web generator requires exactly one top and one bottom per look, with at most one outer layer, one pair of shoes and one accessory. It currently excludes dresses. Top-and-bottom pairs must differ from saved looks and active candidates; changing optional pieces does not make a pair new. Generation requires an API key, a reference and enough unused pairs.

Jobs and review candidates persist in the selected store. Accept each reviewed look into the collection, reject it, or retry with a correction. Acceptance preserves existing looks. In local mode, interrupted generation becomes retryable after server restart. Hosted jobs run through durable workflows; an uncertain started API call is failed for review, never automatically repeated. Check API usage before explicitly retrying an interrupted paid request.

In a saved look, **Suggest accessories** sends its photograph and styling context to `OPENAI_VISION_MODEL` for text-only suggestions. They are saved and reused in the selected store. A changed photograph, vision model, styling context or accessory recipe makes fresh suggestions available. This does not alter photographs or wardrobe records.

## Manual modeled photos

After failed generation, **Copy prompt** copies the recorded attempt, including its correction, without an API call. Supply the referenced images separately to your chosen image tool, then use **Upload modeled photo** to crop and review the result. Wardrobe pieces use horizontal 3:2 crops; outfits use square crops. Uploading creates a candidate; **Approve** or **Accept into collection** saves it.

See [manual modeled photos](docs/MODELED_PHOTOS.md) for prompt availability, reference order, crop controls, image limits and contributor API details.

Image generations also collect private [refusal and retry telemetry](docs/GENERATION_TELEMETRY.md), including eventual recovery and manual fallback. The read-only report separates models, generation types and garment categories without duplicating prompts.

## Shopping assistant

Open **Shopping** or `/shopping`, choose/drop/paste a listing screenshot or garment photo, select a model reference, and optionally add the occasion, price or fit you have in mind. **Check this piece** returns a recommendation, styling considerations, overlap and combinations with owned pieces. Unclear evidence may produce **A closer look is needed**; photographs alone cannot establish exact sizing, fabric quality or value.

Shopping accepts the source formats and limits above, but always prepares a JPEG locally at a maximum 1,600-pixel edge and under 2 MB, removing embedded metadata such as EXIF location. HEIC uses native decoding when available and a lazily loaded local decoder otherwise. The server validates and normalizes the image again.

Analysis uses `OPENAI_VISION_MODEL`, the prepared photo, selected reference, notes and labeled wardrobe image sheets. It includes current wardrobe edits and deletions from the selected store. An API key, reference and readable wardrobe images are required. Requests are never automatically retried. Shopping does not import purchases or persist its drafts/results; they survive tab switches within the app but not page reloads.

## Use with Codex

Open this repository in Codex and use a bundled skill:

```text
$import-clothes Import the clothes from ~/Pictures/outfits, create modeled photos, and add them to this wardrobe.
$generate-outfits Create 8 modeled outfit ideas from my wardrobe.
$shopping-assistant Would the piece in this screenshot be a good addition to my wardrobe?
$shopping-assistant Review my wishlist in the browser and shortlist the pieces that add the most to my wardrobe.
$shopping-assistant Find a navy wool cardigan under £100 on my preferred sites and compare it with what I own.
```

- [Import Clothes](.agents/skills/import-clothes/SKILL.md) inventories source photos, reviews cutouts and modeled photos, then imports approved results. Cutout-only delivery skips modeled generation and database writes.
- [Generate Outfits](.agents/skills/generate-outfits/SKILL.md) uses the requested count, or asks if it is missing, then curates, generates, reviews and saves the complete batch.
- [Shopping Assistant](.agents/skills/shopping-assistant/SKILL.md) compares candidates with the selected reference and owned clothes. When requested, it reviews live wishlists or retailer listings. Advice does not import purchases or save a Shopping-tab result.

Skills follow the [shared storage workflow](docs/SKILL_STORAGE.md): take a fresh private snapshot, stage results outside the live store, dry-run, then publish with the storage helpers. Cloud is the default; explicitly request local mode for a local-only setup. Cloud access failures must not silently fall back to the local migration copy.

Agents setting up Wardrobe should establish whether the user wants Codex-assisted imports or the web UI, obtain the source folder and identity reference if missing, and follow the relevant setup above. Honor any supplied destination, count and generation scope.

## Configuration

| Variable | Default / purpose |
| --- | --- |
| `OPENAI_API_KEY` | Required for web API generation and analysis |
| `OPENAI_VISION_MODEL` | `gpt-6-luna`; detection, planning, Shopping and accessory advice |
| `OPENAI_IMAGE_MODEL` | `gpt-image-2.5-sunburst`; default image model |
| `OPENAI_GARMENT_MODEL` | Overrides the image model for cutouts |
| `OPENAI_MODELED_MODEL` | Overrides the image model for modeled pieces and outfits |
| `OPENAI_IMAGE_QUALITY` | `high` |
| `OPENAI_API_BASE_URL` | `https://api.openai.com/v1` |
| `WARDROBE_JEV_ENABLED` | `0`; set to `1` to show saved-outfit discovery and owned-item swaps |
| `TYPESAFE_API_KEY` | Separate server-only TypeSafe credential; Jev is pinned to `jev-1.13.0` |
| `WARDROBE_DATA_DIR` | `data`; local storage directory |
| `WARDROBE_MODEL_REFERENCE` | `data/model-reference.png`; local default identity reference |

Local Vite reads `.env` at startup; restart after changes. Hosted configuration uses deployment environment variables; see [Hosting](docs/HOSTING.md). Codex import/outfit skills use Codex Imagegen, whose model is selected by Codex, not these variables. Shopping advice in Codex normally makes no separate app API call.

For additional local references, add `model-reference-2.png`, `model-reference-3.png`, etc. under `WARDROBE_DATA_DIR`. The default remains the path in `WARDROBE_MODEL_REFERENCE`; changing the data directory does not move that default automatically. Choose a thumbnail in **Model reference** before approving a garment or regenerating its modeled image. Each generation uses one reference; imports save the selection for retries. **Refresh photos** discovers added references without restarting. Local reference files do not update hosted references.

See [model compatibility and prompt checks](docs/model-migration.md) for API contracts and visual comparisons, and [Contributing](CONTRIBUTING.md) for development checks.

## License

[MIT](LICENSE)
