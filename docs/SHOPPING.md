# Shopping assistant

Open **Shopping** or `/shopping` to find gaps in your wardrobe or assess a particular piece before buying it.

Analysis uses `OPENAI_VISION_MODEL`, the prepared photo, selected reference, notes and labelled wardrobe image sheets. It includes current wardrobe edits and deletions from the selected store. An API key, reference and readable wardrobe images are required. Requests are never automatically retried. Shopping does not import purchases or persist its drafts/results; they survive tab switches within the app but not page reloads.

## What's missing?

Expand **What’s missing?** (collapsed by default). **Find my gaps** suggests up to three useful additions, with a short explanation, styling notes and the owned pieces to wear them with. It compares the saved wardrobe photos and details, avoids near-duplicates, and can return fewer suggestions when no clear gap stands out. At least three readable pieces and an API key are required; no shopping upload or person reference is needed. It runs only when requested and uses the same text-analysis quota as other Shopping checks. Suggestions remain through tab switches and are hidden when the wardrobe changes until you refresh them.

## Check a piece

To assess a particular piece, choose/drop/paste a listing screenshot or garment photo, select a model reference, and optionally add the occasion, price or fit you have in mind. **Check this piece** returns a recommendation, styling considerations, overlap and combinations with owned pieces. Unclear evidence may produce **A closer look is needed**; photographs alone cannot establish exact sizing, fabric quality or value.

### Visual overlap

Optional visual overlap adds owned-piece photos with separate **Silhouette**, **Colour/pattern** and **Styling possibilities** judgements to **Anything similar?** after **Check this piece**. The assistant shortlists up to three possibilities, then Decisions compares their individual cutouts with the uploaded candidate. Similar silhouettes can coexist with different colours or styling possibilities. Decisions then chooses the advisory recommendation from the candidate, selected reference, all owned contact sheets and the structured comparisons; the assistant explains that fixed verdict afterwards. Failed or uncertain verdict checks stay **Unclear**. Other owned pieces are not compared individually. Enable the additional server flag described in [Hosting](HOSTING.md#optional-decisions-features); it is off by default.

With visual overlap enabled, Shopping extracts garment-identification facts and concrete intended uses from non-empty notes before evaluating practical value. Enthusiasm and purchase restraint inform the explanation. A **Little practical wardrobe value** result can still acknowledge enjoyment as a reason to buy. Non-empty notes add one text-only analysis call. See the [framing evaluation](SHOPPING_FRAMING_EVALUATION.md) for observed behaviour and limits.

## Upload preparation

Shopping accepts the same source formats and limits as [imports](IMPORTING.md#upload-preparation), but always prepares a JPEG locally at a maximum 1,600-pixel edge and under 2 MB, removing embedded metadata such as EXIF location. HEIC uses native decoding when available and a lazily loaded local decoder otherwise. The server validates and normalises the image again.
