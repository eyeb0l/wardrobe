# Modeled garment photos

Read this when modeled photos are part of the requested import. Cutout-only delivery does not need this workflow or an identity reference.

## Shared prompts

The web app and this skill use [the same prompt builders](../../../../scripts/modeled-photo-prompts.mjs). Render them with [the prompt helper](../../../../scripts/modeled-photo-prompt.mjs); do not maintain or paraphrase a separate image brief here. The helper only renders text and makes no API calls.

For each reviewed cutout, create `$WORK/modeled/SLUG-context.json` containing:

- `metadata`: the item's name, part, colors and tags from the reviewed manifest.
- `previousSetting`: its last modeled setting, if known, otherwise null.
- `recentSettings`: known `modeledSetting` values from the fresh library snapshot, plus settings already chosen in this batch and recent attempts. Older photos may have no recorded setting; do not invent their history.
- `direction`: the user's styling, setting or corrective direction, otherwise an empty string.

Run from the repository root:

```sh
node scripts/modeled-photo-prompt.mjs plan "$WORK/modeled/SLUG-context.json" > "$WORK/modeled/SLUG-plan.txt"
```

Read that rendered planning brief and inspect the exact garment cutout. Follow the brief to invent a fresh setting, as the outfit workflow does; there is no predetermined backdrop list. Save the resulting `setting` string into the same context JSON. On regeneration, update `previousSetting` and `recentSettings` before planning again. Honor an explicit request to keep a setting.

```sh
node scripts/modeled-photo-prompt.mjs image "$WORK/modeled/SLUG-context.json" > "$WORK/modeled/SLUG-prompt.txt"
```

Pass the rendered image prompt verbatim to Imagegen with the resolved identity image first and the exact garment PNG second. Save a horizontal 3:2 PNG as `$WORK/modeled/SLUG.png`, set `modeledFile` to `SLUG.png`, and copy the chosen setting into `modeledSetting` in the manifest. This preserves scene context for later web-app or skill generations. Keep the context and rendered prompts with the working artifacts.

## Visual acceptance

Compare every photo against both references for identity, garment fidelity, visibility, anatomy and 3:2 framing. Compare the batch for scene variety and fidelity to the planned locations while keeping the art direction cohesive. Regenerate identity drift, garment redesign, blocked details, anatomy failures, incorrect framing, or an unrequested generic studio background replacing the planned scene. Mark the item `accepted` only when its cutout and modeled photo both pass.

The styling basics allowed by the shared image prompt apply only to modeled photos; do not add tights to source-derived cutouts or create wardrobe records for styling additions.
