# Configuration, storage and privacy

## Environment variables

| Variable | Default / purpose |
| --- | --- |
| `OPENAI_API_KEY` | Required for web API generation and analysis |
| `OPENAI_VISION_MODEL` | `gpt-6-luna`; detection, planning, Shopping and accessory advice |
| `OPENAI_IMAGE_MODEL` | `gpt-image-2.5-sunburst`; default image model |
| `OPENAI_GARMENT_MODEL` | Overrides the image model for cutouts |
| `OPENAI_MODELED_MODEL` | Overrides the image model for modelled pieces and outfits |
| `OPENAI_IMAGE_QUALITY` | `high` |
| `OPENAI_API_BASE_URL` | `https://api.openai.com/v1` |
| `WARDROBE_DECISIONS_ENABLED` | `0`; set to `1` for image-aware saved-look search, owned-piece swaps and optional image checks |
| `OPENAI_DECISIONS_MODEL` | `gpt-6-luna`; uses the existing server-only `OPENAI_API_KEY` |
| `WARDROBE_DATA_DIR` | `data`; local storage directory |
| `WARDROBE_MODEL_REFERENCE` | `data/model-reference.png`; local default identity reference |

The setup flow checks whether the key and reference are present without making a paid API call or validating the key with OpenAI. Local Vite reads `.env` at startup; restart after changes. Hosted configuration uses deployment environment variables; see [Hosting](HOSTING.md). Codex skills select their own image model; see [Using Wardrobe with Codex](CODEX_SKILLS.md).

See [model compatibility and prompt checks](model-migration.md) for API contracts and visual comparisons.

## Model references

For additional local references, add `model-reference-2.png`, `model-reference-3.png`, etc. under `WARDROBE_DATA_DIR`. The default remains the path in `WARDROBE_MODEL_REFERENCE`; changing the data directory does not move that default automatically. Choose a thumbnail in **Model reference** before approving a garment or regenerating its modelled image. Each generation uses one reference; imports save the selection for retries. **Refresh photos** discovers added references without restarting. Local reference files do not update hosted references.

## Storage and privacy

| Mode | Persistent storage |
| --- | --- |
| Local app | `data/`, or `WARDROBE_DATA_DIR`: library, jobs, originals, generated images and accessory suggestions |
| Hosted app | Neon Postgres for records and jobs; private Vercel Blob for images, behind Vercel Authentication |
| Codex skills | The hosted wardrobe by default; local storage only when explicitly requested |

Generating or analysing sends the relevant images and context to the configured API. Keys stay on the server. Keep credentials, identity photos, snapshots and generated assets out of Git. Shopping drafts and results remain in browser memory and disappear on reload in either mode.

Local development uses the configured data directory; it does not sync with the hosted wardrobe. Use the [backup guide](BACKUPS.md) for cloud backups and recovery, and the [local storage guide](LOCAL_STORAGE.md) for local writer locks, consistent backups and damaged-file recovery.
