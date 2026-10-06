import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { prepareDecisionImage, evidenceUnchanged } from "./decision-images.mjs";
import { withStorage } from "./storage-fs.mjs";

async function image(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wardrobe-decision-image-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "source.png");
  const bytes = await sharp({ create: { width: 1200, height: 900, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
  await fs.writeFile(file, bytes);
  return { file, bytes };
}

test("decision evidence is a bounded metadata-free image and preserves the source", async t => {
  const { file, bytes } = await image(t);
  const prepared = await prepareDecisionImage(file);
  const output = Buffer.from(prepared.image_url.split(",")[1], "base64");
  const metadata = await sharp(output).metadata();
  assert.equal(metadata.format, "jpeg"); assert.equal(metadata.width, 768); assert.equal(metadata.height, 576);
  assert.equal(metadata.hasAlpha, false); assert.equal(metadata.exif, undefined);
  const pixel = await sharp(output).resize(1, 1).raw().toBuffer();
  assert.ok([...pixel].every(channel => channel >= 250), "transparent background becomes white");
  assert.deepEqual(await fs.readFile(file), bytes); assert.equal(await evidenceUnchanged([prepared]), true);
  await fs.writeFile(file, await sharp({ create: { width: 50, height: 50, channels: 3, background: "red" } }).png().toBuffer());
  assert.equal(await evidenceUnchanged([prepared]), false);
  assert.notEqual((await prepareDecisionImage(file)).image_url, prepared.image_url);
});

test("fresh immutable hosted identities reuse preparation without repeated image downloads", async t => {
  const { file } = await image(t);
  let identity = "blob-one", downloads = 0;
  const store = { ...fs, imageIdentity: async () => identity, readFile: async (...args) => { downloads++; return fs.readFile(...args); } };
  await withStorage(store, async () => {
    const first = await prepareDecisionImage(file);
    assert.equal((await prepareDecisionImage(file)).image_url, first.image_url);
    assert.equal(await evidenceUnchanged([first]), true); assert.equal(downloads, 1);
    identity = "blob-two";
    assert.equal(await evidenceUnchanged([first]), false);
    await prepareDecisionImage(file); assert.equal(downloads, 2);
  });
});

test("missing and corrupt images fail safely before provider dispatch", async t => {
  const { file } = await image(t);
  await fs.writeFile(file, "not an image");
  await assert.rejects(prepareDecisionImage(file), error => error.status === 409 && !error.message.includes(file));
  await fs.unlink(file);
  await assert.rejects(prepareDecisionImage(file), error => error.status === 409 && !error.message.includes(file));
});
