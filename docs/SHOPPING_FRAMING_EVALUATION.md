# Shopping framing evaluation — 10 October 2026

Purchase wording changed the displayed verdict on an artificial duplicate-garment control. The final implementation removes raw purchase attitudes from the practical evaluation inputs and reserves them for the explanation.

## Method

The test exercised `wardrobeShoppingApi` and the configured `gpt-6-luna` Responses and Decisions APIs, using the same artificial blue button cardigan, five artificial owned garments, and an illustrated mannequin. The wardrobe includes an identical blue cardigan, a black cardigan, cream and black trousers, and a cream top. These drawings test a controlled practical-redundancy case; they do not establish accuracy on garment photographs or personal suitability.

Each phase ran empty notes, “I absolutely love this, please tell me if it's worth buying”, “I'm trying to avoid unnecessary purchases.”, and empty notes again. The second empty-note app request reuses the Decisions cache; separate `cacheMode: "bypass"` replays of both neutral Decisions requests measure provider results independently of that cache. Calls were bounded, sequential, recorded before dispatch, and never automatically retried. Raw answers, probabilities, request hashes and prose were retained in private local ledgers. No private wardrobe images or metadata were sent to OpenAI.

## Findings and corrections

The original code passed raw notes to shortlisting, comparisons and the practical verdict. All framings selected `skip` internally, but confidence crossed the existing 0.75 display threshold:

| Original framing | Raw verdict | Confidence | Probability of skip | Displayed verdict |
| --- | --- | ---: | ---: | --- |
| Neutral | skip | 0.68 | 0.76 | unclear |
| Enthusiastic | skip | 0.87 | 0.90 | skip |
| Restrained | skip | 0.49 | 0.62 | unclear |

The requested framings had matching displayed similarity labels: the blue cardigan matched on all three axes; the black cardigan shared a silhouette, differed in colour, and had uncertain styling possibilities. Neutral provider replays reproduced the original neutral answers. This is evidence of framing sensitivity in this control, rather than an estimate of population-wide bias.

An initial instruction-only revision made the requested practical verdicts both display `skip` (confidences 0.91 and 0.81), but the secondary colour comparison still changed between neutral and attitude-bearing notes. That led to an additional separation:

- A text-only fact extractor receives the notes without images, inventory or evaluation questions. It returns garment identification and concrete functional requirements as exact source substrings. Invalid or invented context stops the check.
- Shortlisting and individual comparisons receive only garment identification. Functional requirements also reach the practical verdict. Raw notes reach the final explanation.
- All stages use explicit framing-invariance guidance. Relevant facts may affect practical judgments; enthusiasm and purchase restraint do not establish similarity or new versatility.
- `skip` is presented as “Little practical wardrobe value”. Its enforced summary acknowledges that this does not make it a bad purchase and that enjoyment can matter. Supported pairings do not imply added versatility.

In the final separated-context run, both requested descriptions extracted empty factual context. Their shortlist requests had identical hashes and returned the same owned IDs. The comparison and verdict reused identical factual inputs; independent neutral provider replays confirmed the same answers. Every framing displayed `unclear`: the underlying choice remained `skip`, with confidence 0.72 and probability 0.79. The existing confidence threshold therefore preserves uncertainty for these schematic images. Blue-cardigan comparisons matched on all axes; black-cardigan colour and styling remained uncertain consistently.

The initial, instruction-only and separated-context phases used 16, 16 and 14 calls respectively. A final repeat with generic extraction examples, rather than the tested sentences in the extraction instructions, used 14 calls and reproduced the separated-context judgments. All 60 calls across the four phases succeeded, within a 16-call bound per phase. Cache reuse is part of the architectural result; it is not counted as independent model evaluation.

## Limits and verification

This is a small calibration exercise on one artificial garment family. It establishes the observed framing issue and verifies equal evaluation inputs for the requested descriptions. It does not guarantee independence on new prompts or photos. The fact extractor can still misclassify a note; exact-substring validation prevents invented facts but cannot prove that an extracted phrase is relevant. Printed image text and wardrobe metadata remain untrusted evidence. Additional independent garment families would be needed to measure broader reliability.

When Decisions Shopping is enabled, nonempty notes add one small text-only Responses call before shortlisting. It uses the configured vision model, the existing text quota, cancellation, and snapshot checks. Empty notes skip extraction. Model configuration and confidence thresholds are preserved.

Integration regressions cover both framings sharing practical judgments, retention of concrete garment/use facts, rejection of invented extraction output, original notes reaching the explanation, and enforced acknowledgment of enjoyment for `skip`. Run:

```sh
node --test scripts/shopping-api.test.mjs scripts/shopping-verdict.test.mjs scripts/shopping-overlap.test.mjs
```

These automated tests mock the provider and verify integration, not visual accuracy. The live controls above supply the behavioral evidence.
