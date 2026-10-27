# Private hosting on Vercel

[Wardrobe](https://wardrobe.iriss.dev/) uses Vercel Authentication for access, Neon for records and job state, and a **private** Vercel Blob store for images. This personal-use setup can run on Vercel Hobby; check current service allowances before assuming it will remain free. OpenAI usage is billed separately.

The primary production address is **https://wardrobe.iriss.dev/**. The existing [Vercel address](https://wardrobe-snowy-rho.vercel.app/) remains available as an alternate address for the same project and cloud wardrobe. Use the primary address in documentation, bookmarks, and browser-based skill workflows.

Manage both addresses under **Vercel → wardrobe → Domains**, connected to **Production**, and keep **Vercel Authentication → All Deployments** enabled for both. The app uses same-origin API and image paths, so adding the custom domain requires no application base-URL change or data migration. Browser-local preferences, caches, and sign-in sessions are separate for each origin.

## Set up the project

1. Create a Vercel project from this repository in your personal account and limit access to yourself. The checked-in configuration uses Node 22.x, `npm run build:vercel`, and `.vercel/output`. Select **Other** if asked for a framework; a plain Vite deployment omits the API and durable jobs.
2. Under **Settings → Deployment Protection**, select **Vercel Authentication → All Deployments**. This protects production domains, generated deployment URLs, and previews; Standard Protection leaves production domains public. All Deployments is available on all plans. Keep shareable bypass links and protection exceptions disabled. [Protection documentation](https://vercel.com/docs/deployment-protection#all-deployments)
3. Connect Neon through the Vercel Marketplace and create a Blob store with **Private** access. Connect both to **Production only** and verify that `DATABASE_URL` and `BLOB_READ_WRITE_TOKEN` have that scope.
4. Add `OPENAI_API_KEY` and any model overrides to **Production only**. Leave `WARDROBE_HOSTED_ENABLED` unset until the data import and access checks below are complete.

The hosted API requires `WARDROBE_HOSTED_ENABLED=1` and `VERCEL_ENV=production`. Preview additionally requires `WARDROBE_PREVIEW_ENABLED=1` and matching `WARDROBE_PREVIEW_NEON_PROJECT_ID`/`NEON_PROJECT_ID` and `WARDROBE_PREVIEW_BLOB_STORE_ID`/`BLOB_STORE_ID` pairs. This makes a mistaken storage connection fail closed. Set the Preview flags only after connecting separate resources, copying data, and verifying that deployment protection covers previews. Vercel supplies `VERCEL_ENV`; do not set it yourself. Vercel enforces authentication before requests reach the app; there is no in-app login. Protect the Vercel account with a passkey or two-factor authentication.

For a Preview copy, connect separate Neon and private Blob resources to **Preview only**. Restore an encrypted cloud backup into those resources so stored Blob URLs point to the Preview store. Copy `OPENAI_API_KEY` and set `OPENAI_VISION_MODEL=gpt-6-luna` in Preview. Set the two expected resource IDs, `WARDROBE_HOSTED_ENABLED=1`, and `WARDROBE_PREVIEW_ENABLED=1` only after the restore succeeds. Preview writes remain in its own resources; refresh the copy manually when needed. Keep both Preview resources private and Vercel Authentication on All Deployments.

For the GPT-6 release, set the existing Production `OPENAI_VISION_MODEL` override to `gpt-6-luna` before creating the new Production deployment. The user-triggered difficult-detection retry is pinned to `gpt-6.1-sol` in code; it needs no separate environment override. Initial clothing detection reads `OPENAI_DETECTION_MODEL`, not `OPENAI_VISION_MODEL`; leave it unset to use the `gpt-6.1-terra` default. Leave `OPENAI_IMAGE_MODEL`, `OPENAI_IMAGE_QUALITY`, storage credentials and the Preview-only flags as configured. A deployment changes code and environment, not saved garment or outfit images.

## Copy the existing wardrobe

Stop the local server, finish or cancel generation, and back up the entire local data directory plus any separately configured reference photos. See [local storage and recovery](LOCAL_STORAGE.md).

Put the production `DATABASE_URL` and `BLOB_READ_WRITE_TOKEN` in an ignored `.env.cloud` file in the repository root. The migration needs no OpenAI key. Git ignores `.env*` except the tracked `.env.example` template; Vercel source uploads exclude all `.env*` files. Never commit credentials.

Run from the repository root with Node 22.x and dependencies installed:

```sh
# Inspect the local snapshot; no cloud writes.
node --env-file=.env.cloud scripts/migrate-to-cloud.mjs data

# Initialize cloud storage, copy files, and verify their bytes.
node --env-file=.env.cloud scripts/migrate-to-cloud.mjs data --apply
```

Replace `data` with your configured directory. The import includes:

- `library.json`, `outfits.json`, `outfit-accessories.json`, and `outfit-prompts.json`;
- `imported/`, `jobs/`, `outfit-images/`, and `outfit-jobs/`;
- `model-reference.png` and `model-reference-N.png`, where `N` is a positive integer.

Dotfiles and transient locks are excluded. References outside the directory are not copied; place the intended hosted default at `model-reference.png` inside it. The hosted server configures its own paths, so do not copy local `WARDROBE_DATA_DIR` or `WARDROBE_MODEL_REFERENCE` overrides into Vercel.

This is an initial copy, not synchronisation. It leaves local originals unchanged, skips identical cloud files, and stops at a differing cloud file without overwriting it. Earlier files may already have copied; rerunning verifies and skips matches. It rejects active generation, symbolic links within the selected data, and a missing library.

After the import succeeds and deployment protection is verified, set `WARDROBE_HOSTED_ENABLED=1` in **Production only** and create a new production source deployment.

## Verify access and generation

In a signed-out/private browser, open both the production domain and its generated deployment URL. The page and a direct API URL such as `/api/import/jobs` must require Vercel sign-in. Then sign in with your account and inspect the wardrobe, references, and existing photos before generating anything.

Only one operation can hold the cloud writer lease. Background image generation and garment cleanup release it during provider waits and image processing, then validate task ownership and the job revision before saving. Other items can be updated during that work. Short storage contention during cleanup previews retries automatically; the same active job stays protected from conflicting edits. No request holds the writer during a provider or retailer call: clothing detection, Sol detection retries (fenced by the job revision, one at a time per item) and accessory suggestions release it after reserving allowance, and Shopping takes only short leases for its allowance. A finished background result waits for a busy writer, such as a backup or the storage cleanup, for as long as its task claim and function time allow (up to about four minutes after a short provider call) instead of 30 seconds. If it still cannot save, it expires its own claim, so the next delivery marks the attempt for review at once, and its workflow sleeps until a live claim ends rather than polling. Reads remain available. Job state survives deployments, and polling the jobs list can recover work saved before dispatch.

An interrupted, uncertain paid request is marked for review rather than repeated automatically. Check provider usage before choosing **Retry**, which starts a new paid request.

### Daily API limits

Hosted requests have separate allowances per UTC calendar day:

| Production variable | Default | Requests counted |
| --- | --- | --- |
| `WARDROBE_DAILY_IMAGE_API_LIMIT` | 40 | Image generation |
| `WARDROBE_DAILY_TEXT_API_LIMIT` | 1,000 | Text/vision, including shopping, accessories, clothing analysis, outfit planning, modelled-photo scene planning, and optional Decisions discovery and image checks |

Set positive integers and redeploy to change them. `WARDROBE_DAILY_API_LIMIT` remains an image-only fallback when the image-specific setting is unset. Legacy aggregate usage counts against images until the next UTC day; text has its own allowance. Backups preserve both counters.

Each provider request reserves allowance immediately before dispatch under the writer lease. Cached suggestions and skipped work use none; failed or uncertain requests still count. A successful modelled-garment attempt uses one text request for scene planning followed by one image request; planning must succeed before image generation starts. Batches may make several calls. These are **request-count limits, not currency budgets**; use provider-side controls too.

### Optional Decisions features

Set the server-only `WARDROBE_DECISIONS_ENABLED=1` flag in the intended environment, then redeploy, to enable image-aware saved-look search, owned-item swaps and optional crop/photo checks. It reuses `OPENAI_API_KEY`; `OPENAI_DECISIONS_MODEL` defaults to `gpt-6-luna`. The feature is off by default. Keep All Deployments authentication enabled. The existing authentication gate, writer lease and text quota reservations protect these endpoints. See [Outfit discovery](OUTFIT_DISCOVERY.md) for visual evidence, limits and validation. The old Jev flag and TypeSafe key are unused. Disable the new flag and redeploy to remove the controls without changing wardrobe data.

For the guarded outfit-review candidate, set `WARDROBE_DECISIONS_OUTFIT_RUBRIC_VERSION=2` in **Preview only**, after verifying the existing isolated Preview storage and protection flags. It additionally requires `VERCEL_ENV=preview` and `WARDROBE_PREVIEW_ENABLED=1`; Vercel supplies `VERCEL_ENV`. Outfit checks use the full photo and selected cutouts in one five-question request. Crop checks and other environments retain version 1. The selected version is exposed as `imageChecks.rubricVersion` by `/api/outfits/config`. Human acceptance and fuller audits remain independent of these suggestions; no check runs automatically.

Shopping additionally requires `WARDROBE_DECISIONS_SHOPPING_OVERLAP_ENABLED=1`. Enable it in the isolated protected Preview first. **Check this piece** follows four stages: an assistant shortlist of up to three authorised owned garments; one Decisions request with independent silhouette, colour/pattern and styling-possibility questions for each cutout; a Decisions evidence/verdict request with the candidate, selected reference and all owned contact sheets; and an assistant explanation constrained to that verdict and a deterministic comparison explanation. Similar silhouettes and different colours can coexist. The shortlist is not an exhaustive duplicate search. No shortlist skips individual comparisons but still evaluates the verdict against the full wardrobe. Refusals or confidence/selected-choice probabilities below the provisional 0.75 thresholds remain unclear; these thresholds have not been calibrated on Shopping. A failed comparison remains unconfirmed. A failed verdict stays unclear and explicitly unavailable, with no assistant-verdict fallback. The assistant cannot override the verdict or comparison explanation. The library, all supplied owned images and selected reference are fenced after every paid stage; changed evidence fails the whole assessment with HTTP 409. Every actual provider dispatch reserves text quota (up to four calls); cached Decisions results reserve no additional call. Private usage purposes are `shopping-overlap` and `shopping-verdict`. Suggestions remain advisory and do not import or buy anything. Disable this additional flag and redeploy to restore the original Shopping assessment.

## Release code and retain data

Run `npm test` and `npm run build:vercel` before release. Push reviewed code to the connected production branch, or make a Vercel CLI source deployment from the project checkout. `build:vercel` builds the frontend, hosted API, and workflows together.

Source deployments preserve Neon and Blob data when storage connections and production environment variables remain unchanged. A deployment rollback changes code, not data. If an older release served this store (for example after a rollback), delete `outfit-jobs/.open-jobs.json` when rolling forward so outfit reservations are rebuilt (see [outfits](OUTFITS.md)). After deploying a release that adds schema, run the [schema upgrade](#schema-upgrades) once. Local `npm run dev` uses its own filesystem; hosted edits and new photos do not appear in local `data/` automatically.

Project skills default to the live cloud wardrobe. Use [skill storage](SKILL_STORAGE.md) for private task snapshots and additive publication of reviewed imports/outfits; do not rerun the initial migration to publish new work. The same helpers support an explicitly selected local store.

Retain the original local backup and set up [encrypted cloud backups](BACKUPS.md). Those commands verify recovery points, restore into a new local directory, and support a reviewed full cloud replacement. Install any daily backup schedule separately on the chosen always-on host.

### Shared wardrobe edits

Names, categories, colours, tags, hidden items, and deletion tombstones live in the shared library. The gallery refreshes on page load, on return to the tab, and every 30 seconds while visible. Stale saves are rejected; close and reopen an item to edit its latest values. Refreshes preserve unfinished text in an open editor. Hidden items are excluded from outfit and shopping inventories.

Older browser-only edits and hidden items migrate on that browser's first opening of the upgraded app. Existing shared edits take precedence. The browser retains a copy under `open-wardrobe-legacy-backup-v1`; failed migrations keep the original keys and retry on refresh. Deletion tombstones prevent delayed imports or migrations from resurrecting items. Sync applies to devices using the same store; local development remains separate.

### Modelled-photo prompts

Modelled garment generation plans a fresh setting using the configured vision model, reviewed cutout, user direction, and known previous settings. There is no backdrop catalogue. The app and import-clothes skill share planning and image prompts through `scripts/modeled-photo-prompts.mjs`; the prompt CLI renders them without API calls. Approved app and skill imports retain `modeledSetting` for later planning, while older photos without it remain usable. See [modelled photos](MODELED_PHOTOS.md) for the review and manual-upload workflow.

## Display images and transfer usage

Original PNGs are retained for generation, downloads, and precise colour sampling. Gallery images, outfit photos, references, and import previews use responsive WebP copies at widths of 320, 640, or 1280 pixels, without enlarging smaller originals. Encoding uses quality 85 and alpha quality 100. Originals are never recompressed or made public.

Private Blob stores the copies; `wardrobe_image_variants` indexes them separately. A missing size is generated on first display through the same authenticated API route. Compression makes no paid model calls. The table is part of the [schema upgrade](#schema-upgrades). To prepare existing images ahead of first display:

```sh
# Read-only inventory.
node --env-file=.env.cloud scripts/warm-display-images.mjs

# Prepare all display sizes; resumable. Also creates the cache tables if missing.
node --env-file=.env.cloud scripts/warm-display-images.mjs --apply
```

Warmup is optional and leaves originals unchanged; unused originals and derivatives are eligible for the cleanup below. Until the schema upgrade creates `wardrobe_contact_tiles`, contact sheets still work but every run downloads and decodes the originals again.

### Caching and read behaviour

- **Private image responses:** originals and WebP use `private, no-cache` and an ETag derived from immutable object identity. A matching revalidation returns 304 without downloading image bytes. Routes still check current file references and any required manifest membership first. No private response enters the public CDN cache.
- **Blob reads:** immutable upload URLs permit private Blob CDN caching. Each warm storage client also retains at most 64 MiB / 256 image entries, with an 8 MiB maximum per entry, and coalesces concurrent reads of the same object. Database path lookups remain fresh, so replacement/deletion takes effect immediately. Backup downloads and restored-upload integrity checks bypass both caches.
- **Workers:** a warm worker reuses its bounded storage client, but each step acquires a fresh fenced lease and reads current task/file metadata. Separate instances and explicitly supplied stores do not share caches. Allow for repeated downloads on cold starts; there is no durable worker cache.
- **Metadata reads:** outfit/Shopping settings check file existence instead of downloading originals for dimensions. Cloud garment paths resolve in one fresh metadata query; local paths retain symlink checks. Accepted outfit reads omit generation history, and a single-job read loads only that job. Hosted settings, mutations, worker steps and recovery read only open outfit jobs (planning, generating, or holding an unresolved look) through `outfit-jobs/.open-jobs.json`; only the history list reads every job.
- **Image processing:** modelled import generation reads the cutout and identity reference without the unused source upload. Shopping resolves the submitted inventory, validates the selected reference, and prepares one contact-sheet tile per usable cutout.
- **Contact-sheet tiles:** outfit planning and Shopping prepare up to six tiles concurrently, in a fixed order. Hosted tiles (236 × 252 PNG) are stored in `wardrobe_contact_tiles`, keyed by recipe and the original's immutable Blob URL, together with the SHA-256 of those original bytes. Later runs resolve all paths and cached tiles in a few database queries and download only uncached or replaced originals; a corrupt original is skipped and never cached. Planning still re-reads and hash-checks the selected garments before committing, and Shopping checks still compare current identities. The daily cleanup prunes tiles whose original is no longer referenced. Local servers keep a bounded in-memory tile cache keyed by content hash; they still read each original to hash it but skip re-decoding. Published display variants serve the just-encoded bytes; if another request won publication, its stored copy is used. These optimisations preserve originals, contact-sheet recipes, and provider inputs.
- **Outfit generation:** planning validates originals while preparing contact sheets, then rechecks selected garments and current combination reservations before committing. Rendering, retries, and approval validate only selected images. Hosted approval publishes a validated candidate with a fenced, exclusive metadata link, retaining its immutable original and existing WebP copies. Removing a candidate reference cannot delete a Blob still referenced by an accepted outfit. Local approval publishes independent image bytes.
- **Browser reads:** the Outfits view treats successful collection, settings, and history results as fresh for 30 seconds during in-app navigation; each loads independently. Returning to the tab/window refreshes them, and edits/generation invalidate affected resources. Hidden views cancel reads and pause polling. Import polling requests only jobs that can advance on the server, in one batched read per tick (`GET /api/import/jobs?ids=…`, at most 32 IDs), without overlapping polls. It polls every 1.5 s after progress and backs off to 3 s while nothing changes. Batched progress reads do not trigger outbox recovery; opening the importer (the full jobs list) does. Small outfit thumbnails use smaller derivatives than detail views. This is browser-view state, not a shared server cache.

### Accessory-suggestion cache upgrade

New entries retain both an opaque immutable image identity and a portable content hash. Hosted hits verify identity plus styling/model/recipe context without reading the photo. Legacy entries and restored images with new Blob identities fall back to content hashing. Empty caches never download the photo, and read-only checks never rewrite metadata.

To add identity metadata to existing suggestions:

```sh
# Report candidates and estimatedOriginalBytes without image downloads or writes.
node --env-file=.env.cloud scripts/upgrade-accessory-cache.mjs --target cloud

# Apply only after reviewing the estimated transfer against the available budget.
node --env-file=.env.cloud scripts/upgrade-accessory-cache.mjs --target cloud --apply
```

Apply takes the writer lease, verifies original hashes, and updates only matching entries. It preserves suggestions and other fields, makes no model calls, and is idempotent. A restored store may need another upgrade because uploads receive new identities.

Blob cache misses consume Simple Operations and Fast Origin Transfer; downloads consume Blob Data Transfer even on cache hits. Avoiding downloads therefore saves more than CDN caching alone. See [Blob usage](https://vercel.com/docs/vercel-blob/usage-and-pricing) and [private Blob caching](https://vercel.com/docs/vercel-blob/using-blob-sdk#get). Recorded usage does not decrease after a release. Migration, display warmup, generation inputs, skill snapshots, and first full backups all contribute; later backups reuse unchanged encrypted image objects locally.

## Automatic storage cleanup

The cron in `vercel.json` calls `/api/maintenance/storage` daily at `0 20 * * *` (20:00 UTC; 03:00 Bangkok the following day). Hobby invokes it within that hour. Configure a separate random **Production-only** `CRON_SECRET`; Vercel sends it as `Authorization: Bearer …`. Keep deployment protection enabled. See [cron authentication](https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs) and [Hobby schedule precision](https://vercel.com/docs/cron-jobs/usage-and-pricing).

For an existing store, run the [schema upgrade](#schema-upgrades) before deploying this feature; it creates the collection tables and publication guards. `collect-cloud-garbage.mjs --initialize` applies only that part and remains equivalent for it.

```sh
# Inspect only, apart from acquiring/releasing the normal writer lease.
node --env-file=.env.cloud scripts/collect-cloud-garbage.mjs

# Run the same bounded collection as the scheduled job.
node --env-file=.env.cloud scripts/collect-cloud-garbage.mjs --apply
```

Only the application's immutable uploads in `wardrobe/` are eligible. Every database file reference protects its Blob, including saved items, references, jobs, and copied/linked images. Display copies remain protected while their source has any file reference.

An object must stay unreferenced for **seven days after first observation**, not merely seven days after upload. Restoring a reference resets the grace period. Before deletion, the collector rechecks references under the global writer lease and records a durable deletion marker. Publication guards prevent delayed writers from restoring a retired URL, even after lease loss.

The collector saves its listing cursor, deletes at most 100 objects per run, and observes a bounded time budget. Failed deletions retry later; a busy writer causes the scheduled run to skip. Counts are logged and saved in `.blob-gc-state.json` in the cloud store.

Cleanup permanently deletes eligible Blobs. It neither backs up data nor removes referenced originals, retained historical-job files, or hidden items still in storage. Historical-job retention and removal of deletion records are separate concerns. Never manually delete an object still referenced by the database.

### Schema upgrades

Fresh migrations create the full schema. An existing store picks up every later additive change with this one command: the display-variant and contact-tile caches, the cleanup tables and publication guards, the byte-ordered path index used by directory listings, moves and recursive deletes, and the Blob reference indexes used by cleanup and publication guards. It reapplies the idempotent schema:

```sh
# Report only.
node --env-file=.env.cloud scripts/upgrade-cloud-schema.mjs

# Create missing tables/indexes and replace functions/triggers in one transaction.
node --env-file=.env.cloud scripts/upgrade-cloud-schema.mjs --apply
```

It copies, rewrites and deletes no wardrobe files, takes no writer lease and is safe to rerun. It is not the one-time `migrate-to-cloud.mjs` import. Queries remain correct before and after it runs, so it can be applied before or after a deployment; until it runs, those lookups scan the table and contact tiles are not persisted. Run it before relying on automatic cleanup, which needs the collection tables.
