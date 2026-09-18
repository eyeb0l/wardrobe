import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BACKUP_AGENT_LABEL, createBackupSchedule, parseScheduleArgs, renderLaunchAgent } from './install-backup-schedule.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wardrobe-schedule-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'Project & Wardrobe');
  const repo = path.join(root, 'Encrypted Backups');
  const envFile = path.join(root, 'Cloud & Secrets.env');
  const keyFile = path.join(root, 'private key.txt');
  const node = path.join(root, 'Node Runtime');
  const out = path.join(root, 'review.plist');
  await mkdir(path.join(project, 'scripts'), { recursive: true });
  await mkdir(repo);
  await writeFile(path.join(project, 'scripts', 'wardrobe-backup.mjs'), '// fixture\n');
  await writeFile(envFile, 'DATABASE_URL=secret-value-that-must-not-appear\n', { mode: 0o600 });
  await writeFile(keyFile, 'secret-encryption-key-that-must-not-appear\n', { mode: 0o600 });
  await writeFile(node, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  const calls = [];
  const run = async (file, args, options) => { calls.push({ file, args, options }); return { stdout: 'v22.19.0\n' }; };
  return { root, options: { project, repo, envFile, keyFile, node, out }, calls, run };
}

const options = {
  project: '/Users/Iris/Wardrobe & "Personal"', envFile: '/Users/Iris/keys/cloud <private>.env',
  repo: '/Users/Iris/Backups/Wardrobe', keyFile: "/Users/Iris/keys/owner's key", node: '/opt/homebrew/bin/node',
};

test('LaunchAgent uses argument arrays, escaped paths, private logs, and hourly daily-due checks', () => {
  const plist = renderLaunchAgent(options);
  assert.match(plist, /<string>\/Users\/Iris\/Wardrobe &amp; &quot;Personal&quot;\/scripts\/wardrobe-backup\.mjs<\/string>/);
  assert.match(plist, /<string>--env-file=\/Users\/Iris\/keys\/cloud &lt;private&gt;\.env<\/string>/);
  assert.match(plist, /<string>\/Users\/Iris\/keys\/owner&apos;s key<\/string>/);
  assert.match(plist, /<string>run-due<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist, /<key>StartInterval<\/key><integer>3600<\/integer>/);
  assert.match(plist, /<key>Umask<\/key><integer>63<\/integer>/);
  assert.match(plist, /Wardrobe\.logs\/backup-error\.log/);
  assert.doesNotMatch(plist, /EnvironmentVariables|\/bin\/sh|bash/);
  assert.throws(() => renderLaunchAgent({ ...options, project: 'relative' }), /absolute path/);
  assert.throws(() => renderLaunchAgent({ ...options, envFile: '/private/bad\npath' }), /absolute path/);
});

test('argument parsing requires a deliberate choice between review and installation', () => {
  const common = ['--project', '/project', '--repo', '/repo', '--env-file', '/env', '--key-file', '/key'];
  assert.deepEqual(parseScheduleArgs([...common, '--out', '/review']), { project: '/project', repo: '/repo', envFile: '/env', keyFile: '/key', out: '/review' });
  assert.equal(parseScheduleArgs([...common, '--install']).install, true);
  assert.throws(() => parseScheduleArgs(common), /Choose --out/);
  assert.throws(() => parseScheduleArgs([...common, '--install', '--out', '/review']), /Choose --out/);
  assert.throws(() => parseScheduleArgs(['--out', '/review']), /are required/);
  assert.throws(() => parseScheduleArgs([...common, '--out']), /Missing value/);
  assert.throws(() => parseScheduleArgs([...common, '--install', '--install']), /Duplicate/);
  assert.throws(() => parseScheduleArgs([...common, '--out', '/review', '--repo', '/other']), /Duplicate/);
  assert.throws(() => parseScheduleArgs([...common, '--unknown']), /Unknown/);
});

test('default preparation writes a new private review file without any launchctl call or embedded secrets', async t => {
  const h = await fixture(t);
  const home = path.join(h.root, 'test home');
  const result = await createBackupSchedule(h.options, { run: h.run, home, platform: 'darwin', uid: 501 });
  assert.equal(result.installed, false);
  assert.equal(result.plist, h.options.out);
  assert.deepEqual(h.calls.map(call => [call.file, call.args]), [[h.options.node, ['--version']]]);
  await assert.rejects(access(path.join(home, 'Library', 'LaunchAgents')), { code: 'ENOENT' });
  const plist = await readFile(h.options.out, 'utf8');
  assert.doesNotMatch(plist, /secret-value-that-must-not-appear|secret-encryption-key-that-must-not-appear/);
  assert.match(plist, /Project &amp; Wardrobe/);
  assert.equal((await stat(h.options.out)).mode & 0o777, 0o600);
  assert.equal((await stat(result.logDirectory)).mode & 0o777, 0o700);
});

test('explicit installation creates a user LaunchAgent and bootstraps exactly that path', async t => {
  const h = await fixture(t);
  const { out, ...settings } = h.options;
  const home = path.join(h.root, 'fake home');
  const result = await createBackupSchedule({ ...settings, install: true }, { run: h.run, home, platform: 'darwin', uid: 501 });
  const expected = path.join(home, 'Library', 'LaunchAgents', `${BACKUP_AGENT_LABEL}.plist`);
  assert.equal(result.installed, true);
  assert.equal(result.plist, expected);
  assert.deepEqual(h.calls.at(-1).args, ['bootstrap', 'gui/501', expected]);
  assert.equal(h.calls.at(-1).file, '/bin/launchctl');
  await assert.rejects(access(out), { code: 'ENOENT' });
});

test('preparation requires all inputs and Node 22+, and never overwrites an existing schedule', async t => {
  const h = await fixture(t);
  for (const field of ['project', 'repo', 'envFile', 'keyFile', 'node']) {
    await assert.rejects(createBackupSchedule({ ...h.options, [field]: path.join(h.root, 'missing') }, { run: h.run }), /does not exist/);
  }
  await assert.rejects(createBackupSchedule(h.options, { run: async () => ({ stdout: 'v20.19.0\n' }) }), /Node 22 or newer/);
  await assert.rejects(access(h.options.out), { code: 'ENOENT' });
  await rm(path.join(h.options.project, 'scripts', 'wardrobe-backup.mjs'));
  await assert.rejects(createBackupSchedule(h.options, { run: h.run }), /Backup command does not exist/);
  await writeFile(path.join(h.options.project, 'scripts', 'wardrobe-backup.mjs'), '// fixture');
  await writeFile(h.options.out, 'existing schedule');
  await assert.rejects(createBackupSchedule(h.options, { run: h.run }), { code: 'EEXIST' });
  assert.equal(await readFile(h.options.out, 'utf8'), 'existing schedule');
});

test('installation rejects non-macOS/root and reports bootstrap failure without claiming success', async t => {
  const h = await fixture(t);
  const { out, ...settings } = h.options;
  const home = path.join(h.root, 'fake home');
  await assert.rejects(createBackupSchedule({ ...settings, install: true }, { run: h.run, platform: 'linux', home, uid: 501 }), /requires macOS/);
  await assert.rejects(createBackupSchedule({ ...settings, install: true }, { run: h.run, platform: 'darwin', home, uid: 0 }), /without sudo/);
  assert.equal(h.calls.length, 0);
  await assert.rejects(createBackupSchedule({ ...settings, install: true }, { platform: 'darwin', home, uid: 501,
    run: async (file, args, options) => {
      if (file === '/bin/launchctl') throw new Error('No GUI session');
      return h.run(file, args, options);
    },
  }), /did not confirm installation/);
  assert.match(await readFile(path.join(home, 'Library', 'LaunchAgents', `${BACKUP_AGENT_LABEL}.plist`), 'utf8'), /<plist/);
});
