# Generation refusal telemetry

The app quietly records image attempts for garment cutouts, modeled garment photos, and modeled outfits. It does not switch models, retry automatically, or send analytics to a third party. Collection starts when this code runs; older generations are not backfilled. Detection, outfit planning and modeled-scene planning are excluded from image-attempt denominators. A failure before an image request is dispatched is not an image refusal.

## Records and privacy

`WARDROBE_DATA_DIR/generation-telemetry/*.json` uses the same storage adapter as jobs: local files locally, private database metadata in hosted storage under the existing writer lease. Include this directory in backups. Records survive deletion of temporary import jobs. There is no automatic retention cutoff yet.

Each image record contains:

- Provider hostname (without credentials, URL paths or query strings), configured model, generation type, job/garment/outfit identifiers, and an episode identifier.
- Garment categories captured at generation time. `subtype` currently distinguishes skirts and bodysuits using names/tags and explicitly labels that inference `name-or-tags-v1`. Missing subtypes remain unknown; these are not a comprehensive or manually verified taxonomy.
- `attemptNumber`, counting image dispatches within the episode, and `pipelineAttempt`, identifying the existing generation record. Scene-planning failures and manual uploads do not increment the image counter.
- Start/end timestamps, outcome (`succeeded`, `refused`, `technical_failure`, or `unknown`), HTTP status, bounded API error code/type, and local error class.
- SHA-256 prompt/reference fingerprints and a pointer to the existing generation record. No prompt text, response/error messages, image data, garment names/tags, or API keys are copied into telemetry.

Refusals require an explicit refusal field or a recognized API code/type (`content_policy_violation`, `moderation_blocked`, `safety_violation`, `safety_system`, `content_filter`, `refusal`). HTTP 400/403 alone and arbitrary error-message wording do not prove refusal. Unrecognized provider errors count as technical failures; inspect code distributions before interpreting category comparisons. Extend the explicit mapping when a new provider code is verified.

Success means image generation/processing produced a candidate, not that the user approved its appearance. A timeout is a technical failure from the app's perspective; the provider may still have produced/billed a result. A process interruption leaving only a start record remains `unknown` and is excluded from completed-attempt rates. Telemetry is best effort: a storage failure emits a generic warning without causing another paid call or discarding an image. Therefore counts can be incomplete during outages. The report flags gaps in recorded attempt numbers and excludes a missing first attempt from first-attempt metrics. Entirely missing episodes cannot be detected.

Prompt fingerprints allow comparison, not reconstruction. Outfit job history retains its prompt; import prompts can be overwritten by a retry and import jobs are removed after completion/rejection. Telemetry does not extend that existing prompt retention policy, so an expired record pointer cannot recover the exact prompt.

## Retry episodes and manual fallback

An episode groups an initial request with retries after failure. Generating again after a reviewable success starts a new episode, so creative revisions do not lower first-attempt success. A new replacement job also starts fresh. Existing pre-telemetry jobs begin a new observed episode on their next request; they have no historical coverage.

Manual uploads record separate `uploaded` and `approved` events. Re-uploading does not become an image attempt, and manually approving a photo does not become model recovery. Counts distinguish upload usage from accepted photos. An upload following unresolved refusal is a manual fallback; uploading after a generated success starts a separate manual episode. Discarding a job and reopening it starts a new episode, even for the same garment. Garment IDs remain available for longitudinal investigation.

An outfit can include multiple categories. It contributes once to each represented category/subtype cohort, never once per garment of the same category. Those rates indicate association with an outfit, not which garment caused refusal. Keep `outfit_modeled`, `garment_modeled`, and `garment_cutout` separate when comparing results.

## Read-only report

Local fixture or local installation:

```sh
node scripts/generation-telemetry-report.mjs --target local --data-dir /absolute/path/to/data
```

Hosted collection (using the existing private cloud credentials):

```sh
node --env-file=.env.cloud scripts/generation-telemetry-report.mjs --target cloud
```

The command prints JSON, makes no model calls, and changes no collection data. With no observations, denominators are zero and rates are `null`. Every rate includes numerator and denominator; rates are fractions, so `0.85` means 85%.

| Metric | Definition |
| --- | --- |
| `firstAttemptSuccess` | First observed image attempt succeeded / episodes with a known first outcome. |
| `firstAttemptRefusal` | First observed image attempt refused / episodes with a known first outcome. |
| `manualFallbackUsage` | Episodes using a manual upload after unresolved refusal / episodes with any observed refusal. |
| `secondAttemptRecovery` | Second image attempt succeeded / initially refused episodes with a known second outcome. |
| `eventualRetryRecovery` | Any later image success / initially refused episodes with at least one completed retry. |
| `sameModelRetryRecovery` | Same numerator restricted to successes from the initial provider/model, over the same retried cohort. |
| `recoveryAmongAllInitiallyRefused` | Eventual image recovery / all initially refused episodes, including those not retried. |
| `observedHardRefusal` | At least three image attempts, all refused, with no unknown attempt / episodes with a known first outcome. |
| `attemptRefusal` | Refused image attempts / completed image attempts (secondary diagnostic). |

The report includes API outcome/code distributions for investigating unfamiliar errors. It also shows initially refused episodes, those without any retry, unknown attempts, technical failures, episodes with changed retry inputs, manual uploads, manual approvals, and uploads after unresolved refusal. A model or input change is visible, and a different model's success is not credited as same-model recovery.

Cohorts are attributed to the **first observed provider/model** in the episode, with separate generation types and category/subtype rows. Their later attempts can use different models; use the same-model metric and changed-input counts when assessing a model. Small samples (fewer than 30 known first outcomes) are flagged. This is a descriptive signal, not a confidence threshold: also inspect refusal/retry denominator sizes and observation time before drawing conclusions.

“Hard refusal” is provisional evidence of repeated refusal, never proof that a garment is deterministically impossible. Later success removes that episode from the metric. Scene planning can change the prompt on a retry; fingerprints expose that distinction. Review recovery and manual fallback alongside refusal frequency rather than using raw refusal rate alone.
