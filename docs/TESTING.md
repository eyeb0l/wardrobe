# Testing on squiggle

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

On squiggle, Chromium revision 1248 is already installed in
`/tmp/wardrobe-audit-browsers`. Reuse it without downloading another browser:

```bash
export PLAYWRIGHT_BROWSERS_PATH=/tmp/wardrobe-audit-browsers
```

If Node 22 is not your shell default, this existing squiggle installation can
be selected before running npm:

```bash
export PATH=/tmp/shopping-node22/node-v22.23.3-linux-x64/bin:$PATH
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
