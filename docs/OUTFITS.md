# Outfits

Open **Outfits** or `/outfits` to browse photographs, styling notes and the exact wardrobe pieces used.

## What to wear

The shortlist at the top of Outfits offers up to three saved looks for your day.
Choose a **Shortlist occasion**, then **Not worn lately** or **Favourites**.
Favourites only includes starred looks; it does not silently fill empty results
with other outfits. Both modes put the oldest recorded garment wear first.
These controls are independent of the collection filters below.

Each choice explains the most recent logged wear of any piece in that look.
Expand **Piece history** to see each garment's last-worn date and number of logged
days, including wears in other outfits and variations. Only the pieces selected
in each wear entry count; logging the same garment in two looks on one date
counts as one day. Editing a saved combination does not rewrite past wear entries.

Looks with no garment history follow those with dated evidence and say **No wears
logged**. Partially logged looks show how many pieces have no history. Neither
state means the pieces have never been worn. If all your looks were worn recently,
the shortlist still offers the oldest available choices with their actual dates.
Ties prefer fuller history, fewer average logged days, then favourites, with
stable name/ID ordering. The shortlist makes no claim about style suitability
beyond your saved occasion labels.

Variations with the same main top/bottom or dress share one choice so shoe or
accessory changes do not fill the shortlist. When fewer than three distinct
matching looks are available, it shows fewer. Missing, hidden or deleted garments,
missing image references and unaccepted candidates are excluded. Saved cutout
variations and existing saved dress looks are eligible. The current choices check
their preview and garment images before enabling selection. A missing or corrupt
image removes affected looks and fills the slot with the next choice. Use
**Retry images** after restoring an image or recovering connectivity.

Choose a look to open its existing details, where you can change one piece,
favourite it or log a wear. The shortlist updates after logging, undoing or
changing a favourite. It uses your current collection locally, requires no API
key and makes no AI calls. A failed collection or wardrobe refresh hides the choices until
recovery. A legacy browser-edit migration warning does not hide a successfully
loaded wardrobe. **How choices are made** explains the rules in the app.

## Choose a saved outfit

Use the heart on an outfit card or **Favourite** in its details to keep favourite
looks close at hand. **Favourites**, **Occasion** and **Garment** filters work
together; **Clear filters** resets all three. These controls use the saved
collection and need no API key or model call. When using AI saved-look search,
the filters narrow its results without another request.

From a wardrobe piece, choose **View saved outfits with this piece** to open
Outfits with that garment selected. Save or discard any garment edits first.
This also works for categories that are not supported by new outfit generation.

## Log what you wore

Open an outfit and choose **Wore this today**. The date uses your device's local
calendar day. **Undo** removes that entry, and the outfit displays its logged
wear count and last-worn date. **No wears logged** means no history has been
recorded, not that you have never worn the outfit.

Expand **Log another date or edit history** to backdate a wear and uncheck any
pieces you did not wear. Each outfit can have one entry per date. To correct a
date or its pieces, remove the entry and log it again. Entries retain the garment
IDs that were worn, even if a piece is later removed from the wardrobe.

Favourites and wear history save to the selected local or cloud store alongside
the outfit, survive reloads and server restarts, and are included in existing
backups. Devices using the same cloud store see changes when they reopen or
refocus the app. They do not generate photos, call AI, or change saved-usage
ranking in AI search, which still counts appearances in saved looks.

## Save a variation

Open a saved outfit and choose **Change one piece**. Pick the piece to replace,
choose an available garment in the same category, and preview the combination
using your existing cutouts. Give it a name and choose **Save variation**.
This creates a separate saved look without an AI request or reference photo;
the original keeps its image, favourites and wear history. The new look has its
own favourites and wearing history and works with the existing filters.

Variations use the generator's supported top-and-bottom structure, with optional
outerwear, shoes and an accessory. Every piece must still have an available
cutout. Deliberate variations can reuse an existing top-and-bottom pair, including
when only shoes or outerwear change. The automatic generator still avoids
repeating base pairs.

A saved variation initially shows **Cutout preview**. Choose **Create modelled
photo** to generate a photograph of those exact pieces using your selected
reference. This is an explicit, potentially paid image request; no AI styling
plan is needed. Review the candidate and choose **Use this photo** to update only
that variation. Rejection, failure or interruption leaves the saved cutout look
intact. You can retry, add correction notes or use the existing manual-photo
upload during review. Photos do not create an extra collection entry.

Both cutouts and photos persist in local/cloud storage and existing backups.
Repeated requests with the same request ID recover the same save/job. Stale
source outfits and unavailable pieces are rejected before saving; stale photo
targets cannot overwrite a newer look. Photograph-based search and suggestions
include a variation after its modelled photo has been approved. Manual browsing,
filters and **Change one piece** also work before that.

## Generate outfits

Choose **Generate outfits**, request 1–12 looks, add optional styling direction, and select a model reference. Planning uses garment images and metadata; each combination gets a square modelled photograph.

The web generator requires exactly one top and one bottom per look, with at most one outer layer, one pair of shoes and one accessory. It currently excludes dresses. Top-and-bottom pairs must differ from saved looks and active candidates; changing optional pieces does not make a pair new. Generation requires an API key, a reference and enough unused pairs.

Jobs and review candidates persist in the selected store. Accept each reviewed look into the collection, reject it, or retry with a correction. Acceptance preserves existing looks. In local mode, interrupted generation becomes retryable after server restart. Hosted jobs run through durable workflows; an uncertain started API call is failed for review, never automatically repeated. Check API usage before explicitly retrying an interrupted paid request.

Hosted requests and workflow steps read only open jobs (planning, generating, or holding a look that is neither accepted nor rejected), so their cost does not grow with completed history; only the history list reads every job. A derived `outfit-jobs/.open-jobs.json` index records them. It is not backed up, and it is rebuilt automatically when it is missing, unreadable, or its job count disagrees with the stored jobs. After running an older release against the same cloud data, delete that file so the next request rebuilds it.

If generation fails, you can supply your own photograph instead; see [manual modelled photos](MODELED_PHOTOS.md). Image generations also collect private [refusal and retry telemetry](GENERATION_TELEMETRY.md), including eventual recovery and manual fallback. The read-only report separates models, generation types and garment categories without duplicating prompts.

## Find and refine saved looks

Optional **Find a saved look** searches your accepted outfits with a brief such as “dinner, slightly overdressed, but not corporate.” Refine the matches towards understated or statement looks, or favour pieces that appear in fewer saved outfits. Open a photographed saved look and use **Get replacement suggestions** to compare owned alternatives. **Preview variation** opens the same cutout editor with the suggested piece selected. Suggestions alone do not save a look or generate a photograph.

Search and swaps examine saved photographs and garment cutouts through OpenAI Decisions. Optional **Check crop quality** and **Check photo against pieces** flag concerns for your review without accepting or regenerating anything. Enable these features with the existing server-only OpenAI key and flag described in [Outfit discovery](OUTFIT_DISCOVERY.md).

Use the [Decisions evaluation runner](DECISIONS_EVALUATION.md) to prepare a private 25-case pilot, compare judgements with human labels, replay thresholds and measure usage. It defaults to offline planning; live runs require an explicit call limit. Runtime Decisions usage is recorded separately from generation telemetry, including cached work, refusals and unknown interrupted calls.

## Accessory suggestions

In a saved look, **Suggest accessories** sends its photograph and styling context to `OPENAI_VISION_MODEL` for text-only suggestions. They are saved and reused in the selected store. A changed photograph, vision model, styling context or accessory recipe makes fresh suggestions available. This does not alter photographs or wardrobe records.
