# Testing on squiggle

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
