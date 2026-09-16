# Storage for Wardrobe project skills

Read this before obtaining wardrobe context or saving a skill's results. The migrated wardrobe at https://wardrobe-snowy-rho.vercel.app is the default target. Local `data/` is an independent snapshot, not a mirror of production. Use local mode only when the user asks to work locally. A failed cloud connection is not a reason to substitute local data.

## Read the current wardrobe

Use a signed-in browser for the current app state. For native image review and Imagegen references, take a task snapshot of the original cutouts, available identity references, and saved outfit metadata:

```sh
WORK="$(mktemp -d "${TMPDIR:-/tmp}/wardrobe-skill.XXXXXX")"
node --env-file=.env.cloud scripts/skill-snapshot.mjs \
  --target cloud --out "$WORK/snapshot"
```

Run from the repository root with Node 22 or newer. The ignored `.env.cloud` needs the existing production `DATABASE_URL` and `BLOB_READ_WRITE_TOKEN`; do not print values, put them in commands, or commit the file. These helpers do not need the OpenAI key. If credentials are unavailable, use the authenticated app and its supported tools, or obtain the missing access. Do not initialize another database, weaken Vercel protection, or copy a stale library into production.

The snapshot command reads cloud storage without changing it. It refuses an existing output directory and checks for changes while copying. A successful snapshot has a final `snapshot.json` containing its target, capture time, reference IDs and file hashes. On failure, retain any partial files for diagnosis but do not treat them as a complete inventory; retry into a fresh directory. It is a task snapshot, not a backup: it omits jobs, modeled garment photos and outfit image files.

| Snapshot content | Use |
| --- | --- |
| `library.json` | Current saved owned items and stable IDs |
| `imported/FILENAME` | Original for a library record's `/api/import/library/FILENAME` |
| `outfits.json` | Saved outfits, reserved IDs and previous garment combinations |
| `model-reference.png` | Original reference with ID `default`, if present |
| `model-reference-N.png` | Additional original reference with ID `model-reference-N`, N ≥ 2 |
| `snapshot.json` | Successful capture marker, target and available reference mapping |

Honor the user's selected reference or the current app selection. Otherwise use `default` and identify the choice briefly. If it is unavailable, ask for the intended reference instead of silently substituting another person. Read references from the selected store; a laptop's `WARDROBE_MODEL_REFERENCE` does not configure the hosted app.

Name/category/colour/tag edits and hidden items are now shared in the stored library. The app migrates older browser-only edits when that browser next opens the upgraded app, retaining newer shared edits if they conflict. Task snapshots include the current shared metadata and exclude hidden/deleted records and their cutouts. Outfit publication rechecks that selected garments are still visible in the live library. Do not fabricate ownership from an image path or restore hidden items merely because they remain in storage.

## Images and privacy

Keep original PNGs for generation, exact colour work, and final saves. WebP URLs with `format=webp&w=320`, `640`, or `1280` are display derivatives, not replacements for originals. The app creates private derivatives as needed and revalidates browser caches; skills must not rewrite originals as WebP or publish public Blob URLs. The model-reference HTTP route without display parameters is an existing small preview, so use the snapshot's original reference for Imagegen rather than that thumbnail.

Treat downloaded references and task snapshots as private working copies. Keep them outside the repository's tracked files and do not commit personal photos, generated results, snapshots or credentials. Identity/source images remain unchanged. Generation may send selected references to the authorized image provider; do not describe that as local-only processing.

## Save reviewed results

The project import and outfit-save commands support `--target cloud` and `--dry-run`. Dry runs validate input and read the destination, but do not publish files or acquire the cloud writer lease. A real cloud save acquires the same fenced writer lease as the hosted app, re-reads the latest destination, publishes immutable image files, then updates its manifest. It does not replace the destination with the curation snapshot.

Use the command in the relevant skill. Keep generation and visual QA outside the lease. If the store is busy, retain the staged results and retry after the active operation finishes; never delete a lease or lock. Do not stop Vercel or restart the laptop's dev server for a cloud save. Refresh the authenticated production app and verify returned IDs, new item counts, and original/display images after saving. No deployment is needed for data updates.

An identical save can be retried without duplicate records. Check the latest records after an uncertain outcome before retrying. Conflicting outfit IDs fail; import IDs derive from cutout content, so reimporting identical cutouts intentionally updates their metadata and supplied modeled photos while retaining unrelated records and fields. Physical-item deduplication still requires source review.

Do not use `scripts/migrate-to-cloud.mjs` for ongoing sync or skill delivery. It is the initial migration tool, not a merge/publish helper. Do not issue ad hoc SQL, replace `library.json`/`outfits.json` from a downloaded snapshot, or garbage-collect originals/derivatives during a skill task.

## Using the app's generation workflow

Native skill/Imagegen work and an app API generation are separate workflows. For an app request, use its authenticated UI, selected reference and configured models. The hosted app uses durable jobs; poll/reopen the same job after a disconnect rather than submitting the generation again. It requires review/acceptance before a result enters the saved collection. A timeout does not prove a paid request failed. The app's daily dispatch guard does not apply to native Imagegen calls.

Read `scripts/import-job-api.mjs`, `scripts/outfit-api.mjs` or `scripts/shopping-api.mjs` for current request contracts when automating an API. API routes remain protected by Vercel Authentication; previews deliberately lack production API access. Prefer the signed-in browser. When using Vercel CLI access, follow the Vercel CLI skill, keep any temporary automation credential secret, and revoke only the credential created for the task afterward. Never make images public to make a tool fetch succeed.

## Explicit local mode

Replace `--target cloud` with `--target local` and omit `--env-file=.env.cloud`. Local helpers honor `WARDROBE_DATA_DIR` from the environment or repository Vite development env, defaulting to `data`; `--data-dir PATH` overrides it. The default local identity reference is separately resolved from `WARDROBE_MODEL_REFERENCE`, default `data/model-reference.png`, relative to the repository root. The snapshot records the resolved copy as `model-reference.png`.

Stop the local Wardrobe server before a local save so the shared filesystem writer lock can be acquired; never bypass a live lock. Read-only snapshots and dry runs do not need a server restart. Local results remain local and must be described that way. Keeping a local copy does not back up or update the live site.

See [HOSTING.md](HOSTING.md) for infrastructure, migration, retained data and release details. Those maintenance operations are outside an ordinary import, outfit or shopping task.
