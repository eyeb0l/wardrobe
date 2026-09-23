# Automatic garment cleanup

Generated garments pass through a durable `cleaning` stage before normal garment review. New API cutouts request a transparent PNG directly from Sunburst. The original API PNG is retained, and a free local correction makes only established near-opaque fabric interiors fully opaque. The correction can resume after interruption without repeating image generation. The user still reviews every generated garment for shape, detail fidelity and edge quality before approval.

The native correction requires a PNG with a meaningful transparent background and visible garment. It sets alpha to 255 only when the pixel and its full 5×5 neighbourhood already have alpha at least 250. RGB, antialiased boundaries, openings and more transparent fabric are unchanged. If the API returns an opaque or empty image, the job fails with the raw output saved for diagnosis; it never silently strips a guessed background. The three-image API trial and corrected samples are in ignored private `data/native-transparency-qa/api/`.

## Earlier chroma-key jobs

Jobs generated before the native-transparent change still use the saved green/cyan/magenta source and the existing cleanup controls. Their processing and review behaviour is described below. New native-transparent jobs cannot invoke the chroma preview or acceptance routes.

## Selection and quality checks

For earlier chroma-key jobs, each candidate starts from the same source at strengths 46, 62, 78, 94 and 110. The first candidate passing all checks wins. If none passes, the safest candidate with the lowest remaining spill severity is shown in normal review, with suspect regions highlighted and optional **Adjust edges**. The system never approves a garment for the user.

`scripts/chroma-processing.mjs` contains the existing boundary-matting algorithm. `scripts/automatic-chroma-cleanup.mjs` adds an output-space check independent of strength and the cleaner's corrected-pixel counter. It examines visible key-colour excess relative to neighbouring opaque fabric after resizing, including detached specks and partial alpha. A single bright pixel can fail; no whole-image average hides a small cluster.

A final conservative repair uses nearby neutral opaque samples for residual tint in established feather pixels or pixels already corrected by matting. It preserves alpha. Existing transparent inputs bypass repair. The finished output is checked again. Ambiguous opaque fabric is left visible for review.

Preservation checks run before framing, in source coordinates: protected opaque interiors cannot change, substantial disconnected garment pieces cannot disappear, and lost non-key coverage is bounded to 0.5%. Small wholly key-coloured residue is excluded from the garment coverage budget. These are conservative checks, not proof of semantic garment fidelity; ordinary visual approval remains required. A stronger candidate that cannot retain a visible garment is discarded.

Manual previews use immutable filenames and a recipe version. Acceptance reuses exactly those preview bytes. Temporary storage-busy responses for cleanup requests retry with bounded backoff. Garment approval includes the displayed asset URL so a changed candidate cannot be approved from a stale screen.

## Concurrency and recovery

Cloud generation and automatic cleanup release the shared storage writer while awaiting the provider or doing image processing. Quota reservation, task ownership and generation-attempt telemetry are persisted before paid dispatch. A durable ownership deadline prevents another delivery from treating an active detached worker as interrupted.

Reacquiring the writer requires a new lease token, the same running task owner and an unchanged job revision. Failed validation fences both result and error writes. Mutations to that active job are rejected until processing finishes; unrelated items remain usable. A stale paid operation is never replayed automatically. A `cleaning` stage is replayable because it works only from saved bytes. Cleanup is a separate workflow step, so a crash after generation does not require another image request.

The local Vite flow also resumes `cleaning` jobs after restart. This release does not remove the writer from all synchronous app endpoints (for example initial garment detection and shopping); the worker generation and cleanup paths are the scope of this change.

## Exact T-shirt regression, 23 September 2026

The retained generated source was recovered from private storage. Its old default cleanup reproduces the reported **30 unresolved pixels**. The old strength-110 output is byte-for-byte identical to the approved cloud cutout.

- Source SHA-256: `71b4868b163ebc015eaeb82ad061c35fcc7096716b6b1598f9a3af67c3cd87e9`.
- Approved / old strength-110 SHA-256: `342ad3cd79b367f3a0687363601e9797ebb39ac45579d1d370c0bf9563e8f891`.
- Fixed final-output detector: default 96 suspect pixels; approved 8; automatic 2.
- Automatic selection: **110**, with zero protected-interior changes and zero missing substantial components. Non-key coverage loss relative to default was about 0.031%.
- The two remaining faint pixels are flagged for review. No threshold was relaxed to label the result clean.

The counters use different definitions; the original 30 must not be presented as directly comparable to the new detector's 96. Enlarged left-underarm, right-underarm and neckline comparisons show the bright green specks removed. The images remain private under ignored `data/automatic-cleanup-qa/`.

Reproduce without provider calls:

```sh
node scripts/check-cleanup-reference.mjs SOURCE.png APPROVED.png NEW_OUTPUT_DIRECTORY
```

Validation: 430 tests passed. Regression coverage includes escalation to 110, a single bright partial-alpha pixel, ambiguous fabric, detached details, lace/straps/transparent-input preservation, interrupted cleanup, concurrent unrelated writes, duplicate delivery, and stale-result fencing. The hosted build passed. Isolated Playwright QA at 1440×1100 and 390×844 exercised light/dark background selection, zoom, manual preview acceptance, automatic retry after an injected 409, automatic cleanup and close/reload/reopen recovery. No framework or page errors; the injected 409 produced the expected resource console message. Browser plugin was not available; bundled Playwright was used. No paid API calls were made.
