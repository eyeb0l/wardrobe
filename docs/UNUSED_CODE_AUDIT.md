# Unused code audit — 5 November 2026

Baseline: `b5b555f` (full SHA in the accompanying validation artifacts).
Local branch: `cleanup/proven-unused-code-2026-11-05`. No push or merge.

## Method and entry points

Evidence below was collected **before deletion**. Line numbers refer to the
baseline. Searches covered the repository, including hidden `.agents/` and
`.github/` files, excluding dependencies, generated output and the lockfile.
Installed Babel parser/scope analysis supplemented searches; a module graph
followed static imports, re-exports, literal dynamic imports, CSS imports and
`new Worker(new URL(...))`. A zero search count alone was not sufficient.

Entry points checked:

- `index.html` → `src/main.jsx` → `App`, its eager imports and lazy Outfit/Shopping views.
- `vite.config.mjs` → local import, discovery, outfit, Shopping and image APIs.
- `nitro.config.mjs` → `server/handler.mjs` → plugins, storage and workflow/task hooks.
- `package.json` scripts; standalone Node CLIs; operational commands in README,
  contributor/hosting/testing/evaluation documentation and `.agents/skills/`.
- Node's `scripts/*.test.mjs` glob and Playwright's `tests/browser` discovery.
- `public/` assets, the manifest, production service-worker registration and worker URLs.

All `src/` files are reachable from the client entry point. Shared modules outside
that client graph (`modeled-upload`, `outfit-combinations`) are used by the APIs.
No whole file or directory was proven unused.

## Batch 1: evidence recorded before removal

Search recipe (run from the repository root):

```sh
rg -n --hidden -g '!node_modules' -g '!.git' -g '!dist' -g '!.nitro' \
  -g '!.vercel' -g '!.output' -g '!package-lock.json' \
  -g '!docs/UNUSED_CODE_AUDIT.md' 'PATTERN' .
```

| Item and baseline location | Repo-wide search result | Entry-point reachability and test usage |
| --- | --- | --- |
| `formatImageBytes`, `src/image-upload.mjs:10–12` | `\bformatImageBytes\b`: definition at line 10 and re-export at `src/shopping-image.mjs:3`, nothing else | Module reachable via import/upload and Shopping UI; function never called. No test reference. Private application, no package library exports or string lookup of this name. |
| Three re-exports, `src/shopping-image.mjs:3` | Above formatter results; `\bMAX_SHOPPING_INPUT_BYTES\b` and `\bMAX_SHOPPING_IMAGE_BYTES\b` each occur only on this line | Shopping imports only `prepareShoppingImage`. No test consumers. Underlying upload size constants remain used and stay. |
| Private `extension`, `scripts/import-job-api.mjs:87–89` | `\bextension\b`: this definition plus unrelated prose in three documentation files, `shared/product-background.mjs:1` and a test title in `vision-eval-api-runner.test.mjs:164` | Module reached by Vite and hosted plugins; Babel binding has zero references, is not exported or registered. No test calls it. |
| Local `frameTransparentGarment` import, `scripts/import-job-api.mjs:1` | Name also occurs in the implementation, separate re-export at line 2 and `scripts/chroma-cleanup.test.mjs:4,16,139`; local import binding has zero references | Module reachable. Tests use the **separate re-export**, which stays; only the unused local import name is removed. The same source module is still loaded. |
| Local `writeFile` import, `scripts/vision-eval-api-runner.mjs:15` | File-local `\bwriteFile\b`: line 15 import and line 62 `fd.writeFile(...)`. Scope analysis distinguishes the method from the unused import | CLI and tests reach this module. The FileHandle method remains. No consumer can access the local import, and the other fs imports keep module loading intact. |

The import bindings were additionally checked with per-file Babel scopes; neither
has a reference. No `eval`, global registration or computed name dispatch reaches
either deleted helper. The dynamic upload-module loader in
`scripts/prepare-vision-api-suite.mjs` calls only `prepareUploadImage`.

The following CSS searches returned **only the listed stylesheet definitions**,
with zero component, DOM mutation, CLI or test references. Both stylesheets are
reachable, but these rules cannot match the DOM emitted by the application.
Dynamic class construction and `classList` calls were inspected separately.

| Exact class-name search | All matches in baseline | Reason unreachable |
| --- | --- | --- |
| `viewer-swatch` | `src/styles.css:316` | Viewer emits no such class. |
| `details-label` | `src/styles.css:411,871` | No component emits this class. |
| `detail-tags` | `src/styles.css:419,427,872` | No component emits this class. |
| `viewer-text-close` | `src/styles.css:448,460,461,873` | Viewer uses `viewer-icon-close` and shared button classes. |
| `\bedit-button\b` | `src/styles.css:467,486,492,493` | No component emits this class. Only dead selectors are removed from groups; declarations for live buttons stay. |
| `color-controls` | `src/styles.css:713,721,875` | Current colour control uses `selected-color-control`, `selected-color-copy`, `palette` and `sample-button`. |
| `native-color` | `src/styles.css:728,737` | No component emits this class. |
| `import-cleanup-comparison` | `src/import-flow.css:273–276` | Current cleanup preview uses its viewport and `ImageCompare`. |

The same patterns searched specifically in `scripts/*.test.mjs` and
`tests/browser/` returned no matches. Browser regression tests still exercise the
live viewer, editor, uploads and image comparison after removal.

## Kept: uncertainty and real uses

- `scripts/merge-vision-blind-grades.mjs`, `prepare-vision-blind-review.mjs` and
  `render-vision-eval-report.mjs`: no external filename references or tests found,
  but each has an explicit `process.argv`/direct-execution CLI. External/manual
  usage cannot be ruled out, so the files and their exported functions stay.
- `prepare-vision-api-suite.mjs` and `vision-eval-api-runner.mjs`: explicit CLI
  entry points as well as test consumers. Imports alone do not describe usage.
- Exported helpers used only internally, and helpers used by tests: no export
  stripping. Existing interfaces may have external/manual consumers.
- Lazy Outfit/Shopping views, `background-removal.worker.mjs`, `public/sw.js`,
  Nitro configuration and tests: dynamic, URL-based, production-only or framework
  discovery entry points, not orphan files.
- Status/background `is-*` CSS modifiers: some appear stale, but classes are
  constructed dynamically. Retained rather than generalising literal searches.
  Additional drop-overlay modifier selectors are outside this conservative batch.
- Environment-controlled hosted/preview/Decisions/rubric/Shopping flags: runtime
  configuration and documented gates, not hard-coded-off features.
- Destructuring exclusions (`internal`, `file`, `blob`, `sortOrder`), positional
  callback parameters, named returned functions and `??=` cache variables:
  unused-binding diagnostics do not establish removable behaviour.
- Browser compatibility fallbacks, storage migrations, defensive error paths and
  the bounded crop-compression `while (true)` loop: real conditional behaviour.

An AST/control-flow scan of 142 non-test JavaScript files and comment review found
no proven unreachable statement blocks, literal hard-disabled feature blocks or
abandoned commented-out implementations. This is a conservative static audit,
not a claim that all possible dead code has been eliminated.

## Validation

One deletion batch changes six source files: **104 lines removed, two replacement
import lines added (102 net lines removed), zero whole files/directories deleted**.
This audit document is additional documentation, excluded from those source counts.

Commands use the repository's pinned Node 22 and existing Playwright installation:

```sh
export PATH=/home/iris/.local/opt/dev-tools/node22/node-v22.23.3-linux-x64/bin:$PATH
npm ci  # dependencies were absent in this worktree
TMPDIR=/dev/shm npm test
npm run build:vercel
WARDROBE_BROWSER_PORT=5541 \
  WARDROBE_BROWSER_ARTIFACTS=/tmp/wardrobe-unused-61e10e03/browser-desktop \
  npm run test:browser -- --project=desktop --forbid-only --global-timeout=600000
WARDROBE_BROWSER_PORT=5543 \
  WARDROBE_BROWSER_ARTIFACTS=/tmp/wardrobe-unused-61e10e03/browser-mobile \
  npm run test:browser -- --project=mobile --forbid-only --global-timeout=600000
git diff --check
```

`build:vercel` runs the Vite production build, Nitro hosted build, native workflow
packaging verification and direct `/shopping`/`/outfits` SPA verification. Playwright
starts, waits for and stops its own isolated Vite server; all fixtures are synthetic.
The established install/start/artifact recipe is in [TESTING.md](TESTING.md#headless-browser-tests).

| Check | Before deletion | After batch 1 |
| --- | --- | --- |
| Full Node test suite | 807 passed, zero failures/skips (91.1 s) | 807 passed, zero failures/skips (94.8 s) |
| Vite + hosted build and packaging/SPA verification | Passed | Passed |
| Surviving CSS AST equivalence | Baseline | Passed: all surviving selectors, declarations, order and media contexts unchanged |
| Independent read-only diff review | — | No errors found |
| Full headless Chromium suite | Not run | 156 passed: desktop 78/78 (5.1 min), mobile 78/78 (5.0 min); both commands exited 0 |
| Whitespace check | Clean | Clean |

The initial combined browser run was intentionally interrupted after 53 passes
(one in-progress case interrupted, 102 not run) because its measured pace exceeded
the ten-minute global budget. It reported no assertion failure. Both complete
viewport suites were restarted on separate ports with one worker each and passed;
the partial run is not completion evidence.

All 156 browser health logs were inspected: no unexpected page/console errors,
failed requests or HTTP errors. The failure-recovery tests deliberately recorded
one 422 each for Shopping URL import and try-on, and one stale-photo 409 per
viewport (six HTTP responses and four matching console messages in total).
Desktop and mobile screenshots of the live wardrobe editor/colour controls and
import comparison were opened and inspected. The servers started by these runs
stopped at completion; their ports are no longer listening.

Logs, immutable-baseline search results, scan script, patch and browser artifacts
are under `/tmp/wardrobe-unused-61e10e03/`. A failed deletion batch must be restored;
none of the completed checks has failed.
