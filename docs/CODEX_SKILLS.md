# Using Wardrobe with Codex

Open this repository in Codex and use a bundled skill:

```text
$import-clothes Import the clothes from ~/Pictures/outfits, create modelled photos, and add them to this wardrobe.
$generate-outfits Create 8 modelled outfit ideas from my wardrobe.
$shopping-assistant Would the piece in this screenshot be a good addition to my wardrobe?
$shopping-assistant Review my wishlist in the browser and shortlist the pieces that add the most to my wardrobe.
$shopping-assistant Find a navy wool cardigan under £100 on my preferred sites and compare it with what I own.
```

- [Import Clothes](../.agents/skills/import-clothes/SKILL.md) inventories source photos, reviews cutouts and modelled photos, then imports approved results. Cutout-only delivery skips modelled generation and database writes.
- [Generate Outfits](../.agents/skills/generate-outfits/SKILL.md) uses the requested count, or asks if it is missing, then curates, generates, reviews and saves the complete batch.
- [Shopping Assistant](../.agents/skills/shopping-assistant/SKILL.md) compares candidates with the selected reference and owned clothes. When requested, it reviews live wishlists or retailer listings. Advice does not import purchases or save a Shopping-tab result.

Skills follow the [shared storage workflow](SKILL_STORAGE.md): take a fresh private snapshot, stage results outside the live store, dry-run, then publish with the storage helpers. Cloud is the default; explicitly request local mode for a local-only setup. Cloud access failures must not silently fall back to the local migration copy.

Codex import and outfit skills use Codex Imagegen, whose model is selected by Codex, not the [configuration variables](CONFIGURATION.md). Shopping advice in Codex normally makes no separate app API call.

## Agent setup

Agents setting up Wardrobe should establish whether the user wants Codex-assisted imports or the web UI, obtain the source folder and identity reference if missing, and follow the relevant setup in the [README](../README.md#quick-start) and [Configuration](CONFIGURATION.md). Honour any supplied destination, count and generation scope.
