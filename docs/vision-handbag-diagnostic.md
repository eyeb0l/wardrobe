# Handbag fidelity diagnostic — 2026-09-20

**Keep Luna medium for now. Fix the chroma cleanup defect before relying on a larger-model retry to solve color fidelity.** Terra low had better raw handle localization in this example, but was less consistent at rejecting its incorrect color.

The user supplied an original navy/slate-blue tote with brown trim and an imported version whose fabric looks dark purple. This is a focused diagnostic of one known failure, not a representative benchmark. Nothing was regenerated, replaced in the wardrobe or deployed.

## API test

Twenty calls, all completed: Luna medium and Terra low, two repeats each, on five fixtures. Two fixtures replay the actual production detection request on each image using the app's browser preprocessing and server normalization. Three use a new neutral fidelity-review prompt: original/candidate in both display orders, plus a faithful downscaled-original control. The prompt did not reveal the user's color complaint. The expected mismatch and control outcome were recorded before calls. Repeated calls/order swaps are not independent products.

| Outcome | Luna medium | Terra low |
|---|---:|---:|
| Original described as navy/blue with brown trim | 2/2 | 2/2 |
| Real mismatch rejected | 4/4 | 2/4 |
| Main-body color explicitly flagged as a major mismatch | 4/4 | 1/4 |
| Faithful resize control accepted | 2/2 | 2/2 |
| Cost for all 10 calls | $0.0082316 | $0.0661760 |

Terra accepted the purple candidate in two trials, attributing it to lighting/viewpoint. Its second rejection primarily asserted absent pocket/logo details at low resolution and rated color only a minor issue. That is weaker evidence for the user's specific color problem than Luna's consistent major-color warnings. Some answers from both models used overly specific material/construction descriptions; these counts measure color recognition/rejection, not comprehensive answer quality.

Both models' detection responses still called the imported purple-looking bag “navy,” although their hex estimates were purple-toned. This illustrates why a single short item label should not be treated as a fidelity check.

Terra did better on the original's raw top bounding coordinate: 190/192 versus Luna's 248, against an opaque-foreground bound of approximately189 (normalized0–1000). However, production crop padding can recover much of Luna's missed area, so this does not establish a final crop failure. The source is genuinely transparent: approximately71.4% of pixels are fully transparent. Luna marked it non-clean twice; Terra marked it clean once and non-clean once. The current “Use original” option requires the model's clean flag as well as a deterministic background check, so this inconsistency can hide the pixel-preserving option.

## Reproduced processing defect

The saved snapshot record for this bag is `import-d8c60e08-bb0a-42a5-a41d-58d601c378d6`, with blue primary `#1e3445` and brown secondary `#8b503b`. Those colors select cyan `#00ffff` as the generated background key.

Current cleanup applies spill suppression throughout the foreground. It interprets legitimate green/blue channel strength as cyan contamination, subtracts those channels and reduces opacity. A small synthetic opaque patch using the saved blue color, passed through the actual production helper, changed as follows:

| | RGBA |
|---|---|
| Before | `[30, 52, 69, 255]` |
| After cleanup/framing | `[29, 20, 38, 210]` |

That is a blue-to-purple shift and unwanted translucency even though the input contained **no cyan background or spill**. The existing verifier still reported `contaminatedPixels: 0` and `maxSpill: 0`, because it checks removal of key-channel dominance rather than preservation of the garment.

This proves a present code defect capable of explaining the observed direction of change. It does not establish this saved import's exact historical cause: metadata is editable, the image model also regenerates pixels, and the original job's pre-cleanup generated image was unavailable in the snapshot. Completed jobs are removed, including their intermediate assets.

Relevant code:

- [Key selection and image-generation prompt](../scripts/import-job-api.mjs#L166): color metadata selects the key and supplies hints, but the prompt explicitly prioritizes the reference image.
- [Chroma cleanup](../scripts/import-job-api.mjs#L228): global channel suppression and alpha reduction; subsequent passes repeat suppression.
- [Spill verification](../scripts/import-job-api.mjs#L331): no source-to-result garment fidelity comparison.
- [Extraction pipeline](../scripts/import-job-api.mjs#L586): image generation, raw generated source saved, then cleanup.
- [Original eligibility](../scripts/import-job-api.mjs#L874) and [use-original route](../scripts/import-job-api.mjs#L917): direct copy can avoid regeneration and cleanup, but is gated by the model's clean flag.

## Recommended order of work

1. Correct cleanup so legitimate foreground colors/opacity survive; add regression coverage for blue with cyan, and analogous garment/key combinations. Validate edge cleanup as well as interior fidelity.
2. Improve access to the original-preserving path for already isolated transparent product photos. This particular original does not need generative reconstruction.
3. Trial source-versus-result fidelity review with Luna medium on a broader set of real accepted/rejected imports. This small test supports that workflow, but is not enough to ship an automatic acceptance gate.
4. Evaluate a Terra retry for difficult detection/localization separately. Switching the vision model does not repair downstream channel suppression.

The retry UI, cleanup implementation and saved wardrobe image remain unchanged in this diagnostic.

## Cost and evidence

Incremental API cost: **$0.0744076**. All 20 calls returned usage; no new retries or unresolved charges. Combined with the earlier evaluation, recorded usage is **$1.700587737**, with a conservative maximum of **$1.833704537** including the earlier eight uncertain calls. The original $10 cap remains enforced by the same ledger.

Private evidence: `data/vision-eval-api-2026-09-20/handbag-diagnostic/` contains original file copies/hashes, production-captured inputs, frozen protocol/schema, all result mappings, alpha-bound measurements and `cleanup-reproduction.json`. Raw responses and accounting remain in the shared `run/` directory. Only the evaluation runner was extended with a distinct diagnostic phase; all 30 runner tests passed, including the new shared-ledger/schedule-preservation test. No production code changed.

The original 300-call benchmark is preserved separately as `run/benchmark-300-ledger.json`; its reported results are unchanged. The live `run/ledger.json` now includes these 20 additional diagnostic calls.
