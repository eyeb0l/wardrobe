import { createHash } from "node:crypto";
import sharp from "sharp";
import { readFile, stat, imageIdentity } from "./storage-fs.mjs";

const prepared = new Map();
let cacheBytes = 0;
const MAX_CACHE_BYTES = 16 * 1024 * 1024;
const fail = () => Object.assign(new Error("An image is unavailable for checking. Refresh and review it again."), { status: 409 });
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

export async function decisionImageIdentity(file) {
  const immutable = await imageIdentity(file);
  if (immutable) return `hosted:${JSON.stringify(immutable)}`;
  if ((await stat(file)).size > 30 * 1024 * 1024) throw fail();
  return `bytes:${digest(await readFile(file))}`;
}

export async function prepareDecisionImage(file) {
  try {
    let identity = await imageIdentity(file), bytes;
    if (identity) identity = `hosted:${JSON.stringify(identity)}`;
    else {
      if ((await stat(file)).size > 30 * 1024 * 1024) throw fail();
      bytes = await readFile(file);
      identity = `bytes:${digest(bytes)}`;
    }
    const key = JSON.stringify([file, identity]);
    if (prepared.has(key)) return { ...prepared.get(key), file };
    bytes ||= await readFile(file);
    if (bytes.length > 30 * 1024 * 1024) throw fail();
    // White preserves holes in transparent cutouts without sending alpha or
    // display transforms. Rotate before sizing and strip EXIF metadata.
    const image = await sharp(bytes, { limitInputPixels: 50_000_000, animated: false }).rotate()
      .resize({ width: 768, height: 768, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" }).jpeg({ quality: 85 }).toBuffer();
    const value = { identity, image_url: `data:image/jpeg;base64,${image.toString("base64")}` };
    const size = Buffer.byteLength(value.image_url);
    while (prepared.size && (prepared.size >= 64 || cacheBytes + size > MAX_CACHE_BYTES)) {
      const oldest = prepared.keys().next().value;
      cacheBytes -= Buffer.byteLength(prepared.get(oldest).image_url); prepared.delete(oldest);
    }
    if (size <= MAX_CACHE_BYTES) { prepared.set(key, value); cacheBytes += size; }
    return { ...value, file };
  } catch { throw fail(); }
}

export async function prepareEvidence(entries) {
  const images = [];
  // Decode sequentially to bound peak memory. Identical files are reused while
  // every label still gets an explicit association with its image.
  for (const { label, file } of entries) images.push({ label, ...await prepareDecisionImage(file) });
  return images;
}

export const imageInput = images => images.flatMap(({ label, image_url }) => [
  { type: "input_text", text: `Visual evidence ${label}:` },
  { type: "input_image", image_url, detail: "high" },
]);

export async function evidenceUnchanged(images) {
  for (const image of images) {
    try { if (await decisionImageIdentity(image.file) !== image.identity) return false; }
    catch { return false; }
  }
  return true;
}
