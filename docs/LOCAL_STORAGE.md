# Local storage and recovery

These instructions apply to local development and explicitly selected local skill workflows. They do not update the hosted wardrobe. For cloud operations, use [Hosting](HOSTING.md), [Backups](BACKUPS.md) and the [shared skill storage workflow](SKILL_STORAGE.md).

## Save a reviewed Codex collection

Only one outfit writer process may own a data directory. Stop the Wardrobe server using that directory, then validate and save from the repository root:

```sh
node scripts/save-outfit-collection.mjs /path/to/staged/outfits.json --target local --dry-run
node scripts/save-outfit-collection.mjs /path/to/staged/outfits.json --target local
```

The staged version-1 manifest must contain only reviewed, accepted records. Each `image` must name a PNG in the `outfit-images/` folder beside the manifest, for example `outfit-images/navy-camel.png`. Keep the entire staging directory outside live data.

The helper resolves `WARDROBE_DATA_DIR` from the environment or `.env`; `--data-dir PATH` overrides it. It adds records, preserves existing records and unknown fields, and uses immutable content-hash image filenames. Identical reruns succeed; conflicting IDs, metadata or image bytes are rejected. Restart the server after saving. Do not edit the live manifest or replace accepted images directly.

## Writer ownership

Writer ownership is recorded in `.outfit-store.lock`. A provably dead process on the same host can be recovered automatically; unreadable locks, locks from another host, and interrupted `.outfit-store.recovery` guards require inspection with all writers stopped. Never delete a live process's lock or run two app copies against the same directory.

## Back up and restore

Stop the server and back up the **whole configured data directory together**: `outfits.json`, `outfit-jobs/` (candidates and job state), `outfit-images/`, `outfit-accessories.json`, the wardrobe library, import jobs, imported images and local references. Back up separately configured model-reference files too.

Restore a consistent backup as a unit. Exclude transient `.outfit-store.lock`, `.outfit-store.recovery` and `.outfit-store-owner-*.tmp` files so the app acquires fresh ownership on startup. Atomic replacement helps interrupted writes; it neither replaces backups nor guarantees survival after power loss.

## Damaged or missing data

Damaged collection or job files are reported and preserved for repair or restoration. A missing manifest with surviving outfit images or jobs is treated as missing data, not a new empty wardrobe. Unsupported future versions must remain untouched; use a compatible app version. Any future migration should back up the original first, validate records before and after conversion, and preserve unknown fields.

Invalid individual accessory suggestions become cache misses. If all of `outfit-accessories.json` is corrupt:

1. Stop the server, preserve a copy and inspect the file.
2. For malformed JSON or a damaged version-1 structure, move the file aside under a distinct backup name.
3. Restart and explicitly request suggestions to rebuild this optional cache.

Leave a readable unsupported-version cache untouched and use a compatible app version. Do not reset collection or job files during accessory-cache recovery.
