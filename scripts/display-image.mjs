import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { readFile, currentStorage } from './storage-fs.mjs';
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
async function localVariant(file, width, condition) {
  const original = await readFile(file);
  const key = displayKey(createHash('sha256').update(original).digest('hex'), width);
  const etag = displayETag(key);
  if (matchesETag(condition, etag)) return { etag, notModified: true };
  let bytes = localVariants.get(key);
  if (!bytes) {
    bytes = await encodeDisplayImage(original, width);
    localVariants.set(key, bytes);
    localBytes += bytes.length;
    while (localBytes > MAX_LOCAL_BYTES && localVariants.size) {
      const first = localVariants.keys().next().value;
      localBytes -= localVariants.get(first).length;
      localVariants.delete(first);
    }
  }
  return { bytes, etag };
}

// Called only after each existing route has authorized and validated its file.
// Original URLs keep returning the untouched originals.
export async function sendDisplayImage(req, res, file, url) {
  const width = requestedDisplayWidth(url);
  if (width === null) return false;
  const store = currentStorage();
  const result = await (store?.displayImage
    ? store.displayImage(file, width, req.headers['if-none-match'])
    : localVariant(file, width, req.headers['if-none-match']));
  res.setHeader('Content-Type', 'image/webp');
  res.setHeader('Cache-Control', 'private, no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('ETag', result.etag);
  if (result.notModified) { res.statusCode = 304; res.end(); }
  else { res.setHeader('Content-Length', result.bytes.length); res.end(result.bytes); }
  return true;
}
