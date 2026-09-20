# Encrypted cloud backups and recovery

The cloud wardrobe is authoritative. These tools create independent, dated recovery points outside Git and the working `data/` directory. Backups contain actual image bytes, so later cloud garbage collection cannot invalidate them. No backup command calls a model API.

## Contents and consistency

Exports include persistent cloud files: the library (edits, hidden items, and deletion tombstones), original/modeled images, outfits, references, prompts, import/outfit jobs and source images, task history, and both daily API counters. Transient dotfiles, locks, `.tmp` files, and garbage-collection progress are excluded. Display WebP caches regenerate from originals; provider workflow executions are not backed up.

File contents and snapshot manifests use authenticated AES-256-GCM encryption. Objects are deduplicated by checksum across snapshots. Later exports reuse locally verified encrypted bytes for unchanged immutable cloud images. The manifest is published last, so an interrupted export leaves completed recovery points usable.

Export holds the same renewable writer lease as editing, generation, and cleanup. Reads remain available; writes may report busy, especially during the first full download. A busy lease makes export fail so a scheduler can retry. Existing installations with the standard application schema need no migration or deployment for these tools.

## Initialize and export

Use Node 22.x, installed project dependencies, and a stable checkout. Keep production `DATABASE_URL` and `BLOB_READ_WRITE_TOKEN` in a private credentials file such as the ignored `.env.cloud`. No OpenAI key is needed. The Blob token permits writes/deletions, so protect it as a production secret; export only reads cloud files and acquires/releases the database lease.

Create a private key directory, then initialize a **new** backup repository and key:

```sh
mkdir -p "$HOME/Library/Application Support/Wardrobe Backup Keys"
chmod 700 "$HOME/Library/Application Support/Wardrobe Backup Keys"
node scripts/wardrobe-backup.mjs init \
  --repo "$HOME/Library/Application Support/Wardrobe Backups" \
  --key-file "$HOME/Library/Application Support/Wardrobe Backup Keys/primary.key"
```

Both parent directories must exist. Initialization refuses existing destinations; the key must be outside the backup repository, and both must be outside Git. Save a separate secure copy of the key: **losing it makes backups unrecoverable**. Keep an off-device copy of the complete encrypted repository, with its recovery key stored separately. Never commit backups, restored data, credentials, or keys.

Environment variables can replace repeated `--repo` and `--key-file` arguments:

```sh
export WARDROBE_BACKUP_DIR="$HOME/Library/Application Support/Wardrobe Backups"
export WARDROBE_BACKUP_KEY_FILE="$HOME/Library/Application Support/Wardrobe Backup Keys/primary.key"
node --env-file=.env.cloud scripts/wardrobe-backup.mjs export
node scripts/wardrobe-backup.mjs verify
node scripts/wardrobe-backup.mjs list
node scripts/wardrobe-backup.mjs status
```

`verify` authenticates the manifest, decrypts every referenced object, and checks size and SHA-256. `list` returns snapshot IDs. `status` verifies the latest snapshot and exits **2** when none exists or it is over 48 hours old, **1** on error, and **0** when healthy. `verify` and `restore` accept `--snapshot ID`; otherwise they use the latest snapshot. Only cloud operations need cloud credentials.

Do not edit the encrypted repository by hand, and copy it only while no backup command is running. All commands after initialization use a `.lock` directory. After a crash, inspect `.lock/owner.json` and confirm the recorded process and all backup processes have stopped before removing only that stale lock. Locks are never automatically stolen.

## Restore locally first

```sh
node scripts/wardrobe-backup.mjs restore \
  --snapshot SNAPSHOT_ID --out "$HOME/Wardrobe Recovery Test"
```

The output must be new, outside Git and the backup repository, with an existing parent directory. Files are verified before restoration and read back afterward. `.restore-complete.json` marks success; never use an incomplete restore as a recovered wardrobe.

The encrypted backup stays exact. The restored copy pauses unfinished generation, removes dispatch authorization, and retains terminal task records. Opening it cannot automatically resume paid work. Approved images and completed outcomes remain; an explicit retry starts a new paid request. The result reports the number of paused jobs.

Inspect through a separate local server with `WARDROBE_DATA_DIR` set to the recovery directory and `WARDROBE_MODEL_REFERENCE` to its `model-reference.png`. For a drill, use a checkout without development secrets and leave `OPENAI_API_KEY` empty. The app may perform normal housekeeping on this working copy. See [local storage and recovery](LOCAL_STORAGE.md) for local-server storage behavior.

## Restore to cloud

Cloud recovery is a **full replacement**, not a merge. Restore locally and inspect first, then stop active generation at the destination.

```sh
# Verify backup bytes and inspect the destination fingerprint; no content writes.
node --env-file=.env.cloud scripts/wardrobe-backup.mjs restore \
  --target cloud --snapshot SNAPSHOT_ID

# Apply using the fingerprint from that reviewed dry run.
node --env-file=.env.cloud scripts/wardrobe-backup.mjs restore \
  --target cloud --snapshot SNAPSHOT_ID --apply --replace \
  --expect-destination FINGERPRINT_FROM_DRY_RUN
```

The dry run acquires/releases the writer lease. Changed destination data invalidates its fingerprint and requires a fresh dry run. Before replacing a nonempty destination, the command makes a complete safety backup; failure stops replacement. Binary files receive new private immutable Blob URLs and are read back for verification. A single fenced database transaction switches all file metadata. Failed uploads/publication leave old metadata intact; unpublished uploads become eligible for normal cleanup.

Today's destination API counters are preserved; a backup from the same UTC day can raise either counter but cannot lower it. Existing destination task IDs are retained as terminal records, preventing delayed workflow deliveries from restarting generation. Old writer leases, cleanup decisions, and cached WebP URLs are not restored. Newly unreferenced Blobs follow the normal seven-day cleanup grace period.

A new destination must already have the application schema. It still needs a reviewed fingerprint and `--apply`; `--replace` is required only when files exist. The command does not provision services or credentials.

## Daily backups on an always-on host

Use a stable checkout, installed dependencies, private credentials, and the backup key on the chosen always-on host. Initialize a new repository/key there, or transfer the complete encrypted repository and its key separately. Use permanent paths rather than a temporary verification machine or Codex worktree.

The portable scheduler command is:

```sh
node --env-file=/absolute/path/to/private/cloud.env \
  /absolute/path/to/wardrobe/scripts/wardrobe-backup.mjs run-due \
  --repo /absolute/path/to/backups --key-file /absolute/path/to/backup.key
```

`run-due` verifies and skips a successful backup less than 24 hours old. Otherwise it exports, verifies, and applies retention. Running it hourly retries busy/offline/failed attempts without producing hourly snapshots. `run` performs the full sequence immediately.

Retention keeps the newest snapshot from each of 7 distinct days, 4 distinct weeks, and 6 distinct months, taking their union. This preserves older points across long outages. Pruning runs only after a successful export and verification. Standalone `prune` previews removals; `prune --apply` removes them. Both authenticate and verify every snapshot first, and retained snapshots' shared objects survive.

### macOS LaunchAgent

On the always-on Mac, generate and inspect a plist first:

```sh
node scripts/install-backup-schedule.mjs \
  --project /absolute/path/to/wardrobe \
  --env-file /absolute/path/to/private/cloud.env \
  --repo /absolute/path/to/backups --key-file /absolute/path/to/backup.key \
  --out "$HOME/wardrobe-backup.plist"
plutil -lint "$HOME/wardrobe-backup.plist"
```

After reviewing it and completing a first backup/recovery drill on that host, repeat with `--install` instead of `--out ...`. Run as the signed-in user, without `sudo`. Use `--node /absolute/path/to/node` if the current executable is not permanent. Existing plists/schedules are never overwritten.

The agent runs at login and hourly, with absolute paths and private logs in `<backup-repository>.logs/backup.log` and `backup-error.log`. Generating the plist does not enable it; installation does. The user must remain logged in and the Mac needs power and network access.

```sh
# Inspect the registered job.
launchctl print "gui/$(id -u)/com.iris.wardrobe-backup"

# Stop/unregister it for the current login session.
launchctl bootout "gui/$(id -u)/com.iris.wardrobe-backup"
```

To prevent loading at a later login, deliberately remove the installed `~/Library/LaunchAgents/com.iris.wardrobe-backup.plist` after unloading it. The helper retains the plist if registration fails; inspect the session/job before retrying.

Use `status` for a 48-hour stale-backup check or connect its exit status to monitoring. Errors are logged; no email/push alerts are configured. Keep the separate key copy and repeat restore drills periodically. Linux can run the same `run-due` command through its native scheduler; no Vercel cron or public backup endpoint is needed.
