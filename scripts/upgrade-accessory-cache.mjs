import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { atomicJson, acceptedFilename, readManifest } from './outfit-storage.mjs';
import { withStorage } from './storage-fs.mjs';
import { skillStorage } from './skill-storage.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Upgrade only the identity hint: the portable hash and every existing styling
// field remain unchanged. No provider is used, including for invalid entries.
export async function upgradeAccessoryCache({ dataDir, store, apply = false } = {}) {
  if (!dataDir || typeof store?.imageIdentity !== 'function' || typeof store?.withLease !== 'function' || typeof store?.assertLease !== 'function') {
    throw new Error('Accessory identity upgrades require cloud storage with a fenced writer lease.');
  }
  const run = () => withStorage(store, async () => {
    if (apply) await store.assertLease();
    const cachePath = path.join(dataDir, 'outfit-accessories.json');
    let cache;
    try { cache = JSON.parse(await store.readFile(cachePath, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return { apply, entries: 0, candidates: 0, alreadyCurrent: 0, skipped: 0, mismatchedHash: 0, estimatedOriginalBytes: 0, imageReads: 0, imageBytesRead: 0, upgraded: 0 };
      throw new Error('Could not read outfit-accessories.json; preserve the file and repair it before upgrading.');
    }
    if (!object(cache) || cache.version !== 1 || !object(cache.outfits)) throw new Error('Unsupported outfit-accessories.json structure; the file has not been changed.');
    const manifest = await readManifest(dataDir);
    const accepted = new Map(manifest.outfits.filter(item => item.status === 'accepted').map(item => [item.id, item]));
    const candidates = [];
    const sources = new Map();
    const result = { apply, entries: Object.keys(cache.outfits).length, candidates: 0, alreadyCurrent: 0, skipped: 0, mismatchedHash: 0, estimatedOriginalBytes: 0, imageReads: 0, imageBytesRead: 0, upgraded: 0 };
    let imageRoot;
    for (const [id, saved] of Object.entries(cache.outfits)) {
      const filename = acceptedFilename(accepted.get(id)?.image);
      if (!filename || !object(saved) || !/^[a-f0-9]{64}$/.test(saved.imageHash || '')) { result.skipped++; continue; }
      let file, identity, size;
      try {
        imageRoot ??= await store.realpath(path.join(dataDir, 'outfit-images'));
        file = await store.realpath(path.join(dataDir, 'outfit-images', filename));
        const metadata = await store.stat(file);
        if (!file.startsWith(`${imageRoot}${path.sep}`) || !metadata.isFile()) throw new Error('Invalid image path');
        size = Number(metadata.size);
        if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid image size');
        identity = await store.imageIdentity(file);
        if (typeof identity !== 'string' || !identity) throw new Error('Missing immutable identity');
      } catch (error) {
        if (error.code === 'ENOENT' || error.status === 404 || error.message === 'Invalid image path') { result.skipped++; continue; }
        throw error;
      }
      if (saved.imageIdentity === identity) { result.alreadyCurrent++; continue; }
      candidates.push({ id, file, identity });
      sources.set(identity, size);
    }
    result.candidates = candidates.length;
    result.estimatedOriginalBytes = [...sources.values()].reduce((total, size) => total + size, 0);
    if (!apply || !candidates.length) return result;
    const hashes = new Map();
    for (const { id, file, identity } of candidates) {
      await store.assertLease();
      if (identity !== await store.imageIdentity(file)) throw new Error('An outfit image changed during the upgrade; the cache has not been changed.');
      if (!hashes.has(identity)) {
        const bytes = await store.readFile(file);
        result.imageReads++;
        result.imageBytesRead += bytes.length;
        hashes.set(identity, createHash('sha256').update(bytes).digest('hex'));
      }
      if (identity !== await store.imageIdentity(file)) throw new Error('An outfit image changed during the upgrade; the cache has not been changed.');
      if (hashes.get(identity) !== cache.outfits[id].imageHash) { result.mismatchedHash++; continue; }
      cache.outfits[id].imageIdentity = identity;
      result.upgraded++;
    }
    if (result.upgraded) {
      await store.assertLease();
      await atomicJson(cachePath, cache);
    }
    return result;
  });
  return apply ? store.withLease(run) : run();
}

export function parseAccessoryUpgradeArgs(args) {
  const options = { apply: false };
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--apply') options.apply = true;
    else if (args[index] === '--target' && args[index + 1] === 'cloud') { options.target = 'cloud'; index++; }
    else throw new Error('Usage: node scripts/upgrade-accessory-cache.mjs --target cloud [--apply]');
  }
  if (options.target !== 'cloud') throw new Error('Select --target cloud explicitly; dry-run is the default.');
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const options = parseAccessoryUpgradeArgs(process.argv.slice(2));
    const selected = await skillStorage(options);
    console.log(JSON.stringify(await upgradeAccessoryCache({ ...selected, apply: options.apply }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
