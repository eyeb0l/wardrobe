# Contributing

Use Node.js 22.x. Fork the repository or create a focused branch, then open a pull request describing the resulting behaviour and validation.

```bash
npm ci
npm test
npm run check
git diff --check
```

`npm test` runs the Node test suite. `npm run check` builds the Vite frontend; it does not run tests or build the hosted server. CI runs these in the `build` job, the desktop/mobile Chromium suite in the `browser` job, and `npm run build:vercel` in the `hosted` job. All three checks (`build`, `browser`, and `hosted`) are required before merging into `main`, including for administrators, and the branch must be up to date. This requirement is configured in GitHub branch protection; changing the workflow alone does not update it. See [CI checks and artifacts](docs/TESTING.md#ci-checks-and-artifacts).

For hosted runtime, routing, dependency or packaging changes, also run locally:

```bash
npm run build:vercel
```

For browser interactions and responsive UI checks, follow the [headless Chromium testing recipe](docs/TESTING.md). It uses the pinned Playwright version, isolated synthetic data and desktop/mobile screenshots.

This builds Vite and Nitro, packages native workflow dependencies, and verifies SPA route fallback. For documentation-only changes, check commands and links against the code. Model API contract tests do not establish image quality: prompt/model changes also need the [visual comparison workflow](docs/model-migration.md), within an authorised generation budget.

## Code and storage boundaries

- `src/`: React UI and browser image preparation.
- `scripts/*-api.mjs`: import, outfit and Shopping APIs, used locally by Vite and by the hosted server.
- `server/`: hosted routing, durable task execution and maintenance.
- `scripts/storage-fs.mjs` and `scripts/cloud-store.mjs`: storage adapter, cloud records and writer leases.
- `.agents/skills/`: Codex workflows; [SKILL_STORAGE.md](docs/SKILL_STORAGE.md) defines destination selection, snapshots and publication.

Preserve approval before replacing saved photos, immutable accepted images, unknown record fields, and existing mutation locks/leases. Use reviewed import/save helpers instead of writing live manifests directly. Never rerun the initial cloud migration to publish an ordinary update.

Never commit `.env` variants containing credentials, `data/`, private snapshots, personal photos, generated wardrobe assets or API keys. Use fixtures for tests. Local development does not sync with production; follow [Hosting](docs/HOSTING.md) for releases, [Backups](docs/BACKUPS.md) for cloud recovery, and [Local storage](docs/LOCAL_STORAGE.md) for local recovery.
