# Tinted edges and cleanup review

This historical follow-up addressed residual magenta fringe and dropped preview updates. The subsequent [automatic cleanup workflow](automatic-garment-cleanup.md) supersedes the mandatory cleanup-review stage described below.

Cleanup now compares foreground samples across all search directions, tolerates noisy key blends, avoids amplifying colour noise at low opacity, and removes tiny detached key-coloured specks. Corrections stay within the existing boundary band. Opaque interiors and already-transparent input remain protected; a garment edge resembling the key is still inherently ambiguous.

The reviewer automatically prepares a preview when opened. Light/dark backgrounds and zoom make edges easier to inspect; strength and the original source are under **Adjust cleanup**. Changes made during a request queue the latest setting instead of being dropped. Failed requests keep the existing preview and allow an explicit retry. No model call is made.

Preview files have immutable UUID names and a cleanup recipe version. **Use this cleanup** stays disabled until the current preview loads. Acceptance requires its URL, matching tolerance and current recipe, and reuses those exact bytes before returning to normal garment review.

## Evidence

The supplied lace-blouse cutout was composited onto magenta and processed with old/new code at default (46) and maximum (110) strength. The original generated source was no longer in the active import queue, so this is a controlled replay, not an exact replay of that generation.

Pixels with alpha-weighted magenta excess above 20 channel levels fell from **3,016 to 11** at default and **2,579 to 10** at maximum (over 99% fewer). A few faint colour deviations remain; this metric is specific to this dark blouse, not a general garment-quality score. The automatic ambiguity check reports zero unresolved pixels in both new outputs. Images, metrics and fixtures remain private under ignored `data/chroma-edge-qa/`.

Validation: **420 tests passed**, including noisy edges for all three key colours, preservation regressions, detached details and stale-preview rejection. The hosted build passed. Browser QA covered automatic previews, changing strength during updates, failure recovery, light/dark backgrounds, zoom, 390px layout and acceptance into garment review. No paid model calls or live wardrobe changes were made.
