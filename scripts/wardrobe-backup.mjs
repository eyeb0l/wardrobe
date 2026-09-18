import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCloudStore } from './cloud-store.mjs';
import { initBackup, openBackup, withBackupLock, exportBackup, verifyBackup, listSnapshots, restoreLocal, restoreCloud, backupStatus, pruneBackups } from './backup-core.mjs';

export function parseBackupArgs(args) {
  const [command, ...rest] = args;
  if (!['init', 'export', 'verify', 'list', 'status', 'restore', 'prune', 'run', 'run-due'].includes(command)) throw new Error('Usage: wardrobe-backup.mjs init|export|verify|list|status|restore|prune|run|run-due --repo DIRECTORY --key-file FILE');
  const result = { command };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (['--apply','--replace'].includes(arg)) { if (result[arg.slice(2)] !== undefined) throw new Error(`Duplicate option: ${arg}`); result[arg.slice(2)] = true; continue; }
    if (!['--repo','--key-file','--snapshot','--out','--target','--expect-destination'].includes(arg)) throw new Error(`Unknown argument: ${arg}`);
    const value = rest[++i], key = arg.slice(2).replace(/-([a-z])/g, (_,c) => c.toUpperCase());
    if (!value || value.startsWith('--') || result[key] !== undefined) throw new Error(`Invalid or duplicate ${arg}`);
    result[key] = value;
  }
  result.repo ||= process.env.WARDROBE_BACKUP_DIR;
  result.keyFile ||= process.env.WARDROBE_BACKUP_KEY_FILE;
  if (!result.repo || !result.keyFile) throw new Error('--repo and --key-file (or WARDROBE_BACKUP_DIR and WARDROBE_BACKUP_KEY_FILE) are required.');
  const allowed = { init: [], export: [], run: [], 'run-due': [], verify: ['snapshot'], list: [], status: [], prune: ['apply'], restore: ['snapshot','out','target','apply','replace','expectDestination'] };
  for (const key of Object.keys(result)) if (!['command','repo','keyFile',...allowed[command]].includes(key)) throw new Error(`${key} is not valid for ${command}.`);
  if (command === 'restore') {
    result.target ||= 'local';
    if (!['local','cloud'].includes(result.target)) throw new Error('--target must be local or cloud.');
    if (result.target === 'local' && (result.apply || result.replace || result.expectDestination)) throw new Error('Local restore only supports a new --out directory.');
    if (result.target === 'cloud' && result.out) throw new Error('--out is only for local restore.');
    if (result.replace && !result.apply) throw new Error('--replace requires --apply.');
  }
  return result;
}
function cloudStore() {
  if (!process.env.DATABASE_URL || !process.env.BLOB_READ_WRITE_TOKEN) throw new Error('Cloud access requires DATABASE_URL and BLOB_READ_WRITE_TOKEN. No OpenAI key is needed.');
  return createCloudStore();
}
export async function runBackup(args) {
  const options = parseBackupArgs(args);
  if (options.command === 'init') return initBackup(options);
  const repo = await openBackup(options);
  return withBackupLock(repo, async () => {
    switch (options.command) {
      case 'export': return exportBackup(repo, cloudStore());
      case 'verify': return verifyBackup(repo, options.snapshot);
      case 'list': return { snapshots: await listSnapshots(repo) };
      case 'status': return backupStatus(repo);
      case 'restore': return options.target === 'cloud' ? restoreCloud(repo, cloudStore(), options) : restoreLocal(repo, options);
      case 'prune': return pruneBackups(repo, options);
      case 'run-due':
      case 'run': {
        if (options.command === 'run-due') {
          const status = await backupStatus(repo);
          if (status.healthy && status.ageHours < 24) return { skipped: true, reason: 'A verified backup is less than 24 hours old.', ...status };
        }
        // Portable scheduler entrypoint. Retention only follows a successful export
        // and full verification; failure leaves existing recovery points intact.
        const backup = await exportBackup(repo, cloudStore());
        const verified = await verifyBackup(repo, backup.snapshot);
        const retention = await pruneBackups(repo, { apply: true });
        return { backup, verified, retention };
      }
    }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.umask(0o077);
  try {
    const result = await runBackup(process.argv.slice(2));
    console.log(JSON.stringify(result, null, 2));
    if (result.healthy === false) process.exitCode = 2;
  } catch (error) {
    // Provider errors can contain connection strings or tokens. Only expose
    // known local errors, never raw HTTP responses or provider diagnostics.
    const message = String(error.message || 'Backup failed');
    console.error(/(?:postgres(?:ql)?:\/\/|https?:\/\/|token|password)/i.test(message)
      ? 'Backup failed while accessing protected data. Credentials and provider details were omitted.' : message);
    process.exitCode = 1;
  }
}
