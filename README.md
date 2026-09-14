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

## Import with Codex

This repo includes two Codex skills: one imports clothes and generates modeled item photos; the other styles complete outfits and generates a modeled lookbook.

```text
$import-clothes Import the clothes from ~/Pictures/outfits, create modeled photos, and add them to this wardrobe.
$generate-outfits Create modeled outfit ideas from my wardrobe.
```

Open the cloned repo in Codex and run either prompt. The import skill asks for a local model-reference PNG when needed, reviews every cutout and modeled photo, then writes to `data/library.json` and `data/imported/`. The outfit skill asks how many looks to create, then curates, generates, verifies, and saves the complete collection under `data/`.

### For agents

If you are setting up Wardrobe for a user, ask how they want to import their clothes:

- **Codex:** Ask for a folder or camera-roll location and a model-reference PNG, then extract, model, and import the individual pieces by following [the bundled import skill](.agents/skills/import-clothes/SKILL.md). Afterward, offer to create a requested number of modeled looks with [the outfit-generation skill](.agents/skills/generate-outfits/SKILL.md).
- **Web UI:** Help the user configure their own `OPENAI_API_KEY` and `data/model-reference.png`, then let them import through the app.

## What it does

- Detects every garment in a photo with the OpenAI Responses API
- Extracts clean product cutouts with the OpenAI Images API
- Offers **Use original image** for a likely single-item product shot on white or transparent background; this skips generative extraction and preserves the uploaded image for review. **Extract garment** remains available and is the default for ordinary photos.
- Generates an optional modeled editorial preview
- Shows saved outfit collections with their styling notes and exact wardrobe pieces
- Curates and generates new outfits through the configured API, with progress, retries, and review before saving
- Keeps originals, jobs, generated images, and the JSON database local in `data/`
- Supports drag, drop, paste, editing, review, regeneration, and approval
- Filters Tops, Dresses, Jackets, Bottoms, Accessories, and Shoes. Existing dresses filed under Tops can be moved to Dresses in the item editor.

## Configuration

| Variable | Default |
| --- | --- |
| `OPENAI_API_KEY` | Required |
| `OPENAI_VISION_MODEL` | `gpt-5.6-luna` |
| `OPENAI_IMAGE_MODEL` | `gpt-image-2.5-sunburst` |
| `OPENAI_IMAGE_QUALITY` | `high` |
| `WARDROBE_MODEL_REFERENCE` | `data/model-reference.png` |
| `WARDROBE_DATA_DIR` | `data` |

The web importer and outfit generator use these values from `.env` when Vite starts; restart after changing them. `OPENAI_GARMENT_MODEL` and `OPENAI_MODELED_MODEL` can override the image model for each stage. Outfit planning uses `OPENAI_VISION_MODEL`; outfit photographs use `OPENAI_MODELED_MODEL`, falling back to `OPENAI_IMAGE_MODEL`. `OPENAI_API_BASE_URL` optionally overrides the API base URL (default `https://api.openai.com/v1`). Keys remain on the server. The bundled Codex skills use Codex's Imagegen tool, whose model is selected by Codex rather than this app's `.env`.

To offer additional model reference photos, add `data/model-reference-2.png`, `data/model-reference-3.png`, and so on (or place them in `WARDROBE_DATA_DIR` if configured). The photo set by `WARDROBE_MODEL_REFERENCE` stays the default. Choose a thumbnail in the importer's **Model reference** picker before approving a garment or regenerating its modeled image. One reference is used per generation; the choice is saved with the import and reused on retries. Use **Refresh photos** to discover newly added files without restarting. Photos stay local and must not be committed to Git.

See [model migration and prompt checks](docs/model-migration.md) for compatibility notes and a repeatable visual comparison. Run `npm test` for local API contract tests and `npm run check` for the production build.

## Outfit collections

Open **Outfits** or visit `/outfits` to browse the saved collection. Open a look to see its full photograph, styling notes, and the wardrobe pieces it uses. Collections written by the Codex outfit skill are loaded from `data/outfits.json`; their images are served from `data/outfit-images/`.

Choose **Generate outfits**, enter a count from 1 to 12, add optional styling direction, and choose a model reference. Planning uses the actual garment images and metadata, then creates one square modeled photograph per combination. Each outfit contains one top and one bottom, with optional outerwear, shoes, and an accessory. New combinations avoid the existing collection and active candidates.

Generation progress and review candidates persist in `data/outfit-jobs/`. Review each image against its wardrobe references, then accept it into the collection, reject it, or retry with a specific correction. Accepting adds the new look while preserving existing outfits. An interrupted request becomes a retryable failure on server restart; restarting never automatically repeats paid API calls. Use the retry control to continue failed work.

All collection data, source images, references, and generated photographs stay in the ignored local `data/` directory. Generating sends the selected reference and garment images to the configured API. The gallery works without an API key; generation needs a configured key, a model reference, and enough unused top-and-bottom combinations.

## License

[MIT](LICENSE)

Open a saved wardrobe item and choose **Regenerate modelled shot** to choose a model reference and optional direction. The existing shot stays in place while a replacement is generated and reviewed; **Approve** replaces it and **Reject** keeps the original. Items without a shot offer **Create modelled shot**.
