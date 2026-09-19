import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { normalizeModeledUpload } from "./modeled-upload.mjs";

const image = (width, height) => sharp({ create: { width, height, channels: 3, background: "#887766" } });
const payload = (bytes, type = "png") => ({ imageDataUrl: `data:image/${type};base64,${bytes.toString("base64")}` });

test("modeled uploads validate displayed dimensions and normalize JPEG/WebP to metadata-free PNG", async () => {
  for (const format of ["png", "jpeg", "webp"]) {
    const bytes = await image(900, 600)[format]().toBuffer();
    const normalized = await normalizeModeledUpload(payload(bytes, format), "garment");
    const meta = await sharp(normalized).metadata();
    assert.equal(meta.format, "png");
    assert.equal(meta.width, 900);
    assert.equal(meta.height, 600);
    assert.equal(meta.exif, undefined);
  }
  const rotated = await image(600, 900).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const meta = await sharp(await normalizeModeledUpload(payload(rotated, "jpeg"), "garment")).metadata();
  assert.equal(meta.width, 900);
  assert.equal(meta.height, 600);
  assert.equal(meta.orientation, undefined);
});

test("invalid, oversized, undersized, animated and wrong-shaped uploads are rejected", async () => {
  for (const [width, height, kind] of [[512, 512, "garment"], [900, 600, "outfit"], [300, 200, "garment"], [256, 256, "outfit"]]) {
    await assert.rejects(normalizeModeledUpload(payload(await image(width, height).png().toBuffer()), kind), { status: 400 });
  }
  for (const input of [{}, null, payload(Buffer.from("not an image")), { imageDataUrl: "data:image/png;base64,!!!" }, payload(Buffer.from('<svg width="900" height="600"/>'))]) {
    await assert.rejects(normalizeModeledUpload(input, "garment"), { status: 400 });
  }
  await assert.rejects(normalizeModeledUpload(payload(Buffer.alloc(2 * 1024 * 1024 + 1)), "garment"), { status: 413 });
  const animated = await sharp(Buffer.concat([Buffer.alloc(512 * 512 * 3, 0), Buffer.alloc(512 * 512 * 3, 255)]), { raw: { width: 512, height: 1024, channels: 3, pageHeight: 512 } }).webp({ loop: 0, delay: [100, 100] }).toBuffer();
  await assert.rejects(normalizeModeledUpload(payload(animated, "webp"), "outfit"), { status: 400 });
  const large = await image(8001, 8001).png().toBuffer();
  await assert.rejects(normalizeModeledUpload(payload(large), "outfit"), { status: 400 });
});
