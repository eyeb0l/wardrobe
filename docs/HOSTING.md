# Private hosting on Vercel

This project can run on Vercel Hobby for personal use. Vercel handles sign-in; Neon stores wardrobe records and job state, and a **private** Vercel Blob store holds images. OpenAI usage is billed separately. Check each service's current allowance before assuming the whole setup will remain free.

Current production site: [Wardrobe](https://wardrobe-snowy-rho.vercel.app).

## Set up the project

1. Create a Vercel project from this repository, using your personal Hobby account. Keep project access limited to yourself. The checked-in configuration uses Node 22, `npm run build:vercel`, and `.vercel/output`. Select **Other** if Vercel asks for a framework; a plain Vite deployment would omit the API and durable jobs.
2. Under **Settings → Deployment Protection**, enable **Vercel Authentication → All Deployments**. This protects production domains, generated deployment URLs, and previews. Standard Protection leaves production domains accessible. All Deployments is available on all plans. Keep shareable bypass links and protection exceptions disabled. [Vercel's protection documentation](https://vercel.com/docs/deployment-protection#all-deployments)
3. Connect a Neon database through the Vercel Marketplace and create a Vercel Blob store with **Private** access. Connect both to **Production only**. The server needs `DATABASE_URL` and `BLOB_READ_WRITE_TOKEN`; check the environment scopes when integrations populate them.
4. Add `OPENAI_API_KEY` to **Production only**. Preserve any model overrides you use locally. Leave `WARDROBE_HOSTED_ENABLED` unset until storage has been imported and deployment protection has been checked.

The application deliberately disables its hosted API outside the production environment. Authentication is enforced by Vercel before requests reach the app; there is no separate in-app login. Protect the Vercel account with a passkey or two-factor authentication.

## Copy the existing wardrobe

Stop the local Wardrobe server and finish or cancel active generation. Back up the whole local data directory and any separately configured reference photos before migrating.

Put the production database connection and Blob read-write token into an ignored `.env.cloud` file in the repository root. The migration does not need the OpenAI key. Never commit this file. Both Git and source deployments exclude `.env*` secrets; only `.env.example` is tracked as a template.

Run from the repository root with Node 22 or newer:

```sh
# Inspect the local snapshot; this performs no cloud writes.
node --env-file=.env.cloud scripts/migrate-to-cloud.mjs data

# Initialize cloud storage, copy files, and verify their bytes.
node --env-file=.env.cloud scripts/migrate-to-cloud.mjs data --apply
```

Replace `data` with your configured local data directory if needed. The copy includes the library, outfits, accessory cache, saved prompts, imported images, jobs, outfit images, and `model-reference*.png` files inside that directory. A reference configured outside it is not copied automatically; the hosted app expects its default reference at `model-reference.png` in the imported directory. Transient locks and other dotfiles are excluded.

The script leaves local originals unchanged, skips cloud files with identical contents, and stops if an existing cloud file differs. It never overwrites a differing file. A stopped import may have copied earlier files; rerunning skips verified matches. Active generation, symbolic links, and a missing library are rejected. This is an initial copy, not an ongoing synchronization command.

After the import succeeds, set `WARDROBE_HOSTED_ENABLED=1` in **Production only** and create a new production source deployment. Vercel supplies `VERCEL_ENV`; do not set it yourself. Hosted data paths are configured by the server, so local `WARDROBE_DATA_DIR` and `WARDROBE_MODEL_REFERENCE` values do not need to be copied into Vercel.

## Check access and use

Open the production domain and its generated deployment URL in a signed-out/private browser. Both the page and a direct API URL such as `/api/import/jobs` must require Vercel sign-in. Then sign in with your own account and check the wardrobe, model references, and existing photographs before starting generation.

The app permits one cloud writer at a time. A concurrent edit or generation can report that another operation is running; wait for it to finish before retrying. Reading existing wardrobe data remains available. Job state survives deployments, and polling the jobs list can recover work saved before dispatch.

If generation was interrupted after a paid request started, the app marks it for review instead of automatically repeating the uncertain request. Check provider usage before choosing **Retry**: retrying creates a new paid request.

`WARDROBE_DAILY_API_LIMIT` defaults to **40** dispatch reservations per UTC calendar day. Set a positive integer in Production to change it, then redeploy. Reservations are counted conservatively, so failed or uncertain attempts can consume the allowance. This limits request count, **not currency spend**; calls vary in price, and a batch can use several calls. Use provider-side controls alongside it.

## Updates and retained data

### Display images

The app retains original PNGs for generation, downloads, and precise colour sampling. Galleries, outfit photos, references, and import previews request responsive WebP copies at 320, 640, or 1280 pixels wide. Quality is set to 85 with lossless alpha, preserving transparent edges. Browser requests use private caching with ETag revalidation; replacing an original changes its cache identity.

Copies are stored in the private Blob store, indexed by the separate `wardrobe_image_variants` table. New images create and retain the requested size on first display. They use the same authenticated API routes as originals. No paid image API is called for compression.

Before upgrading an existing cloud installation, initialize the additive cache table and prepare existing images:

```sh
# Read-only inventory; omit --apply to inspect first.
node --env-file=.env.cloud scripts/warm-display-images.mjs
node --env-file=.env.cloud scripts/warm-display-images.mjs --apply
```

The command is resumable and leaves originals unchanged. Fresh cloud migrations create the table automatically. Old display copies remain stored after an original is replaced or removed, alongside retained original objects; neither has automatic garbage collection.

### Releasing code

For a connected repository, push reviewed code to the configured production branch. Alternatively, use a Vercel CLI source deployment from the project checkout. Vercel runs `npm run build:vercel`, which builds the frontend and hosted API/workflows together. Run `npm test` and `npm run build:vercel` before releasing changes.

Deploying new source preserves the existing Neon and Blob data. Keep the same storage connections and production environment variables. Local `npm run dev` continues to use the local filesystem independently; hosted edits and newly generated photos do not appear in local `data/` automatically.

Gallery edits to names, categories, colours and tags, plus hiding items added outside the web importer, are stored only in the current browser and do not sync between devices.

Retain the original local backup. There is currently no cloud export/restore command or automatic cloud-to-local backup in this repository. Configure and verify any provider backup arrangements separately, keeping database records and image objects together. Rolling back a deployment rolls back code, not wardrobe data.

Deleted or replaced image references leave their immutable Blob objects in storage intentionally, so existing links and readers remain safe. There is no automated garbage collection yet; those objects continue to count toward storage usage. Do not manually delete Blob objects still referenced by the database.
