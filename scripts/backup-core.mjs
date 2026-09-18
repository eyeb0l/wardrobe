import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto';
import { isBackupPath, prepareRestore } from './backup-recovery.mjs';

const VERSION = 1;
const MAGIC = Buffer.from('WRDB1');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => Buffer.from(JSON.stringify(value));
const fail = message => { throw new Error(message); };
const absent = async file => { try { await fs.lstat(file); return false; } catch (e) { if (e.code === 'ENOENT') return true; throw e; } };
const privateDir = async dir => { await fs.mkdir(dir, { recursive: true, mode: 0o700 }); const s = await fs.lstat(dir); if (!s.isDirectory() || s.isSymbolicLink()) fail('Backup directories must be real directories.'); };
const safeName = name => typeof name === 'string' && name.length > 0 && !name.includes('\\') && !/[\x00-\x1f]/.test(name) && !path.posix.isAbsolute(name) && name.split('/').every(p => p && p !== '.' && p !== '..');
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const validId = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T[\d-]+Z-[a-f0-9-]{36}$/.test(value);

async function readRegular(file) {
  const handle = await fs.open(file, (await import('node:fs')).constants.O_RDONLY | (await import('node:fs')).constants.O_NOFOLLOW);
  try { if (!(await handle.stat()).isFile()) fail('Expected a regular backup file.'); return await handle.readFile(); }
  finally { await handle.close(); }
}
function encrypt(key, bytes, aad) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const body = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
}
function decrypt(key, bytes, aad) {
  if (bytes.length < 33 || !bytes.subarray(0, 5).equals(MAGIC)) fail('Invalid encrypted backup file.');
  try {
    const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(5, 17));
    cipher.setAAD(Buffer.from(aad)); cipher.setAuthTag(bytes.subarray(17, 33));
    return Buffer.concat([cipher.update(bytes.subarray(33)), cipher.final()]);
  } catch { fail('Backup authentication failed: wrong key or damaged file.'); }
}
async function atomicWrite(file, bytes) {
  const temp = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temp, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  try { await fs.rename(temp, file); } catch (error) { await fs.rm(temp, { force: true }); throw error; }
}
async function checkOutsideGit(dir) {
  let current = await fs.realpath(path.dirname(path.resolve(dir)));
  for (;;) {
    if (!await absent(path.join(current, '.git'))) fail('Keep backups and recovery directories outside a Git checkout.');
    const parent = path.dirname(current); if (parent === current) return; current = parent;
  }
}
export async function initBackup({ repo, keyFile }) {
  repo = path.resolve(repo); keyFile = path.resolve(keyFile);
  if (keyFile === repo || keyFile.startsWith(repo + path.sep)) fail('Store the encryption key outside the backup repository.');
  await checkOutsideGit(repo); await checkOutsideGit(keyFile);
  if (!await absent(repo) || !await absent(keyFile)) fail('Initialization needs a new repository and a new key file.');
  await fs.mkdir(repo, { mode: 0o700 });
  const key = randomBytes(32), id = randomUUID();
  await fs.writeFile(keyFile, key.toString('base64') + '\n', { flag: 'wx', mode: 0o600 });
  await privateDir(path.join(repo, 'objects')); await privateDir(path.join(repo, 'snapshots'));
  await atomicWrite(path.join(repo, 'repository.json'), json({ version: VERSION, id }));
  await atomicWrite(path.join(repo, 'key-check'), encrypt(key, Buffer.from('wardrobe-backup'), `${id}:key-check`));
  return { repo, keyFile, encrypted: true };
}
export async function openBackup({ repo, keyFile }) {
  repo = path.resolve(repo);
  for (const dir of [repo, path.join(repo, 'objects'), path.join(repo, 'snapshots')]) {
    const s = await fs.lstat(dir); if (!s.isDirectory() || s.isSymbolicLink()) fail('Backup directories must not be symbolic links.');
  }
  const key = Buffer.from((await readRegular(keyFile)).toString().trim(), 'base64');
  if (key.length !== 32) fail('Invalid backup key.');
  const config = JSON.parse(await readRegular(path.join(repo, 'repository.json')));
  if (config.version !== VERSION || typeof config.id !== 'string') fail('Unsupported backup repository.');
  if (decrypt(key, await readRegular(path.join(repo, 'key-check')), `${config.id}:key-check`).toString() !== 'wardrobe-backup') fail('Invalid backup key check.');
  return { repo, key, id: config.id };
}
export async function withBackupLock(repository, callback) {
  const lock = path.join(repository.repo, '.lock');
  try { await fs.mkdir(lock, { mode: 0o700 }); }
  catch (e) { if (e.code === 'EEXIST') fail('Another backup operation owns .lock. If a previous process crashed, confirm it has stopped before removing this lock.'); throw e; }
  try { await fs.writeFile(path.join(lock, 'owner.json'), json({ pid: process.pid, startedAt: new Date().toISOString() }), { mode: 0o600 }); return await callback(); }
  finally { await fs.rm(lock, { recursive: true, force: true }); }
}
const objectFile = (repo, sha) => path.join(repo.repo, 'objects', `${sha}.bin`);
async function readObject(repo, sha, size) {
  if (!validHash(sha)) fail('Invalid object checksum.');
  const bytes = decrypt(repo.key, await readRegular(objectFile(repo, sha)), `${repo.id}:object:${sha}`);
  if (hash(bytes) !== sha || bytes.length !== size) fail('Backup object checksum or size mismatch.');
  return bytes;
}
async function putObject(repo, bytes) {
  const sha256 = hash(bytes), file = objectFile(repo, sha256);
  if (await absent(file)) await atomicWrite(file, encrypt(repo.key, bytes, `${repo.id}:object:${sha256}`));
  else await readObject(repo, sha256, bytes.length);
  return { sha256, size: bytes.length };
}
export async function listSnapshots(repo) {
  const names = await fs.readdir(path.join(repo.repo, 'snapshots'));
  return names.filter(n => n.endsWith('.bin')).map(n => n.slice(0, -4)).map(id => { if (!validId(id)) fail('Invalid snapshot filename.'); return id; }).sort();
}
export async function readSnapshot(repo, snapshot = 'latest') {
  const id = snapshot === 'latest' ? (await listSnapshots(repo)).at(-1) : snapshot;
  if (!validId(id)) fail('No valid snapshot was selected.');
  const manifest = JSON.parse(decrypt(repo.key, await readRegular(path.join(repo.repo, 'snapshots', `${id}.bin`)), `${repo.id}:snapshot:${id}`));
  validateManifest(manifest, id);
  return manifest;
}
function validateManifest(manifest, id) {
  if (manifest.version !== VERSION || manifest.id !== id || !Number.isFinite(Date.parse(manifest.capturedAt)) || !Array.isArray(manifest.files)) fail('Invalid backup manifest.');
  const names = new Set(), folded = new Set();
  for (const file of manifest.files) {
    if (!safeName(file.name) || !isBackupPath(file.name) || names.has(file.name) || folded.has(file.name.normalize('NFC').toLowerCase()) || !validHash(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 0 || (file.sourceId && !validHash(file.sourceId))) fail('Invalid or duplicate backup entry.');
    names.add(file.name); folded.add(file.name.normalize('NFC').toLowerCase());
  }
  for (const name of folded) { let parent = path.posix.dirname(name); while (parent !== '.') { if (folded.has(parent)) fail('Backup file conflicts with a directory.'); parent = path.posix.dirname(parent); } }
  if (!names.has('library.json')) fail('Backup has no wardrobe library.');
}
export async function verifyBackup(repo, snapshot = 'latest') {
  const manifest = await readSnapshot(repo, snapshot), seen = new Set();
  for (const file of manifest.files) { if (!seen.has(file.sha256)) await readObject(repo, file.sha256, file.size); seen.add(file.sha256); }
  return { snapshot: manifest.id, capturedAt: manifest.capturedAt, files: manifest.files.length, objects: seen.size, bytes: manifest.files.reduce((sum, f) => sum + f.size, 0) };
}
function inventoryEntries(rows) {
  return rows.filter(r => r.kind === 'file').map(row => {
    if (typeof row.path !== 'string' || !row.path.startsWith('/wardrobe-data/')) fail('Cloud inventory contains an invalid path.');
    const name = row.path.slice('/wardrobe-data/'.length);
    if (!safeName(name)) fail('Cloud inventory contains an unsafe path.');
    return { ...row, name };
  }).filter(row => isBackupPath(row.name));
}
export function destinationFingerprint(rows) {
  return hash(json([...rows].sort((a,b) => a.path.localeCompare(b.path)).map(r => [r.path, r.kind, r.text_content, r.blob_url, Number(r.size), String(r.updated_at)])));
}
export async function exportBackup(repo, store, { now = new Date() } = {}) {
  return store.withLease(() => exportUnderLease(repo, store, now));
}
async function exportUnderLease(repo, store, now) {
  const rows = await store.backupInventory(), entries = inventoryEntries(rows);
  if (!entries.some(r => r.name === 'library.json')) fail('Cloud has no library.json; refusing an empty backup.');
  const ids = await listSnapshots(repo), cached = new Map();
  if (ids.length) for (const f of (await readSnapshot(repo, ids.at(-1))).files) if (f.sourceId) cached.set(f.sourceId, f);
  const files = []; let downloadedFiles = 0, downloadedBytes = 0, reusedFiles = 0;
  for (const entry of entries) {
    let bytes, sourceId;
    if (entry.blob_url) {
      sourceId = hash(Buffer.from(entry.blob_url)); const prior = cached.get(sourceId);
      if (prior) { bytes = await readObject(repo, prior.sha256, prior.size); reusedFiles++; }
      else { bytes = await store.readBackupBlob(entry.blob_url); downloadedFiles++; downloadedBytes += bytes.length; }
    } else if (typeof entry.text_content === 'string') bytes = Buffer.from(entry.text_content);
    else fail('Cloud file has neither original bytes nor text.');
    if (bytes.length !== Number(entry.size)) fail(`Cloud file size mismatch: ${entry.name}`);
    const object = await putObject(repo, bytes);
    const file = { name: entry.name, ...object, ...(sourceId ? { sourceId } : {}) }; files.push(file);
    if (sourceId) cached.set(sourceId, file);
  }
  files.sort((a,b) => a.name.localeCompare(b.name));
  const id = `${now.toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
  const manifest = { version: VERSION, id, capturedAt: now.toISOString(), source: 'cloud', files };
  // Validate metadata and neutralization before accepting any recovery point.
  validateManifest(manifest, id);
  await prepareRestore(await materialize(repo, manifest));
  await store.assertLease();
  if (destinationFingerprint(rows) !== destinationFingerprint(await store.backupInventory())) fail('Cloud inventory changed during backup.');
  // The authenticated manifest is the only completion marker; it is written last.
  await atomicWrite(path.join(repo.repo, 'snapshots', `${id}.bin`), encrypt(repo.key, json(manifest), `${repo.id}:snapshot:${id}`));
  return { snapshot: id, files: files.length, downloadedFiles, downloadedBytes, reusedFiles, bytes: files.reduce((s,f) => s + f.size,0) };
}
async function materialize(repo, manifest) {
  const files = [];
  for (const file of manifest.files) files.push({ name: file.name, bytes: await readObject(repo, file.sha256, file.size) });
  return files;
}
export async function restoreLocal(repo, { snapshot = 'latest', out }) {
  if (!out) fail('A new --out directory is required.');
  out = path.resolve(out); await checkOutsideGit(out);
  const realParent = await fs.realpath(path.dirname(out)); out = path.join(realParent, path.basename(out));
  const realRepo = await fs.realpath(repo.repo);
  if (out === realRepo || out.startsWith(realRepo + path.sep)) fail('Keep restored data outside the backup repository.');
  if (!await absent(out)) fail('Restore refuses an existing destination.');
  const manifest = await readSnapshot(repo, snapshot), prepared = await prepareRestore(await materialize(repo, manifest));
  // mkdir with no recursive option reserves a new target, never an existing one.
  await fs.mkdir(out, { mode: 0o700 });
  try {
    for (const file of prepared.files) {
      if (!safeName(file.name)) fail('Unsafe restore path.');
      const target = path.join(out, file.name); await privateDir(path.dirname(target));
      await fs.writeFile(target, file.bytes, { flag: 'wx', mode: 0o600 });
      if (hash(await readRegular(target)) !== hash(file.bytes)) fail('Restored file verification failed.');
    }
    await fs.writeFile(path.join(out, '.restore-complete.json'), json({ snapshot: manifest.id, restoredAt: new Date().toISOString(), pausedJobs: prepared.pausedJobs }), { flag: 'wx', mode: 0o600 });
  } catch (error) { throw new Error(`Restore incomplete; do not use ${out}. ${error.message}`); }
  return { snapshot: manifest.id, directory: out, files: prepared.files.length, pausedJobs: prepared.pausedJobs };
}
export async function restoreCloud(repo, store, { snapshot = 'latest', apply = false, replace = false, expectDestination } = {}) {
  const manifest = await readSnapshot(repo, snapshot), files = await materialize(repo, manifest);
  return store.withLease(async () => {
    const rows = await store.backupInventory(), fingerprint = destinationFingerprint(rows);
    const existing = rows.filter(r => r.kind === 'file');
    const currentFiles = existing.filter(r => r.path === '/wardrobe-data/.api-usage.json' || /^\/wardrobe-data\/\.tasks\/[^/]+\.json$/.test(r.path)).map(r => ({ name: r.path.slice('/wardrobe-data/'.length), bytes: Buffer.from(r.text_content || '') }));
    const prepared = await prepareRestore(files, { currentFiles });
    const summary = { snapshot: manifest.id, destinationFingerprint: fingerprint, existingFiles: existing.length, restoreFiles: prepared.files.length, pausedJobs: prepared.pausedJobs, applied: false };
    if (!apply) return summary;
    if (expectDestination !== fingerprint) fail('Destination changed or was not reviewed. Run a fresh cloud restore dry run and pass its --expect-destination value.');
    if (existing.length && !replace) fail('Cloud destination is not empty. Explicit --replace is required.');
    // Refuse to modify a live destination until its own complete recovery point exists.
    const safety = existing.length ? await exportUnderLease(repo, store, new Date()) : null;
    await store.replaceFromBackup(prepared.files.map(f => ({ path: `/wardrobe-data/${f.name}`, bytes: f.bytes })));
    return { ...summary, applied: true, safetySnapshot: safety?.snapshot || null };
  });
}
export async function backupStatus(repo, { now = new Date(), maxAgeHours = 48 } = {}) {
  const ids = await listSnapshots(repo);
  if (!ids.length) return { healthy: false, reason: 'No completed backup', snapshots: 0 };
  const verified = await verifyBackup(repo, ids.at(-1));
  const ageHours = Math.max(0, (now - Date.parse(verified.capturedAt)) / 3_600_000);
  return { ...verified, snapshots: ids.length, ageHours: Math.round(ageHours * 10) / 10, healthy: ageHours <= maxAgeHours };
}
export async function pruneBackups(repo, { apply = false, now = new Date() } = {}) {
  const ids = await listSnapshots(repo), manifests = [];
  // Authenticate and verify ALL snapshots before deleting any recovery points.
  for (const id of ids) { await verifyBackup(repo, id); manifests.push(await readSnapshot(repo, id)); }
  const keep = new Set(ids.slice(-1)), buckets = [new Set(), new Set(), new Set()];
  for (const manifest of manifests.slice().reverse()) {
    const d = new Date(manifest.capturedAt);
    const day = d.toISOString().slice(0,10), week = Math.floor((d.getTime() / 86400000 + 3) / 7), month = day.slice(0,7);
    for (const [index, key, limit] of [[0,day,7],[1,week,4],[2,month,6]]) {
      if (buckets[index].size < limit && !buckets[index].has(key)) { buckets[index].add(key); keep.add(manifest.id); }
    }
  }
  const remove = ids.filter(id => !keep.has(id)), referenced = new Set(manifests.filter(m => keep.has(m.id)).flatMap(m => m.files.map(f => `${f.sha256}.bin`)));
  const objects = (await fs.readdir(path.join(repo.repo,'objects'))).filter(n => /^[a-f0-9]{64}\.bin$/.test(n) && !referenced.has(n));
  if (apply) {
    for (const id of remove) await fs.unlink(path.join(repo.repo, 'snapshots', `${id}.bin`));
    for (const name of objects) { await readRegular(path.join(repo.repo, 'objects', name)); await fs.unlink(path.join(repo.repo, 'objects', name)); }
  }
  return { applied: apply, retained: keep.size, removedSnapshots: remove.length, removedObjects: objects.length };
}
