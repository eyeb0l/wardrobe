# Configuration, storage and privacy

## Environment variables

| Variable | Default / purpose |
| --- | --- |
| `OPENAI_API_KEY` | Required for web API generation and analysis |
| `OPENAI_DETECTION_MODEL` | `gpt-6.1-terra`; import clothing detection |
| `OPENAI_VISION_MODEL` | `gpt-6-luna`; scene planning, outfit curation, Shopping and accessory advice. Does not affect detection |
| `OPENAI_IMAGE_MODEL` | `gpt-image-2.5-sunburst`; default image model |
| `OPENAI_GARMENT_MODEL` | Overrides the image model for cutouts |
| `OPENAI_MODELED_MODEL` | Overrides the image model for modelled pieces and outfits |
| `OPENAI_IMAGE_QUALITY` | `high` |
| `OPENAI_IMAGE_COMPLEXITY` | Unset, so the model default applies. GPT Image 2.6 only; `low`, `medium` or `high` for new cutouts and modelled images |
| `OPENAI_GARMENT_COMPLEXITY` | Overrides `OPENAI_IMAGE_COMPLEXITY` for cutouts |
| `OPENAI_MODELED_COMPLEXITY` | Overrides `OPENAI_IMAGE_COMPLEXITY` for modelled pieces and outfits |
| `OPENAI_MARKUP_COMPLEXITY` | `low`; marked edits. Does not inherit `OPENAI_IMAGE_COMPLEXITY` |
| `OPENAI_API_BASE_URL` | `https://api.openai.com/v1` |
| `WARDROBE_DECISIONS_ENABLED` | `0`; set to `1` for image-aware saved-look search, owned-piece swaps and optional image checks |
| `OPENAI_DECISIONS_MODEL` | `gpt-6-luna`; uses the existing server-only `OPENAI_API_KEY` |
| `WARDROBE_DATA_DIR` | `data`; local storage directory |
| `WARDROBE_MODEL_REFERENCE` | `data/model-reference.png`; local default identity reference |

The setup flow checks whether the key and reference are present without making a paid API call or validating the key with OpenAI. Local Vite reads `.env` at startup; restart after changes. Hosted configuration uses deployment environment variables; see [Hosting](HOSTING.md). Codex skills select their own image model; see [Using Wardrobe with Codex](CODEX_SKILLS.md).

See [model compatibility and prompt checks](model-migration.md) for API contracts and visual comparisons.

## Model references

To add or replace reference photos from the app, open **Setup & guide → Reference photos**. Choose **Replace** under a photo or **Add another photo**; the app shows the current and new photo side by side and saves only after you confirm. Uploads accept JPEG, PNG, WebP or HEIC (converted in the browser), at least 512 pixels on the shorter side, and are saved as metadata-free PNGs. Imports, retries and new outfits that select a replaced reference use the new photo; photos you've already saved are unchanged. If someone else replaced the same photo since you opened it, the save is refused so you can review the current one. The app writes only inside `WARDROBE_DATA_DIR`: a local default configured elsewhere through `WARDROBE_MODEL_REFERENCE` stays read-only (replace that file directly), and a symbolic link at a reference path is replaced rather than written through.

For additional local references, you can also add `model-reference-2.png`, `model-reference-3.png`, etc. under `WARDROBE_DATA_DIR`. The default remains the path in `WARDROBE_MODEL_REFERENCE`; changing the data directory does not move that default automatically. Choose a thumbnail in **Model reference** before approving a garment or regenerating its modelled image. Each generation uses one reference; imports save the selection for retries. **Refresh photos** discovers added references without restarting. Local reference files do not update hosted references.

## Storage and privacy

| Mode | Persistent storage |
| --- | --- |
| Local app | `data/`, or `WARDROBE_DATA_DIR`: library, jobs, originals, generated images and accessory suggestions |
| Hosted app | Neon Postgres for records and jobs; private Vercel Blob for images, behind Vercel Authentication |
| Codex skills | The hosted wardrobe by default; local storage only when explicitly requested |

Generating or analysing sends the relevant images and context to the configured API. Keys stay on the server. Keep credentials, identity photos, snapshots and generated assets out of Git. Shopping drafts and results remain in browser memory and disappear on reload in either mode.

Weather in **Outfits** is off until you choose a location. The browser then requests forecasts and place searches directly from [Open-Meteo](https://open-meteo.com/) (free, no key; data licensed CC BY 4.0). Coordinates are rounded to about 1 km. The location and the latest forecast are kept in that browser's local storage only; they are not saved to the wardrobe, synced between devices or included in backups. **Stop using weather** removes them. Weather suitability for each look is saved with the outfit like its other details.

Local development uses the configured data directory; it does not sync with the hosted wardrobe. Use the [backup guide](BACKUPS.md) for cloud backups and recovery, and the [local storage guide](LOCAL_STORAGE.md) for local writer locks, consistent backups and damaged-file recovery.
