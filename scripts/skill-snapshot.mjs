import * as local from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { skillStorage, parseSkillArgs } from './skill-storage.mjs';
import { withStorage } from './storage-fs.mjs';
import { readManifest } from './outfit-storage.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

// A task snapshot, not a backup: owned cutouts, reference originals and saved
// outfit metadata only. Jobs, credentials and generated display copies stay out.
export async function snapshotForSkill({ target, dataDir, store, reference, out }) {
  if (!out) throw new Error('--out must name a new directory outside the live data directory.');
  const output = path.resolve(out);
  const parent = await local.realpath(path.dirname(output));
  const resolvedOutput = path.join(parent, path.basename(output));
  const sourceRoot = target === 'local' ? await local.realpath(dataDir) : dataDir;
  if (resolvedOutput === sourceRoot || resolvedOutput.startsWith(sourceRoot + path.sep)) throw new Error('Keep task snapshots outside the live data directory.');
  // Read and validate the authoritative metadata before creating the output.
  const libraryPath = path.join(dataDir, 'library.json');
  const libraryBytes = await store.readFile(libraryPath);
  const records = JSON.parse(libraryBytes);
  if (!Array.isArray(records)) throw new Error('The saved library must be an array.');
  const library = records.filter(item => !item.hidden);
  const outfits = await withStorage(store, () => readManifest(dataDir));
  const files = new Map();
  for (const item of library) {
    const filename = typeof item.image === 'string' && item.image.match(/^\/api\/import\/library\/([\w.-]+\.(?:png|jpe?g|webp))$/i)?.[1];
    if (!filename) throw new Error(`Unsupported image path for wardrobe item ${item.id}; inspect the live record instead of guessing a local path.`);
    files.set(`imported/${filename}`, path.join(dataDir, 'imported', filename));
  }
  const references = [];
  const defaultReference = reference || path.join(dataDir, 'model-reference.png');
  try { await store.stat(defaultReference); references.push({ id: 'default', file: 'model-reference.png', source: defaultReference }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const name of await store.readdir(dataDir)) {
    const match = name.match(/^model-reference-([1-9]\d*)\.png$/);
    if (match && Number(match[1]) >= 2) references.push({ id: `model-reference-${match[1]}`, file: name, source: path.join(dataDir, name) });
  }
  for (const ref of references) files.set(ref.file, ref.source);
  await local.mkdir(resolvedOutput, { mode: 0o700 }); // Existing output is never overwritten.
  await local.mkdir(path.join(resolvedOutput, 'imported'), { mode: 0o700 });
  const fingerprints = [];
  for (const [name, source] of files) {
    if (target === 'local' && name.startsWith('imported/')) {
      const real = await local.realpath(source);
      if (!real.startsWith(sourceRoot + path.sep)) throw new Error(`Wardrobe image escapes its data directory: ${name}`);
    }
    const before = await store.stat(source);
    const bytes = await store.readFile(source);
    const after = await store.stat(source);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('Wardrobe changed during snapshot; retry into a fresh directory.');
    await local.writeFile(path.join(resolvedOutput, name), bytes, { flag: 'wx', mode: 0o600 });
    fingerprints.push({ name, source, size: after.size, mtimeMs: after.mtimeMs, sha256: hash(bytes) });
  }
  // Recheck metadata and versions without taking or modifying the writer lease.
  if (!Buffer.from(libraryBytes).equals(Buffer.from(await store.readFile(libraryPath))) || JSON.stringify(outfits) !== JSON.stringify(await withStorage(store, () => readManifest(dataDir)))) throw new Error('Wardrobe metadata changed during snapshot; retry into a fresh directory.');
  for (const file of fingerprints) {
    const current = await store.stat(file.source);
    if (current.size !== file.size || current.mtimeMs !== file.mtimeMs) throw new Error('Wardrobe image changed during snapshot; retry into a fresh directory.');
  }
  await local.writeFile(path.join(resolvedOutput, 'library.json'), JSON.stringify(library, null, 2), { flag: 'wx', mode: 0o600 });
  await local.writeFile(path.join(resolvedOutput, 'outfits.json'), JSON.stringify(outfits, null, 2), { flag: 'wx', mode: 0o600 });
  const result = { target, capturedAt: new Date().toISOString(), directory: resolvedOutput, wardrobeCount: library.length,
    outfitCount: outfits.outfits.length, references: references.map(({ id, file }) => ({ id, file })),
    files: fingerprints.map(({ name, sha256 }) => ({ name, sha256 })) };
  // Written last: its presence identifies a completed, verified task snapshot.
  await local.writeFile(path.join(resolvedOutput, 'snapshot.json'), JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 });
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const options = parseSkillArgs(process.argv.slice(2));
    const selected = await skillStorage(options);
    const result = await snapshotForSkill({ ...selected, out: options.out });
    console.log(JSON.stringify({ ...result, files: result.files.length }, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
