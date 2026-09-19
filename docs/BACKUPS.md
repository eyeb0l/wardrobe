# Encrypted cloud backups and recovery

The cloud wardrobe is authoritative. These commands keep independent, dated recovery points outside the repository and outside the working `data/` directory. They never call an image-generation API. A backup contains the actual image bytes, so cloud garbage collection cannot make an existing backup unusable.

## What is included

The export captures all persistent files in the cloud store: wardrobe records (including edits and hidden-item tombstones), original and modeled images, outfit collections, references, prompts, import/outfit jobs and their source images, task history, and the daily dispatch counter. Transient dotfiles, locks, interrupted `.tmp` files and garbage-collection progress are excluded. Display WebP caches and provider workflow executions are not backed up; WebP images regenerate from originals.

Files and snapshot manifests use authenticated AES-256-GCM encryption. Image objects are stored once by checksum, shared across snapshots. Repeated exports identify immutable cloud images and reuse their locally verified encrypted bytes without downloading them again. A failed or interrupted export never publishes its snapshot manifest; previously completed backups remain usable.

Export holds the same renewable writer lease as editing, generation and cleanup. Reads remain available; writes can temporarily report busy, especially during the first full download. If another operation owns the lease, backup fails and the scheduler retries later. No database migration or website deployment is required for these tools.

## Initialize and take a backup

Use Node 22 or newer with the project's installed dependencies. Run from a stable project checkout. Keep a private credentials file containing the production `DATABASE_URL` and `BLOB_READ_WRITE_TOKEN`. No OpenAI key is needed. The Blob token can write/delete, so protect it like the existing production credentials; the exporter only reads image data and acquires/releases the database lease.

Create a private key directory, then initialize a **new** backup directory and key file:

```sh
mkdir -p "$HOME/Library/Application Support/Wardrobe Backup Keys"
chmod 700 "$HOME/Library/Application Support/Wardrobe Backup Keys"
node scripts/wardrobe-backup.mjs init \
  --repo "$HOME/Library/Application Support/Wardrobe Backups" \
  --key-file "$HOME/Library/Application Support/Wardrobe Backup Keys/primary.key"
```

The key file must remain outside the backup repository. Both paths' parent directories must already exist. Initialization refuses to overwrite either path. Save a separate secure copy of the key, such as in your password manager; **losing the key makes the backups unrecoverable**. Do not commit backups, restored data, credentials or keys. An encrypted external/off-device copy of the complete backup repository provides protection if the backup Mac is lost; keep the recovery key separate from that copy.

For subsequent commands, optional environment variables shorten the arguments:

```sh
export WARDROBE_BACKUP_DIR="$HOME/Library/Application Support/Wardrobe Backups"
export WARDROBE_BACKUP_KEY_FILE="$HOME/Library/Application Support/Wardrobe Backup Keys/primary.key"
node --env-file=.env.cloud scripts/wardrobe-backup.mjs export
node scripts/wardrobe-backup.mjs verify
node scripts/wardrobe-backup.mjs list
node scripts/wardrobe-backup.mjs status
```

`verify` authenticates the manifest, decrypts every referenced object and checks its size and SHA-256. `status` verifies the latest snapshot and exits 2 if no completed backup exists or it is over 48 hours old. Errors exit 1. Success exits 0. `--snapshot ID` selects a particular recovery point for verify or restore; the default is the latest.

Do not edit the encrypted repository by hand. Copy the entire repository while no backup operation is running. A `.lock` directory prevents simultaneous backup/restore/prune commands. After a crash, inspect `.lock/owner.json`, confirm the recorded process and every backup process have stopped, then remove only that stale lock. Locks are never automatically stolen.

## Restore locally first

```sh
node scripts/wardrobe-backup.mjs restore \
  --snapshot SNAPSHOT_ID --out "$HOME/Wardrobe Recovery Test"
```

The output directory must not exist, must be outside a Git checkout, and must not be inside the backup repository. All files are verified before restoration and read back afterward. `.restore-complete.json` marks a successful restore; an incomplete directory must not be used as a recovered wardrobe.

Backup contents remain exact. The separate restored copy pauses unfinished generation, removes dispatch authorization, and retains terminal task records. Opening that copy cannot automatically restart paid work. Approved images and completed outcomes are preserved. A later explicit retry is a new paid request. The restore result reports how many jobs were paused.

Inspect with a separate local server, pointing `WARDROBE_DATA_DIR` and `WARDROBE_MODEL_REFERENCE` to that recovered directory. Keep the original backup unchanged. For a recovery drill, use a checkout without development secrets and leave `OPENAI_API_KEY` empty. The app can perform normal housekeeping on its working recovery copy.

## Restore to cloud

Cloud recovery is an explicit full replacement, not a merge. First restore locally and inspect the recovered data. Stop active generation before attempting replacement.

```sh
# Verify backup bytes and show the current destination fingerprint; no content writes.
node --env-file=.env.cloud scripts/wardrobe-backup.mjs restore \
  --target cloud --snapshot SNAPSHOT_ID

# Use the fingerprint returned by the reviewed dry run.
node --env-file=.env.cloud scripts/wardrobe-backup.mjs restore \
  --target cloud --snapshot SNAPSHOT_ID --apply --replace \
  --expect-destination FINGERPRINT_FROM_DRY_RUN
```

Changing cloud data invalidates the fingerprint and requires a new dry run. The command first creates a complete safety backup of the current destination; if that fails, replacement does not begin. Binary files upload under new private immutable Blob URLs. All file metadata then switches in one fenced database transaction, so readers cannot observe a partly replaced manifest. Failed uploads/publication leave the old metadata intact; unpublished uploads become eligible for normal garbage collection.

The current day's higher dispatch count is retained. Existing task IDs are preserved as terminal records so delayed old workflow deliveries cannot restart generation. The restore does not copy old writer leases, garbage-collection decisions or cached WebP URLs. Old unreferenced cloud objects remain subject to the normal seven-day cleanup grace period.

A new cloud destination must already have the standard application schema initialized. It still requires a reviewed fingerprint and `--apply`; `--replace` is only necessary when files already exist. The command does not create providers, databases or credentials.

## Daily backups on the always-on Mac

Do not install a schedule on the temporary verification Mac. On the always-on Mac, put a stable checkout, dependencies, credentials and backup key in private locations. Either initialize a new backup repository/key there or securely transfer the complete encrypted repository **and separately transfer its key**. Use the same paths consistently; do not schedule a temporary Codex worktree.

The portable scheduler entry point is:

```sh
node --env-file=/absolute/path/to/private/cloud.env \
  /absolute/path/to/wardrobe/scripts/wardrobe-backup.mjs run-due \
  --repo /absolute/path/to/backups --key-file /absolute/path/to/backup.key
```

It verifies and skips when the newest successful backup is less than 24 hours old. Otherwise it exports, verifies, and applies retention. An hourly scheduler therefore retries busy/offline/failed runs without making hourly snapshots. `run` always performs this full sequence immediately. Backups retain the latest snapshot from 7 distinct days, 4 distinct weeks and 6 distinct months, taking the union of those sets. This preserves older recovery points across long outages. No pruning happens after an export failure. Standalone `prune` previews removals; `prune --apply` authenticates and verifies every snapshot before removing anything. Objects still used by retained snapshots survive.

On the always-on Mac, generate a reviewable LaunchAgent first:

```sh
node scripts/install-backup-schedule.mjs \
  --project /absolute/path/to/wardrobe \
  --env-file /absolute/path/to/private/cloud.env \
  --repo /absolute/path/to/backups --key-file /absolute/path/to/backup.key \
  --out "$HOME/wardrobe-backup.plist"
plutil -lint "$HOME/wardrobe-backup.plist"
```

After reviewing it and completing the first recovery drill, repeat the helper with `--install` in place of `--out ...`, on the always-on Mac only. Use `--node /absolute/path/to/node` if the current Node executable is not in a permanent location. Check the registered job with `launchctl print "gui/$(id -u)/com.iris.wardrobe-backup"`; to disable it, use `launchctl bootout "gui/$(id -u)/com.iris.wardrobe-backup"`. The installed plist remains in `~/Library/LaunchAgents` until deliberately removed.

The agent runs at login and hourly, uses absolute paths, and stores counts/errors in private log files. Generation alone does not enable the job; installation is a separate explicit action. This is a per-user agent: the backup user must remain logged in, and the Mac needs power/network access. Run a first backup and recovery drill on that host before relying on it.

Use `status` for a 48-hour stale-backup health check, or connect its exit status to your monitoring. A failed job is recorded in its error log; no email/push alert is configured automatically. Preserve a separate copy of the encryption key and periodically repeat a local restore drill.

The same `run-due` entry point can later run on a Linux VM using its native scheduler; no Vercel cron or publicly accessible backup endpoint is needed.
