# Saved-outfit discovery with Jev

The optional discovery feature reuses accepted outfits and existing garment cutouts. It adds:

- **Find a saved look** on Outfits: enter a mood or occasion and browse matching saved photographs and their existing notes.
- **Best match / More understated / More statement** and **Favour pieces in fewer saved looks**: reorder the same judgments locally without another request. Saved appearances are not actual wearing history.
- **Change one piece** in a saved look: select a piece and describe the change. Compare up to six owned alternatives in that category beside the original photo. Other pieces remain fixed; the saved outfit is never modified.

Detection, Shopping assessments, scene planning, accessory prose and image generation retain their existing providers and approval workflows.

## Enable

In ignored local `.env` configuration, set these server-only values and restart Vite:

```dotenv
WARDROBE_JEV_ENABLED=1
TYPESAFE_API_KEY=your-typesafe-key
```

For hosted use, set both in Vercel **Production only**, keep All Deployments authentication enabled, and redeploy. Do not add a `VITE_` prefix or commit credentials. The flag defaults off. With the flag on but no key, browsing remains available and the finder explains that discovery is unavailable. A provider failure restores ordinary browsing; **Browse all** also clears results at any time.

## API and data boundaries

`scripts/jev.mjs` uses native fetch with the [TypeSafe HTTP API](https://docs.typesafe.ai/api) at `POST https://api.typesafe.ai/v1/systemone`. It pins the [documented model](https://docs.typesafe.ai/models) `jev-1.13.0`. The key never reaches the browser.

`scripts/outfit-discovery-api.mjs` exposes:

| Route | Request / result |
| --- | --- |
| `GET /api/outfits/discovery/config` | `{ enabled, ready }`; no credentials |
| `POST /api/outfits/discovery/rank` | `{ brief }`; scores every eligible accepted outfit |
| `POST /api/outfits/discovery/swaps` | `{ brief, outfitId, garmentId }`; scores available same-category pieces outside that outfit |

POSTs require same-origin JSON, a nonempty brief of at most 500 characters and a body of at most 4 KiB. Inputs never provide the candidate inventory: the server reads current records. Hidden/deleted pieces, missing cutouts and unavailable saved photographs are excluded. Only accepted outfits whose complete membership is still available are eligible. Saved outfits that cannot be searched remain accessible through ordinary browsing.

TypeSafe receives the brief, bounded names, categories, tags, approximate colour names, outfit occasions and styling notes; swap requests also include the original and fixed pieces. Hex colours are converted in code. No photograph bytes, image URLs, identity references, internal prompts, or arbitrary record fields are sent. Metadata reads and contained-file checks precede scoring without downloading garment or outfit images.

Each candidate gets a comparable suitability Score, an understated-to-statement Score and a separate sufficient/unknown evidence Choice. IDs come from server candidates. Responses must contain valid numeric values and the pinned model. The API returns `rankings`, `rankedIds`, `unknownCount`, `candidateCount`, `cached`, and `inputTokens`. Confidence is retained as a model signal, not displayed as a guarantee of a good outfit. An evidence answer of `unknown` never becomes a forced recommendation.

The initial display heuristic includes sufficient-evidence candidates with normalized suitability at least `0.5`. Style preference adds up to `0.2`, and lower saved usage adds up to `0.15`, to the sorting value without rescuing unsuitable/unknown candidates. These are product defaults, not empirically calibrated fashion-quality thresholds. Zero qualifying candidates produces an explicit no-match state.

## Cost, caching and freshness

- Up to 12 candidates per request; all candidates are covered, with no silent shortlist. Each provider payload is bounded to 55,000 UTF-8 bytes, including at most 24,000 state bytes. Oversized payloads fail with an explanatory browsing fallback.
- The whole interaction has a 12-second provider-work deadline. Completed batches can be reused if a later batch times out. No automatic paid retries. A disconnected browser stops subsequent batches; an already dispatched batch can finish and populate the shared cache.
- A bounded process-local cache holds up to 64 batch results for 15 minutes. Its key includes the brief, model, question version, current wardrobe/collection metadata, file availability, data directory and a hash incorporating the server credential. It survives fresh plugin instances in a warm process, but cold starts can make new calls. Nothing is persisted to library manifests or browser storage.
- Duplicate in-flight batches share work. At most two distinct provider requests run per process. Hosted requests retain the existing cloud writer lease.
- Each actual hosted batch reserves one existing text API allowance immediately before dispatch. Cache hits, identical in-flight callers and empty candidate sets reserve none. Failed/uncertain dispatches still count. Local development has the same behaviour as other local model APIs: no hosted daily quota enforcement.
- `inputTokens` reports newly billed provider input tokens when supplied, zero for cached work, or null if unavailable. It is not a currency estimate or a durable usage ledger.
- The server rereads metadata and availability after scoring; a changed snapshot returns 409. The browser cancels stale requests and invalidates results when wardrobe or collection metadata changes. Removing a piece or editing a saved brief never leaves old results presented as current matches.

## Validation

```sh
node --test scripts/jev.test.mjs scripts/outfit-discovery.test.mjs
npm test
npm run check
npm run build:vercel
git diff --check
```

Contract tests use provider fixtures and cover request shape, cache reuse/invalidation, quotas, timeouts, invalid responses, unknown evidence, deletion during inference, fixed-piece swaps, payload bounds and batching. Browser checks should cover results, refinements without repeat calls, Browse all, empty states, errors, swaps, and narrow viewports.

Before treating the feature as quality-validated, run live Jev on representative accepted looks and your own briefs. Compare actual top matches, missed alternatives and unknown handling; record token usage and end-to-end latency. Contract and UI tests alone do not establish styling quality, image-generation savings or correctness of the initial display threshold.
