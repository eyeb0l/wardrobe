import { createHash } from "node:crypto";
import sharp from "sharp";
import { readFile, imageIdentity, originalImage, currentStorage } from "./storage-fs.mjs";
import { mapLimit } from "./map-limit.mjs";

// Bump when the tile bytes would change; persisted hosted tiles are keyed by it.
export const CONTACT_TILE_RECIPE = "contact-236x252-contain-png-v1";
export const contactThumbnail = (bytes) => sharp(bytes, { limitInputPixels: 64e6 }).rotate().resize(236, 252, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const CONCURRENCY = 6;

// Local tiles are keyed by the content hash of the bytes just read, so a cached
// tile can only ever be paired with identical source pixels.
const localTiles = new Map();
let localBytes = 0;
function rememberLocal(key, tile) {
  if (tile.length > 1024 * 1024) return;
  localTiles.set(key, tile); localBytes += tile.length;
  while (localTiles.size > 1024 || localBytes > 32 * 1024 * 1024) {
    const oldest = localTiles.keys().next().value;
    localBytes -= localTiles.get(oldest).length; localTiles.delete(oldest);
  }
}
async function localTile(file, identities) {
  let identity = null, bytes;
  // Identity and bytes must describe the same snapshot when a store offers one.
  const snapshot = identities ? await originalImage(file) : null;
  if (snapshot) ({ identity, bytes } = snapshot);
  else {
    if (identities) identity = await imageIdentity(file) ?? null;
    bytes = await readFile(file);
  }
  const hash = sha256(bytes), key = `${CONTACT_TILE_RECIPE}:${hash}`;
  let tile = localTiles.get(key);
  if (tile) { localTiles.delete(key); localTiles.set(key, tile); }
  else rememberLocal(key, tile = await contactThumbnail(bytes));
  return { identity, hash, tile: Buffer.from(tile) };
}
async function tilesFor(files, { ensureActive, identities }) {
  const store = currentStorage();
  if (store?.contactTiles) return store.contactTiles(files, { recipe: CONTACT_TILE_RECIPE, make: contactThumbnail, ensureActive, concurrency: CONCURRENCY });
  return mapLimit(files, CONCURRENCY, async (file) => {
    ensureActive();
    try { return await localTile(file, identities); } catch { return null; }
  });
}

// Each group lists candidate files for one item in preference order. Returns, in
// group order, the first readable candidate's { file, tile, hash, identity } or
// null. hash is the SHA-256 of the original bytes; identity is the hosted
// immutable identity when available. ensureActive errors propagate.
export async function contactTiles(groups, { ensureActive = () => {}, identities = false } = {}) {
  const results = new Array(groups.length).fill(null);
  let pending = groups.map((files, index) => ({ index, files, next: 0 })).filter((group) => group.files.length);
  while (pending.length) {
    const files = pending.map((group) => group.files[group.next]);
    const tiles = await tilesFor(files, { ensureActive, identities });
    pending = pending.filter((group, index) => {
      if (tiles[index]) { results[group.index] = { file: files[index], ...tiles[index] }; return false; }
      return ++group.next < group.files.length;
    });
  }
  return results;
}
