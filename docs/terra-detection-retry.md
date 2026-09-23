# Manual Sol detection retry

The manual retry flow originated in [PR #12](https://github.com/eyeb0l/wardrobe/pull/12). That release used GPT-5.6 Terra; the current model is GPT-6 Sol. The file name is retained so existing documentation links continue to work.

Crop review now offers **Retry with Sol**. It rechecks the original photo with `gpt-6-sol` at **medium** reasoning effort and holds up to eight candidate crops for review. Select the intended item and choose **Use selected item**, or **Keep current crop**. This updates only that import's crop and detected metadata; sibling imports stay untouched. The crop still needs its normal approval before garment generation. The UI explains that retries use paid API credits.

The no-clothing message also offers **Retry with Sol**, using the prepared upload retained in the current page. Its new detections enter the ordinary crop-review queue. Reloading that empty-result page does not retain the upload; an existing import's retry candidates do survive reloads.

Initial detection uses the configured default (`gpt-6-luna` by default), with reasoning effort omitted. Sol is an explicit choice. The feature changes detection only; it does not change image-generation models or automatically regenerate wardrobe images.

## Backend behaviour

- `POST /api/import/jobs/:id/detection/retry` accepts a UUID `requestId`. Only an active, unapproved crop with pending downstream stages can retry. Results return in `detectionRetry`; the current crop and metadata stay unchanged.
- `POST /api/import/jobs/:id/detection/accept` requires the current `retryId` and a valid `candidateId`. Selection updates metadata and the immutable crop asset reference, then returns to crop review.
- `POST /api/import/jobs/:id/detection/discard` requires the current `retryId` and retains the original result.
- Initial upload accepts `detectionModel: "sol"` and the former `"terra"` option for older clients; both use `gpt-6-sol`. Arbitrary model names are rejected.

Sol uses the production detection prompt/schema and original image, a 16,384-token output cap, and a provider deadline no longer than 210 seconds. Responses are validated before candidate creation. The existing text/vision quota hook runs before dispatch. Hosted routes retain origin checks and the shared writer lease; local job mutations are serialized.

Existing-job request identities are persisted before spending and retained across subsequent retries, acceptance, discard and restart. Replaying an attempted ID never dispatches again. A lost acknowledgement does not authorize automatic retry. Empty results, errors, timeouts and candidate-persistence failures preserve the current crop. A restarted client observes an in-flight marker for at most 240 seconds, then permits an explicit new attempt without automatically spending.

The empty-initial-result path uses the existing initial-upload endpoint. Its synchronous UI guard prevents duplicate clicks, but that endpoint has no durable request-ID deduplication: an explicit second submission after a lost acknowledgement may make another paid call. It never resubmits automatically.

## Original PR #12 validation

- `npm test`: **386 passed**.
- `npm run check`: passed; existing HEIC bundle size warning remains.
- `npm run build:vercel`: passed, including native workflow packaging and hosted SPA route checks.
- Independent review found a replay gap for older request IDs; durable ID history and a multi-attempt regression fixed it. No blocking findings remained.
- Browser QA used the real import API/UI with isolated local storage and stubbed provider responses. Checked loading controls, manual candidate selection/acceptance, multiple candidates, keeping the current crop, persistence after reload, provider failure, the no-clothing retry path and a 390px mobile layout.
- All provider calls during implementation/QA were mocked: **no additional paid API usage**.

Private QA fixture and state are under ignored `data/terra-retry-qa/` and are excluded from releases.
