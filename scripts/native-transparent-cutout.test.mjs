import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { normalizeGeneratedTransparency } from "./native-transparent-cutout.mjs";

test("makes only established garment interiors fully opaque", async () => {
  const width = 24, height = 24;
  const pixels = Buffer.alloc(width * height * 4);
  const put = (x, y, rgba) => pixels.set(rgba, (y * width + x) * 4);
  for (let y = 4; y < 20; y++) for (let x = 4; x < 20; x++) put(x, y, [250, 250, 250, 253]);
  put(4, 10, [250, 250, 250, 110]); // Antialiased outer edge.
  put(12, 12, [250, 250, 250, 80]); // Small opening through the garment.
  put(18, 18, [250, 250, 250, 180]); // Sheer detail.
  const input = await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
  const result = await normalizeGeneratedTransparency(input);
  const output = await sharp(result.bytes).ensureAlpha().raw().toBuffer();
  assert.equal(output[(8 * width + 8) * 4 + 3], 255);
  assert.equal(output[(4 * width + 4) * 4 + 3], 253);
  assert.equal(output[(12 * width + 12) * 4 + 3], 80);
  assert.equal(output[(18 * width + 18) * 4 + 3], 180);
  assert.ok(result.diagnostics.correctedPixels > 0);
  for (let i = 0; i < pixels.length; i += 4) {
    assert.deepEqual([...output.subarray(i, i + 3)], [...pixels.subarray(i, i + 3)]);
    if (pixels[i + 3] < 250) assert.equal(output[i + 3], pixels[i + 3]);
  }
});

test("rejects an opaque or empty provider result before review", async () => {
  const opaque = await sharp({ create: { width: 20, height: 20, channels: 3, background: "white" } }).png().toBuffer();
  const empty = await sharp({ create: { width: 20, height: 20, channels: 4, background: "#00000000" } }).png().toBuffer();
  await assert.rejects(normalizeGeneratedTransparency(opaque), /transparent PNG background/);
  await assert.rejects(normalizeGeneratedTransparency(empty), /visible garment/);
});
