import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { readFile, stat, currentStorage } from './storage-fs.mjs';
import { DISPLAY_WIDTHS, DISPLAY_RECIPE, requestedDisplayWidth } from '../shared/image-variants.mjs';

export const displayKey = (identity, width) => createHash('sha256').update(`${DISPLAY_RECIPE}:${width}:${identity}`).digest('hex');
export const displayETag = (key) => `"display-${key}"`;
export const matchesETag = (header, tag) => typeof header === 'string' && header.split(',').some(value => value.trim().replace(/^W\//, '') === tag || value.trim() === '*');

export async function encodeDisplayImage(bytes, width) {
  if (!DISPLAY_WIDTHS.includes(width)) throw Object.assign(new Error('Unsupported display image size'), { status: 400 });
  return sharp(bytes, { limitInputPixels: 64e6 }).rotate()
    .resize({ width, withoutEnlargement: true })
    .webp({ quality: 85, alphaQuality: 100, effort: 4, smartSubsample: true })
    .toBuffer();
}

const localVariants = new Map();
let localBytes = 0;
const MAX_LOCAL_BYTES = 32 * 1024 * 1024;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
// Local files are mutable, so a content hash is reused only while the file's
// identity, size and timestamps are unchanged; any replacement is rehashed.
const localHashes = new Map();
const MAX_LOCAL_HASHES = 4096;
const statKey = ({ ino, size, mtimeMs, ctimeMs }) => JSON.stringify([ino, size, mtimeMs, ctimeMs]);
// A version names the exact image a path holds right now, cheaply enough to
// send with every list read. A browser may keep a response for good only when
// the version in its URL is the one these bytes were served under.
const versionToken = (identity) => sha256(identity).slice(0, 20);
const localVersion = (key) => versionToken(`local:${key}`);
async function localContentHash(file) {
  const before = statKey(await stat(file));
  const cached = localHashes.get(file);
  if (cached?.stat === before) {
    localHashes.delete(file); localHashes.set(file, cached);
    return { hash: cached.hash, version: localVersion(before) };
  }
  const original = await readFile(file);
  const hash = sha256(original);
  // Never cache a hash for bytes that changed while they were being read.
  const settled = statKey(await stat(file)) === before;
  if (settled) {
    localHashes.delete(file); localHashes.set(file, { stat: before, hash });
    if (localHashes.size > MAX_LOCAL_HASHES) localHashes.delete(localHashes.keys().next().value);
  }
  return { hash, original, version: settled ? localVersion(before) : null };
}
async function localVariant(file, width, condition) {
  let { hash, original, version } = await localContentHash(file);
  let key = displayKey(hash, width);
  let etag = displayETag(key);
  if (matchesETag(condition, etag)) return { etag, version, notModified: true };
  let bytes = localVariants.get(key);
  if (!bytes) {
    if (!original) {
      original = await readFile(file);
      // A replacement after the cached lookup: key the variant by the bytes read.
      if (sha256(original) !== hash) {
        localHashes.delete(file);
        // These bytes no longer belong to the version that was looked up.
        version = null;
        hash = sha256(original); key = displayKey(hash, width); etag = displayETag(key);
        if (matchesETag(condition, etag)) return { etag, version, notModified: true };
      }
    }
    bytes = localVariants.get(key) ?? await encodeDisplayImage(original, width);
    if (!localVariants.has(key)) { localVariants.set(key, bytes); localBytes += bytes.length; }
    while (localBytes > MAX_LOCAL_BYTES && localVariants.size) {
      const first = localVariants.keys().next().value;
      localBytes -= localVariants.get(first).length;
      localVariants.delete(first);
    }
  }
  return { bytes, etag, version };
}

// Current versions for many images in one pass: a single metadata query when
// hosted, one stat per file locally. A file that cannot be examined is simply
// absent, so its image is asked for afresh and the image route reports why.
export async function displayVersions(files) {
  const store = currentStorage();
  if (store?.imageVersions) return store.imageVersions(files);
  const versions = new Map();
  await Promise.all([...new Set(files)].map(async (file) => {
    try {
      const stats = await stat(file);
      if (stats.isFile()) versions.set(file, localVersion(statKey(stats)));
    } catch { /* No version. */ }
  }));
  return versions;
}
export const hostedDisplayVersion = (blobUrl) => versionToken(`hosted:${blobUrl}`);

// Lists name each image's version next to its address, keyed by the field that
// holds the address. `fileFor` maps an address to its stored file, or null.
// Every listed record says which of its images exist, even when none do, so a
// browser stops trusting a kept copy of an image the store no longer has.
export async function withImageVersions(records, fields, fileFor) {
  // A repeated address (a thumbnail that is the image) is named once.
  const files = records.map((record) => fields.map((field, position) => typeof record[field] === 'string'
    && !fields.slice(0, position).some((earlier) => record[earlier] === record[field]) ? fileFor(record[field]) : null));
  const versions = await displayVersions(files.flat().filter(Boolean));
  return records.map((record, index) => {
    const known = fields.map((field, position) => [field, versions.get(files[index][position])]).filter(([, version]) => version);
    return { ...record, imageVersions: Object.fromEntries(known) };
  });
}

const REVALIDATE = 'private, no-cache';
const KEEP = 'private, max-age=31536000, immutable';

// Called only after each existing route has authorized and validated its file.
// Original URLs keep returning the untouched originals.
export async function sendDisplayImage(req, res, file, url) {
  const width = requestedDisplayWidth(url);
  if (width === null) return false;
  const store = currentStorage();
  const result = await (store?.displayImage
    ? store.displayImage(file, width, req.headers['if-none-match'])
    : localVariant(file, width, req.headers['if-none-match']));
  const requested = url.searchParams.get('v');
  res.setHeader('Content-Type', 'image/webp');
  // An address carrying the current version can never show a different image,
  // so the browser need not ask again. Anything else revalidates as before.
  res.setHeader('Cache-Control', requested && result.version && requested === result.version ? KEEP : REVALIDATE);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('ETag', result.etag);
  if (result.notModified) { res.statusCode = 304; res.end(); }
  else { res.setHeader('Content-Length', result.bytes.length); res.end(result.bytes); }
  return true;
}

// Preserve the original bytes while letting a signed-in browser revalidate them
// without fetching Blob content. Local routes retain their existing behavior.
export async function sendOriginalImage(req, res, file) {
  const store = currentStorage();
  if (!store?.originalImage) return false;
  const result = await store.originalImage(file, req.headers['if-none-match']);
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'private, no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('ETag', result.etag);
  if (result.notModified) { res.statusCode = 304; res.end(); }
  else { res.setHeader('Content-Length', result.bytes.length); res.end(result.bytes); }
  return true;
}
