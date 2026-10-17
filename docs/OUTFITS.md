# Outfits

Open **Outfits** or `/outfits` to browse photographs, styling notes and the exact wardrobe pieces used.

## Generate outfits

Choose **Generate outfits**, request 1–12 looks, add optional styling direction, and select a model reference. Planning uses garment images and metadata; each combination gets a square modelled photograph.

The web generator requires exactly one top and one bottom per look, with at most one outer layer, one pair of shoes and one accessory. It currently excludes dresses. Top-and-bottom pairs must differ from saved looks and active candidates; changing optional pieces does not make a pair new. Generation requires an API key, a reference and enough unused pairs.

Jobs and review candidates persist in the selected store. Accept each reviewed look into the collection, reject it, or retry with a correction. Acceptance preserves existing looks. In local mode, interrupted generation becomes retryable after server restart. Hosted jobs run through durable workflows; an uncertain started API call is failed for review, never automatically repeated. Check API usage before explicitly retrying an interrupted paid request.

Hosted requests and workflow steps read only open jobs (planning, generating, or holding a look that is neither accepted nor rejected), so their cost does not grow with completed history; only the history list reads every job. A derived `outfit-jobs/.open-jobs.json` index records them. It is not backed up, and it is rebuilt automatically when it is missing, unreadable, or its job count disagrees with the stored jobs. After running an older release against the same cloud data, delete that file so the next request rebuilds it.

If generation fails, you can supply your own photograph instead; see [manual modelled photos](MODELED_PHOTOS.md). Image generations also collect private [refusal and retry telemetry](GENERATION_TELEMETRY.md), including eventual recovery and manual fallback. The read-only report separates models, generation types and garment categories without duplicating prompts.

## Find and refine saved looks

Optional **Find a saved look** searches your accepted outfits with a brief such as “dinner, slightly overdressed, but not corporate.” Refine the matches towards understated or statement looks, or favour pieces that appear in fewer saved outfits. Open a saved look and use **Change one piece** to compare replacement cutouts from your own wardrobe. Suggestions do not alter the saved outfit or generate photographs.

Search and swaps examine saved photographs and garment cutouts through OpenAI Decisions. Optional **Check crop quality** and **Check photo against pieces** flag concerns for your review without accepting or regenerating anything. Enable these features with the existing server-only OpenAI key and flag described in [Outfit discovery](OUTFIT_DISCOVERY.md).

Use the [Decisions evaluation runner](DECISIONS_EVALUATION.md) to prepare a private 25-case pilot, compare judgements with human labels, replay thresholds and measure usage. It defaults to offline planning; live runs require an explicit call limit. Runtime Decisions usage is recorded separately from generation telemetry, including cached work, refusals and unknown interrupted calls.

## Accessory suggestions

In a saved look, **Suggest accessories** sends its photograph and styling context to `OPENAI_VISION_MODEL` for text-only suggestions. They are saved and reused in the selected store. A changed photograph, vision model, styling context or accessory recipe makes fresh suggestions available. This does not alter photographs or wardrobe records.
