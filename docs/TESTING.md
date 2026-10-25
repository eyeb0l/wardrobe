# Testing on squiggle

## Wardrobe toolbar and collapsed rediscovery

Use the pinned Node 22 and headless Chromium setup below:

```bash
export PATH=$HOME/.local/opt/dev-tools/node22/node-v22.23.3-linux-x64/bin:$PATH
WARDROBE_BROWSER_PORT=5337 \
  WARDROBE_BROWSER_ARTIFACTS=/tmp/wardrobe-toolbar-browser \
  npm run test:browser -- tests/browser/wardrobe-rediscovery.spec.mjs tests/browser/wardrobe-reorder.spec.mjs tests/browser/garment-wear.spec.mjs
rg --files /tmp/wardrobe-toolbar-browser
```

Choose an unused port and fresh artifact directory. Playwright starts Vite,
waits for readiness and stops its own server. Desktop and mobile tests verify
that Rearrange sits beside Log wear, rediscovery starts collapsed (including
after reload), keyboard and pointer toggles work, and existing rediscovery,
rearranging and wear logging flows still work. Inspect `wardrobe-collapsed.png`,
`rediscovery-first-viewport.png` and `browser-health.json`. All data is synthetic;
no private wardrobe data or paid AI calls are used.

## Save what you wore

Use the pinned Node 22 and headless Chromium setup below. Choose an unused port
and fresh artifact directory:

```bash
export PATH=$HOME/.local/opt/dev-tools/node22/node-v22.23.3-linux-x64/bin:$PATH
TMPDIR=/dev/shm node --test scripts/worn-look.test.mjs scripts/garment-wear.test.mjs scripts/outfit-variations.test.mjs scripts/cloud-store.test.mjs
WARDROBE_BROWSER_PORT=5331 \
  WARDROBE_BROWSER_ARTIFACTS=/tmp/wardrobe-worn-look-browser \
  npm run test:browser -- tests/browser/worn-look.spec.mjs
rg --files /tmp/wardrobe-worn-look-browser
```

Playwright starts Vite, waits for readiness and stops its own server. Desktop
(1365 × 1000) and mobile (390 × 844) cover logging → preview → save → favourite
→ plan tomorrow and reload, exact existing matches, choosing a dress/subset,
independent wear Undo/laundry, shortlist availability, old entries opened through
garment history, stale revisions, missing cutouts, removed sources, read/write
failures, lost save responses and focus reads racing a save. Inspect
`worn-look-preview.png`, `worn-look-controls.png`, and `browser-health.json` for
each viewport. Page identity, overlays, horizontal overflow, console errors and
failed requests are checked; explicit 409/503 responses exercise recovery.

Browser API persistence and cutouts are synthetic. Node tests exercise the real
API, image composition, validation, concurrent/deduplicated saves, immutable
wear history, restart/retry recovery, origin checks and metadata preservation.
The cloud-store test uses fresh serverless instances, independent PGlite clients,
writer leases and real PNG cutouts. No private wardrobe data or paid AI services
are used. Run all standard checks below before submission.

## Quick garment wear logging

Reuse Node 22 and the pinned headless Chromium installation below, choosing an
unused port and fresh artifact directory:

```bash
export PATH=$HOME/.local/opt/dev-tools/node22/node-v22.23.3-linux-x64/bin:$PATH
TMPDIR=/dev/shm node --test scripts/garment-wear.test.mjs scripts/outfit-activity.test.mjs scripts/outfit-shortlist.test.mjs scripts/wardrobe-rediscovery.test.mjs scripts/cloud-store.test.mjs
WARDROBE_BROWSER_PORT=5321 \
  WARDROBE_BROWSER_ARTIFACTS=/tmp/wardrobe-garment-wear-browser \
  npm run test:browser -- tests/browser/garment-wear.spec.mjs
rg --files /tmp/wardrobe-garment-wear-browser
```

Playwright starts Vite, waits for readiness and stops its server. Desktop
(1365 × 1000) and mobile (390 × 844) exercise individual/bulk logging, category
selection, backdating and future-date prevention, reload/correction, per-day
counts shared with outfit history, independent Undo and optional selected-piece
laundry, unchanged plan confirmation, read/write failures, safe retry and lost
response recovery, incoming changes, local-day rollover and stale reads during
mutation. Inspect `garment-wear-individual.png`, `garment-wear-history.png`,
`garment-wear-bulk.png`, `garment-wear-wardrobe.png` and each `browser-health.json`.
Unexpected console/network errors, overlays and horizontal overflow fail tests;
explicit 409/503 responses exercise recovery.

Browser images, records and API persistence are synthetic. Node tests exercise
real API/storage validation, atomic batches, origin checks, concurrent writes,
idempotent retries, Undo retry protection, immutable garment snapshots, timezone
boundaries, restart persistence, and aggregation into shortlist/rediscovery.
The cloud-store test uses fresh serverless API instances and independent PGlite
store clients under writer leases. No private wardrobe data or paid AI calls
are used. Run the full standard checks below before submission.

Reviewed synthetic screenshots: [desktop bulk logging](screenshots/garment-wear/bulk-desktop.png),
[mobile bulk logging](screenshots/garment-wear/bulk-mobile.png),
[desktop backdating and entries](screenshots/garment-wear/individual-desktop.png), and
[mobile backdating and entries](screenshots/garment-wear/individual-mobile.png).

## Wardrobe rediscovery

Reuse the pinned Node 22 and headless Chromium setup below. Choose unused ports
and a fresh artifact directory:

```bash
export PATH=$HOME/.local/opt/dev-tools/node22/node-v22.23.3-linux-x64/bin:$PATH
node --test scripts/wardrobe-rediscovery.test.mjs scripts/outfit-shortlist.test.mjs
WARDROBE_BROWSER_PORT=5311 \
  WARDROBE_BROWSER_ARTIFACTS=/tmp/wardrobe-rediscovery-browser \
  npm run test:browser -- tests/browser/wardrobe-rediscovery.spec.mjs
rg --files /tmp/wardrobe-rediscovery-browser
```

Playwright starts and stops Vite on the selected port. Desktop (1365 × 1000)
and mobile (390 × 844) cover Ready/category filtering, per-day history across
looks and variations, unknown history, matching looks and occasion filters,
direct planning and reload, wear/Undo changes across views, laundry updates,
read failures/recovery, dirty-edit guards, and corrupt-image exclusion/retry.
Inspect `rediscovery-pieces.png`, `rediscovery-first-viewport.png`,
`rediscovery-ready-looks.png` and each `browser-health.json`. Page identity,
rendered interactions, overlays, horizontal overflow, console errors and failed
requests are checked. Expected 409/503 responses exercise recovery.

Browser records, images and API persistence are synthetic. Node tests exercise
the actual shared ranking, wear-date aggregation and eligibility helpers. The
feature reuses the existing saved-look, wear and planning APIs; it adds no model
requests or storage format. No live wardrobe data or paid services are used.

Reviewed synthetic screenshots: [desktop pieces](screenshots/wardrobe-rediscovery/pieces-desktop.png),
[mobile pieces](screenshots/wardrobe-rediscovery/pieces-mobile.png),
[desktop history and ready looks](screenshots/wardrobe-rediscovery/ready-looks-desktop.png),
and [mobile history and ready looks](screenshots/wardrobe-rediscovery/ready-looks-mobile.png).

## Plan today or tomorrow

Use Node 22 and the repository's pinned headless Chromium installation. Pick
unused ports and fresh artifact directories:

```bash
export PATH=$HOME/.local/opt/dev-tools/node22/node-v22.23.3-linux-x64/bin:$PATH
TMPDIR=/dev/shm node --test scripts/outfit-plans.test.mjs scripts/outfit-activity.test.mjs scripts/cloud-store.test.mjs
WARDROBE_BROWSER_PORT=5301 \
  WARDROBE_BROWSER_ARTIFACTS=/tmp/wardrobe-plans-browser \
  npm run test:browser -- tests/browser/outfit-plans.spec.mjs
rg --files /tmp/wardrobe-plans-browser
```

Playwright starts Vite, waits for readiness, and stops the server afterwards.
Desktop (1365 × 1000) and mobile (390 × 844) cover saved-look selection, reload,
replacement/moves, wear confirmation and Undo, separate variation saves, incoming
laundry/missing pieces, failed writes/reads, device conflicts, and local-day
rollover into unconfirmed past plans. Inspect `daily-plans.png`,
`plans-first-viewport.png`, `plan-laundry.png`, `plan-variation.png` and every
`browser-health.json`. Unexpected console/network errors, overlays and horizontal
overflow fail the suite. Explicit 409/503 responses cover recovery.

Browser data and images are synthetic. Node tests exercise real API writes,
manifest validation, concurrent revisions, origin checks, restart persistence,
date boundaries and separate wear history. The cloud-store test runs the planning
API through independent hosted instances under leases against isolated PGlite.
No private wardrobe data or paid model services are used.

Reviewed synthetic screenshots: [desktop plans](screenshots/plan-tomorrow/daily-plans-desktop.png),
[mobile plans](screenshots/plan-tomorrow/daily-plans-mobile.png),
[desktop variation selection](screenshots/plan-tomorrow/plan-variation-desktop.png),
and [mobile variation selection](screenshots/plan-tomorrow/plan-variation-mobile.png).

## Garment availability

The availability tests use the existing Node 22 and pinned headless Chromium
setup. Choose unused ports and fresh artifact directories:

```bash
export PATH=$HOME/.local/opt/dev-tools/node22/node-v22.23.3-linux-x64/bin:$PATH
TMPDIR=/dev/shm node --test scripts/wardrobe-sync.test.mjs scripts/outfit-shortlist.test.mjs scripts/cloud-store.test.mjs
WARDROBE_BROWSER_PORT=5291 \
  WARDROBE_BROWSER_ARTIFACTS=/tmp/wardrobe-availability-browser \
  npm run test:browser -- tests/browser/garment-availability.spec.mjs
rg --files /tmp/wardrobe-availability-browser
```

Playwright starts and stops its own Vite server. Desktop (1365 × 1000) and mobile
(390 × 844) exercise garment editing, discard, reload, category-scoped selection,
bulk Mark ready, shortlist exclusion/reappearance, optional selected-piece laundry
after wear, independent wear undo, incoming device updates, and failed saves/read
recovery. Inspect `garment-availability.png`, `laundry-bulk.png`,
`wear-laundry.png`, `laundry-shortlist.png`, and each `browser-health.json`.
The fixture intentionally returns 409/503 errors on the wardrobe endpoints;
other console/network errors, Vite overlays and horizontal overflow fail tests.

Browser API responses and images are synthetic. Node tests exercise the actual
API, atomic local library writes, validation, revision conflicts, hidden items,
metadata preservation and restart persistence. A PGlite-backed cloud-store test
verifies availability across independent store clients and writer leases.
No live wardrobe data or paid AI services are used.

Reviewed synthetic screenshots for this feature:
[desktop laundry selection](screenshots/garment-availability/laundry-bulk-desktop.png),
[mobile laundry selection](screenshots/garment-availability/laundry-bulk-mobile.png),
[desktop optional laundry after wear](screenshots/garment-availability/wear-laundry-desktop.png),
[mobile optional laundry after wear](screenshots/garment-availability/wear-laundry-mobile.png),
[desktop shortlist exclusions](screenshots/garment-availability/shortlist-desktop.png), and
[mobile shortlist exclusions](screenshots/garment-availability/shortlist-mobile.png).

## Wear-aware outfit shortlist

Use the pinned Node 22 and Chromium setup below. The pure ranking tests cover
history across outfits and variations, per-day garment deduplication, selected
piece subsets, missing/future history, favourites, occasions, availability,
distinct main combinations and stable ordering.

```bash
export PATH=$HOME/.local/opt/dev-tools/node22/node-v22.23.3-linux-x64/bin:$PATH
node --test scripts/outfit-shortlist.test.mjs
WARDROBE_BROWSER_PORT=5281 \
  WARDROBE_BROWSER_ARTIFACTS=/tmp/wardrobe-shortlist-browser \
  npm run test:browser -- tests/browser/outfit-shortlist.spec.mjs
rg --files /tmp/wardrobe-shortlist-browser
```

Use an unused port and unique artifact directory. Playwright starts and stops
Vite with isolated fixture data. Desktop (1365 × 1000) and mobile (390 × 844)
Chromium exercise occasion/mode selection, dated explanations, shared garment
history, cutout looks, empty favourites, logging, undo, favourite changes,
variation navigation, reloads, failed collection/wardrobe read recovery, malformed
legacy browser edits, and missing/corrupt images with retry. The fixture uses a fixed
local day and an explicit `en-GB` locale for date assertions. Inspect
`shortlist-recent.png`, `shortlist-favourites.png`, `shortlist-empty.png` and each
`browser-health.json`. Unexpected console/network errors, framework overlays and
horizontal overflow fail the tests; intentional 503 responses and one specific
404 image response check recovery. The
shortlist makes no AI calls; images and API persistence are synthetic fixtures.

Reviewed synthetic screenshots for this feature:
[desktop shortlist](screenshots/outfit-shortlist/recent-desktop.png),
[mobile shortlist](screenshots/outfit-shortlist/recent-mobile.png),
[desktop favourites and piece history](screenshots/outfit-shortlist/favourites-desktop.png), and
[mobile favourites and piece history](screenshots/outfit-shortlist/favourites-mobile.png).
Image failure recovery: [desktop](screenshots/outfit-shortlist/image-recovery-desktop.png)
and [mobile](screenshots/outfit-shortlist/image-recovery-mobile.png).

For the full browser suite on a runner that terminates long shell commands,
run `npm run test:browser -- --project=desktop` and then
`npm run test:browser -- --project=mobile`, each with a fresh port/artifact path.

## Saved outfit variations

Use the existing Node 22 and pinned Chromium setup below. These focused tests
cover separate cutout saves, exact replacement selection, duplicate prevention,
concurrent writes, stale/unavailable pieces, optional-photo rejection and retry,
approval recovery, and fresh hosted instances:

```bash
export PATH=$HOME/.local/opt/dev-tools/node22/node-v22.23.3-linux-x64/bin:$PATH
TMPDIR=/dev/shm node --test scripts/outfit-variations.test.mjs scripts/outfit-serverless.test.mjs scripts/outfit-discovery.test.mjs
WARDROBE_BROWSER_PORT=5273 \
  WARDROBE_BROWSER_ARTIFACTS=/tmp/wardrobe-variations-browser \
  npm run test:browser -- tests/browser/outfit-variations.spec.mjs
rg --files /tmp/wardrobe-variations-browser
```

Choose an unused port and unique artifact directory. Playwright starts an isolated
Vite server, waits for readiness and stops it after the run. Both desktop and
mobile tests exercise replacement selection, empty categories, live cutout
previews, cancellation, failed saves, reloads and optional photo review. Saving
works without an API key; optional photo generation works when automatic outfit
combinations are exhausted. Inspect `variation-preview.png`,
`variation-controls.png`, `variation-saved.png`, `variation-photo-review.png` and
`browser-health.json` in each viewport's output. The tests reject unexpected
console/network failures and horizontal overflow. Expected HTTP 503 responses
exercise save recovery. Fixtures and provider responses are synthetic: they
verify the workflow, not real AI photo fidelity. No live model calls are made.

Reviewed synthetic screenshots for this feature:
[desktop replacement preview](screenshots/outfit-variations/preview-desktop.png),
[mobile replacement controls](screenshots/outfit-variations/preview-mobile.png),
[desktop saved variation](screenshots/outfit-variations/saved-desktop.png), and
[mobile saved variation](screenshots/outfit-variations/saved-mobile.png).

Run the full standard checks below before submission.

## Favourites, outfit filters and wearing history

Follow the Node 22, dependency and Chromium setup below. The activity API tests
exercise actual filesystem persistence, restart recovery, concurrent writes,
duplicate prevention, input/origin validation and preservation of existing data.
The browser suite uses synthetic API fixtures, with no credentials or AI calls.

```bash
export PATH=$HOME/.local/opt/dev-tools/node22/node-v22.23.3-linux-x64/bin:$PATH
node --test scripts/outfit-activity.test.mjs scripts/outfit-storage.test.mjs
WARDROBE_BROWSER_PORT=5267 \
  WARDROBE_BROWSER_ARTIFACTS=/tmp/wardrobe-activity-browser-41fd \
  npm run test:browser -- tests/browser/outfit-activity.spec.mjs
rg --files /tmp/wardrobe-activity-browser-41fd
```

Choose an unused port and unique artifact directory for each task. Playwright
starts Vite with an isolated data directory, waits for readiness, and stops it
after testing. The desktop (1365 × 1000) and mobile (390 × 844) tests exercise
favourites, intersecting filters, the garment-to-outfits link, local-date logging,
undo, backdating, selecting worn pieces, reloads, removal, failed saves and stale
background reads. Inspect `outfit-collection.png`, `outfit-filtered.png`,
`outfit-wear-history.png` and `browser-health.json` in each viewport's output.
Deliberate HTTP 503 responses test recovery; other HTTP errors, console errors,
failed requests, framework overlays and horizontal overflow fail the suite.

Reviewed synthetic screenshots are committed for this feature:
[desktop collection](screenshots/outfit-activity/collection-desktop.png),
[mobile collection](screenshots/outfit-activity/collection-mobile.png),
[desktop wearing history](screenshots/outfit-activity/wear-history-desktop.png),
and [mobile wearing history](screenshots/outfit-activity/wear-history-mobile.png).

The standard full validation is still required: `TMPDIR=/dev/shm npm test`,
`npm run check`, `npm run build:vercel`, and `npm run test:browser`.

## Standard checks

Use Node.js 22.x and npm. Run the existing validation before submitting changes:

```bash
npm ci
npm test
npm run check
git diff --check
```

Hosted runtime changes also require `npm run build:vercel`. See [Contributing](../CONTRIBUTING.md).

On squiggle, `/tmp` and `/home/iris` contain Git checkouts. Backup tests reject
temporary directories inside those trees. Run the Node suite with a temporary
root outside them (the tests create and clean up their own fixture directories):

```bash
TMPDIR=/dev/shm npm test
```

In a restricted Codex sandbox this requires permission for the temporary fixtures
and local test servers. The hosted build can also require localhost execution
permission when Nitro starts its build worker.

## CI checks and artifacts

Pull requests and pushes to `main` run three GitHub Actions jobs:

- `build`: Node 22, `npm ci`, the full Node suite, and the Vite frontend build.
- `hosted`: Node 22, `npm ci`, and `npm run build:vercel`, including Nitro,
  native workflow packaging verification and SPA fallback checks. This builds
  the deployment package without deploying or requiring cloud credentials.
- `browser`: Node 22, `npm ci`, `npx playwright install --with-deps chromium`,
  and `npm run test:browser -- --forbid-only --reporter=list,html --global-timeout=600000`.
  Both desktop and mobile projects run with one worker and no retries. Playwright
  starts and stops its isolated Vite server; fixtures do not require AI credentials.

GitHub branch protection for `main` requires `build`, `browser`, and `hosted`,
requires an up-to-date pull request, and applies to administrators. No approving
review is required. These
repository settings are separate from the workflow and must be maintained if
check names change. Vercel deployment statuses are separate and are not used as
the hosted-build gate; the `hosted` job runs for every PR independently of the
deployment integration.

The browser job uploads `browser-results` for 14 days after successful or failed
runs. Download it from the workflow run's **Artifacts** section. It contains the
HTML report, synthetic desktop/mobile screenshots, browser health logs and any
failure screenshots/traces. CI writes these to `$RUNNER_TEMP/wardrobe-browser`
and `$RUNNER_TEMP/wardrobe-browser-report`. Open the extracted HTML report with
`npx playwright show-report <extracted-report-directory>` or a failure trace with
`npx playwright show-trace <trace.zip>`.

Superseded runs on the same branch are canceled. The `build` and `hosted` jobs
have 10-minute limits; the browser job has a 15-minute limit and a 10-minute global
limit so Playwright can produce its report before the job times out.

## Headless browser tests

The repository pins `@playwright/test` to 1.64.0. The suite uses Chromium,
one worker, a fresh browser context per test, synthetic images and intercepted
API fixtures. It does not require a desktop or Browser plugin, read personal
wardrobe photos, contact retailers, or call paid AI services. API integration
and retailer parsing are covered separately by `npm test`.

Install dependencies and the browser matching the pinned Playwright version:

```bash
npm ci
npx playwright install chromium
```

On squiggle, `/tmp` is a tmpfs that is cleared on reboot, so keep toolchains
out of it. Chromium revision 1248 (matching Playwright 1.64.0) is installed in
Playwright's default cache, `~/.cache/ms-playwright`, so no
`PLAYWRIGHT_BROWSERS_PATH` is needed and no download is required.

The shell default on squiggle is Node 24. Select the checksum-verified Node 22
installation before running npm:

```bash
export PATH=$HOME/.local/opt/dev-tools/node22/node-v22.23.3-linux-x64/bin:$PATH
node -v   # v22.23.3
npm ci    # rerun whenever node_modules is missing a package from package.json
```

Choose an unused local port and an artifact directory unique to your task:

```bash
export WARDROBE_BROWSER_PORT=5198
export WARDROBE_BROWSER_ARTIFACTS="$(mktemp -d /tmp/wardrobe-browser-XXXXXX)"
npm run test:browser
```

Playwright starts `npm run dev -- --host 127.0.0.1 --port 5198 --strictPort`,
waits for readiness, and stops its own server at completion. An occupied port
fails instead of reusing another task's server. The configured environment uses
an isolated data directory and model-reference path inside the artifact directory,
with an empty API key. Do not terminate other tasks' server or browser processes.

The Shopping suite runs at desktop 1365 × 1000 and mobile 390 × 844. It exercises
URL import, pending state, recoverable failure, explicit assessment, metadata
submission, cancellation and stale responses, malformed response handling,
replacement/removal, photo upload/paste/drop and navigation state. It checks the page
identity, Vite overlays, horizontal overflow, console/page errors, failed
requests and unexpected HTTP errors. The deliberate retailer HTTP 422 and
requests canceled by the user are expected.

Run just the affected file or viewport when diagnosing a failure:

```bash
npm run test:browser -- tests/browser/shopping-website.spec.mjs --project=desktop
```

The wardrobe reordering suite uses the same setup and both viewports:

```bash
WARDROBE_BROWSER_PORT=5217 WARDROBE_BROWSER_ARTIFACTS=/tmp/wardrobe-reorder-check npm run test:browser -- tests/browser/wardrobe-reorder.spec.mjs
```

It checks mouse/touch dragging, touch buttons, keyboard moves, category boundaries,
filtering, reload persistence, ordinary item viewing and failed-save recovery with
synthetic API fixtures. The Node suite separately exercises the real reorder route,
storage persistence, concurrent edits and rejected requests. Screenshots are saved
as `wardrobe-rearrange.png` and `wardrobe-saved-order.png` beneath the chosen artifact
directory, alongside `browser-health.json`. Inspect both viewport screenshots.

Each test's artifact directory includes `browser-health.json`. The import and
assessment test saves `shopping-web-import.png` and `shopping-web-assessment.png`;
failures also retain a screenshot and trace. List the evidence with:

```bash
rg --files "$WARDROBE_BROWSER_ARTIFACTS"
```

Inspect desktop and mobile screenshots with an image-viewing tool before claiming
visual verification. Retain useful logs and traces in the artifact directory.
Only commit synthetic screenshots when a task explicitly requests PR screenshots.

In a restricted Codex sandbox, starting Vite can fail with
`listen EPERM: operation not permitted 127.0.0.1:5198`. Run the same browser-test
command with the permitted localhost/browser execution approval. This is a
sandbox permission issue and does not require GUI setup.

## Outfits built around a piece

The focused suite covers Wardrobe → **Style this piece** → Generate outfits on
both desktop and mobile, including explicit submission, removal, cancellation,
repeat openings, unsaved edits, exhausted combinations and unavailable pieces.
It uses synthetic cutouts and a synthetic reference; no paid AI calls are made.
The Node integration tests separately enforce inclusion, validate availability,
count unused pairs and check persistence through retries, restarts and approval.

```bash
node --test scripts/outfit-required-piece.test.mjs
WARDROBE_BROWSER_PORT=5236 \
  WARDROBE_BROWSER_ARTIFACTS=/tmp/wardrobe-piece-browser \
  npm run test:browser -- tests/browser/outfit-required-piece.spec.mjs
rg --files /tmp/wardrobe-piece-browser
```

Use Node 22, `npm ci` and the default Chromium cache as above. Playwright starts, waits for and stops its isolated Vite server.
Choose another unused port and unique artifact directory for concurrent tasks.
The first test saves `style-this-piece.png` and `outfits-with-piece.png` under
each viewport's artifact directory. Inspect those images and `browser-health.json`.

## Gentle garment tidying

Use the same Node 22 installation, pinned Playwright and cached Chromium above:

```bash
node --test scripts/import-job-api.test.mjs scripts/import-serverless.test.mjs
WARDROBE_BROWSER_PORT=5258 \
  WARDROBE_BROWSER_ARTIFACTS=/tmp/wardrobe-tidying-browser \
  npm run test:browser -- tests/browser/garment-tidying.spec.mjs
rg --files /tmp/wardrobe-tidying-browser
```

Choose an unused port and unique artifact directory. Playwright starts and stops
its own isolated Vite server. The desktop/mobile suite uploads a synthetic shirt,
checks the default and optional preparation choices, submits tidying only on
confirmation, reloads the review and checks that another upload defaults to ordinary
extraction. Inspect `garment-tidying-option.png`, `garment-tidying-review.png` and
`browser-health.json` in each viewport's directory. Node tests cover request
validation, saved prompts, restart/regeneration and durable hosted tasks. These
mocked tests do not establish real AI image quality; follow the authorised visual
comparison recipe in [model-migration.md](model-migration.md) for that.
