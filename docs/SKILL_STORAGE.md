# Storage for Wardrobe project skills

Read this before obtaining wardrobe context or saving a skill's results. The [hosted wardrobe](https://wardrobe.iriss.dev/) is the default target. Local `data/` is an independent snapshot, not a production mirror. Use local mode only when the user requests it; never substitute local data after a cloud connection fails.

## Read the current wardrobe

Use a signed-in browser for the current app state. For image review and Imagegen references, snapshot the original cutouts, available identity references, and saved outfit metadata:

```sh
WORK="$(mktemp -d "${TMPDIR:-/tmp}/wardrobe-skill.XXXXXX")"
node --env-file=.env.cloud scripts/skill-snapshot.mjs \
  --target cloud --out "$WORK/snapshot"
```

Run from the repository root with Node 22.x. The ignored `.env.cloud` needs the existing production `DATABASE_URL` and `BLOB_READ_WRITE_TOKEN`; never print their values, put them in commands, or commit the file. The helpers need no OpenAI key. If credentials are unavailable, use the authenticated app or obtain the missing access. Do not initialize another database, weaken Vercel protection, or copy a stale library into production.

The command leaves cloud storage unchanged and acquires no lease. `--out` must be a new directory whose parent already exists. It checks for source changes while copying and writes `snapshot.json` last, recording the target, capture time, reference IDs and file hashes. On failure, retain partial files for diagnosis and retry into a fresh directory; only a directory with the completion marker is a usable snapshot. Snapshots omit jobs, modeled garment photos and outfit images, so they are not backups.

To reuse downloads, add `--reuse /path/to/previous/snapshot` and keep `--out` new. The earlier snapshot must be complete and use the same target. Metadata and image identities are fetched fresh; cached originals are copied only when their SHA-256, size and current immutable Blob identity match. Changed, missing or corrupt cached files are downloaded again. Snapshots without identity metadata and mutable local files fall back to source reads. Reuse leaves the earlier snapshot untouched and retains all consistency checks.

| Snapshot content | Use |
| --- | --- |
| `library.json` | Current visible owned items and stable IDs |
| `imported/FILENAME` | Original for a library record's `/api/import/library/FILENAME` |
| `outfits.json` | Saved outfits, reserved IDs and previous garment combinations |
| `model-reference.png` | Original reference with ID `default`, if present |
| `model-reference-N.png` | Additional original reference with ID `model-reference-N`, N ≥ 2 |
| `snapshot.json` | Successful capture marker, target and available reference mapping |

Honor the user's selected reference or current app selection. Otherwise use `default` and briefly identify that choice. If it is unavailable, ask for the intended reference; never silently substitute another person. Read references from the selected store: the laptop's `WARDROBE_MODEL_REFERENCE` does not configure the hosted app.

Name/category/colour/tag edits and hidden state are shared in the stored library. The app migrates older browser-only edits on opening, preserving records already edited in shared storage. Snapshots include shared metadata and omit hidden/deleted records and their cutouts. Cloud outfit saves recheck that selected garments remain visible in the live library. An image path alone does not establish ownership; do not restore hidden items because their files remain in storage.

## Images and privacy

Keep original PNGs for generation, exact colour work and final saves. URLs with `format=webp&w=320`, `640` or `1280` return private display derivatives with browser cache revalidation. Do not replace originals with WebP or publish public Blob URLs. The model-reference HTTP route without display parameters returns a small preview; use the snapshot's original reference for Imagegen.

Keep snapshots, downloaded references, personal photos, generated results and credentials private and outside tracked files. Preserve identity/source images unchanged. Generation may send selected references to the authorized image provider; it is not local-only processing.

## Save reviewed results

The [import](../scripts/import-reviewed-clothes.mjs) and [outfit-save](../scripts/save-outfit-collection.mjs) commands support `--target cloud --dry-run`. Dry runs validate inputs and read the destination without publishing files or acquiring its writer lease. A real cloud save acquires the hosted app's fenced writer lease, re-reads the destination, publishes immutable images, then updates the latest manifest. It never replaces the destination with the curation snapshot.

Use the command in the relevant skill, keeping generation and visual QA outside the lease. If the store is busy, retain staged results and retry after the active operation finishes; never delete a lease or lock. Cloud saves need no server restart or deployment. After saving, refresh the authenticated production app and verify returned IDs, added item counts, and original/display images.

Check live records before retrying an uncertain save. Identical saves do not duplicate records. Conflicting outfit IDs fail; import IDs derive from cutout content, so reimporting an identical cutout updates its metadata and any supplied modeled photo while retaining unrelated records and fields. Physical-item deduplication still requires source review.

Use `scripts/migrate-to-cloud.mjs` only for initial migration, never ongoing sync or skill delivery. During a skill task, do not issue ad hoc SQL, replace `library.json`/`outfits.json` from a snapshot, or garbage-collect originals/derivatives.

## Using the app's generation workflow

Native Imagegen and app API generation are separate workflows. App requests use the authenticated UI, selected reference and configured models. Hosted jobs are durable: after a disconnect, poll or reopen the same job instead of submitting again. Results require review/acceptance before entering the saved collection. A timeout does not prove a paid request failed, and the app's daily API limits do not cover native Imagegen calls.

For API automation, read the current [import](../scripts/import-job-api.mjs), [outfit](../scripts/outfit-api.mjs) or [shopping](../scripts/shopping-api.mjs) contract. Routes use Vercel Authentication; previews deliberately lack production API access. Prefer the signed-in browser. For Vercel CLI access, follow its skill, protect temporary automation credentials, and afterward revoke only those created for the task. Never make images public to enable a tool fetch.

## Explicit local mode

Use `--target local` and omit `--env-file=.env.cloud`. The data directory is selected in this order: `--data-dir PATH`, environment `WARDROBE_DATA_DIR`, repository Vite development env, then `data`. Relative paths resolve from the repository root. `--data-dir` is invalid with `--target cloud`.

The default identity reference is resolved separately from environment `WARDROBE_MODEL_REFERENCE`, repository Vite development env, then `data/model-reference.png`. Changing the data directory does not relocate this default; set both when isolating a local task. The snapshot names its copy `model-reference.png`.

Stop the local Wardrobe server before saving so the helper can acquire its shared filesystem writer lock; never bypass a live lock. Snapshots and dry runs need no restart. Describe local results as local: they neither back up nor update the live site.

See [HOSTING.md](HOSTING.md) for infrastructure, migration, retained data and release details. Those maintenance operations are outside an ordinary import, outfit or shopping task.
