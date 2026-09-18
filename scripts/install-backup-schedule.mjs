import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

export const BACKUP_AGENT_LABEL = 'com.iris.wardrobe-backup';
export const SCHEDULE_USAGE = `Prepare or install daily Wardrobe backups on an always-on Mac.

Usage:
  node scripts/install-backup-schedule.mjs --project DIRECTORY --env-file FILE --repo DIRECTORY --key-file FILE --out FILE
  node scripts/install-backup-schedule.mjs --project DIRECTORY --env-file FILE --repo DIRECTORY --key-file FILE --install

--out FILE     Write a new reviewable LaunchAgent plist; no schedule is enabled.
--install      Install and enable a user LaunchAgent on this Mac (macOS only).
--node FILE    Optional absolute Node 22+ executable; defaults to this Node runtime.
--help, -h     Show this help without reading credentials or changing any files.

The agent checks hourly and at login; run-due backs up only when 24 hours have
elapsed. The Mac account must be logged in. Credentials and encryption keys
remain in their separate files; their contents are never embedded in the plist.
Existing output files or schedules are never overwritten.
`;
const runFile = promisify(execFile);
const escapeXml = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const absolutePath = (value, label) => {
  if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`${label} must be a valid filesystem path.`);
  return path.resolve(value);
};

export function renderLaunchAgent({ project, envFile, repo, keyFile, node = process.execPath, logDirectory = `${repo}.logs` }) {
  const paths = { project, envFile, repo, keyFile, node, logDirectory };
  for (const [label, value] of Object.entries(paths)) {
    if (typeof value !== 'string' || !path.isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`${label} must be an absolute path.`);
  }
  const args = [node, `--env-file=${envFile}`, path.join(project, 'scripts', 'wardrobe-backup.mjs'),
    'run-due', '--repo', repo, '--key-file', keyFile];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${BACKUP_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map(arg => `    <string>${escapeXml(arg)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key><string>${escapeXml(project)}</string>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>3600</integer>
  <key>ProcessType</key><string>Background</string>
  <key>Umask</key><integer>63</integer>
  <key>StandardOutPath</key><string>${escapeXml(path.join(logDirectory, 'backup.log'))}</string>
  <key>StandardErrorPath</key><string>${escapeXml(path.join(logDirectory, 'backup-error.log'))}</string>
</dict>
</plist>
`;
}

export function parseScheduleArgs(args) {
  if (args.includes('--help') || args.includes('-h')) return { help: true };
  const result = {};
  const names = { '--project': 'project', '--env-file': 'envFile', '--repo': 'repo', '--key-file': 'keyFile', '--out': 'out', '--node': 'node' };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--install') {
      if (result.install) throw new Error('Duplicate --install argument.');
      result.install = true;
      continue;
    }
    if (!names[arg]) throw new Error(`Unknown schedule argument: ${arg}`);
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}.`);
    if (Object.hasOwn(result, names[arg])) throw new Error(`Duplicate ${arg} argument.`);
    result[names[arg]] = value;
  }
  for (const name of ['project', 'envFile', 'repo', 'keyFile']) {
    if (!result[name]) throw new Error('--project, --env-file, --repo and --key-file are required.');
  }
  if (Boolean(result.out) === Boolean(result.install)) throw new Error('Choose --out FILE to prepare a schedule, or --install to enable it on this Mac.');
  return result;
}

async function requirePath(file, kind, label) {
  let info;
  try { info = await fs.stat(file); }
  catch (error) { if (error.code === 'ENOENT') throw new Error(`${label} does not exist: ${file}`); throw error; }
  if (!(kind === 'directory' ? info.isDirectory() : info.isFile())) throw new Error(`${label} must be a ${kind}: ${file}`);
}

// Preparing a plist never registers a job. --install is the only path that
// invokes launchctl, and is intended to be run on the chosen always-on Mac.
export async function createBackupSchedule(options, {
  platform = process.platform, home = os.homedir(), uid = process.getuid?.(), run = runFile,
} = {}) {
  if (Boolean(options.out) === Boolean(options.install)) throw new Error('Choose either --out FILE or --install.');
  if (options.install && platform !== 'darwin') throw new Error('Schedule installation requires macOS. Use --out to prepare a plist.');
  if (options.install && (!Number.isSafeInteger(uid) || uid <= 0)) throw new Error('Install this user LaunchAgent from the signed-in Mac account, without sudo.');
  const resolved = {};
  for (const name of ['project', 'envFile', 'repo', 'keyFile']) resolved[name] = absolutePath(options[name], name);
  resolved.node = absolutePath(options.node || process.execPath, 'node');
  resolved.logDirectory = `${resolved.repo}.logs`;
  await requirePath(resolved.project, 'directory', 'Project checkout');
  await requirePath(path.join(resolved.project, 'scripts', 'wardrobe-backup.mjs'), 'file', 'Backup command');
  await requirePath(resolved.repo, 'directory', 'Backup repository');
  await requirePath(resolved.envFile, 'file', 'Cloud credentials file');
  await requirePath(resolved.keyFile, 'file', 'Backup encryption key');
  await requirePath(resolved.node, 'file', 'Node executable');
  await fs.access(resolved.node, constants.X_OK);
  const version = await run(resolved.node, ['--version'], { timeout: 10_000, encoding: 'utf8' });
  const major = Number(version.stdout.trim().match(/^v(\d+)\./)?.[1]);
  if (!Number.isSafeInteger(major) || major < 22) throw new Error('The backup schedule requires Node 22 or newer. Set --node to its absolute executable path.');
  const out = options.install ? path.join(absolutePath(home, 'home'), 'Library', 'LaunchAgents', `${BACKUP_AGENT_LABEL}.plist`) : absolutePath(options.out, 'out');
  if (options.install) await fs.mkdir(path.dirname(out), { recursive: true, mode: 0o700 });
  else await requirePath(path.dirname(out), 'directory', 'Plist output directory');
  // Refuse existing schedules and review files, including symlinks. An update
  // should be inspected and deliberately unloaded before replacement.
  const handle = await fs.open(out, 'wx', 0o600);
  try {
    await fs.mkdir(resolved.logDirectory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const logs = await fs.lstat(resolved.logDirectory);
    if (!logs.isDirectory() || logs.isSymbolicLink() || (logs.mode & 0o077) !== 0) throw new Error('The backup log directory must be a private directory (permissions 700).');
    await handle.writeFile(renderLaunchAgent(resolved));
    await handle.sync();
  } catch (error) {
    await handle.close();
    await fs.rm(out);
    throw error;
  }
  await handle.close();
  if (options.install) {
    try { await run('/bin/launchctl', ['bootstrap', `gui/${uid}`, out], { timeout: 15_000, encoding: 'utf8' }); }
    catch (error) {
      // Keep the generated plist reviewable; never claim a failed bootstrap was
      // installed. Its existence also prevents accidental duplicate replacement.
      throw new Error(`The plist was saved at ${out}, but launchctl did not confirm installation. Inspect the Mac's user session and the existing job before retrying.`, { cause: error });
    }
  }
  return { installed: Boolean(options.install), plist: out, logDirectory: resolved.logDirectory,
    intervalSeconds: 3600, backupIntervalHours: 24, node: resolved.node };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const options = parseScheduleArgs(process.argv.slice(2));
    console.log(options.help ? SCHEDULE_USAGE : JSON.stringify(await createBackupSchedule(options), null, 2));
  }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
