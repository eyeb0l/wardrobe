import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { prepareDecisionBytes, prepareDecisionImage, evidenceUnchanged } from "./decision-images.mjs";
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

test("parallel evidence batches share one immutable download and decode while returning separate results", async t => {
  const { file, bytes } = await image(t);
  let downloads = 0, decodes = 0, identities = 0;
  const encode = sharp.prototype.toBuffer;
  t.mock.method(sharp.prototype, "toBuffer", function (...args) { decodes++; return encode.apply(this, args); });
  const store = { ...fs,
    imageIdentity: async () => { identities++; return "shared-blob"; },
    originalImage: async () => { downloads++; await new Promise(resolve => setImmediate(resolve)); return { identity: "shared-blob", bytes }; },
    readFile: async () => assert.fail("hosted evidence uses the identity-bound snapshot"),
  };
  await withStorage(store, async () => {
    const results = await Promise.all(Array.from({ length: 4 }, () => prepareDecisionImage(file)));
    assert.equal(identities, 4, "each caller resolves the current path before joining shared work");
    assert.equal(downloads, 1); assert.equal(decodes, 1);
    assert.ok(results.every(result => result.image_url === results[0].image_url));
    results[0].image_url = "changed";
    assert.notEqual(results[1].image_url, "changed");
    assert.equal((await prepareDecisionImage(file)).image_url, results[1].image_url);
    assert.equal(downloads, 1); assert.equal(decodes, 1);
  });
});

test("a shared failed download is discarded so a later explicit check can try again", async t => {
  const { file, bytes } = await image(t);
  let downloads = 0;
  const store = { ...fs, imageIdentity: async () => "retry-blob", readFile: async () => {
    downloads++;
    await new Promise(resolve => setImmediate(resolve));
    if (downloads === 1) throw new Error("Offline");
    return bytes;
  } };
  await withStorage(store, async () => {
    const results = await Promise.allSettled([prepareDecisionImage(file), prepareDecisionImage(file)]);
    assert.equal(downloads, 1, "failed work is not retried automatically");
    for (const result of results) { assert.equal(result.status, "rejected"); assert.equal(result.reason.status, 409); }
    assert.match((await prepareDecisionImage(file)).image_url, /^data:image\/jpeg;base64,/);
    assert.equal(downloads, 2);
  });
});

test("a changed hosted identity starts fresh work while the previous image is still preparing", async t => {
  const { file, bytes } = await image(t);
  const replacement = await sharp({ create: { width: 50, height: 50, channels: 3, background: "blue" } }).png().toBuffer();
  let identity = "before", downloads = 0, started;
  const firstRead = new Promise(resolve => { started = resolve; });
  const store = { ...fs, imageIdentity: async () => identity, readFile: async () => {
    downloads++;
    const snapshot = identity === "before" ? bytes : replacement;
    started();
    await new Promise(resolve => setImmediate(resolve));
    return snapshot;
  } };
  await withStorage(store, async () => {
    const first = prepareDecisionImage(file);
    await firstRead;
    identity = "after";
    const [before, after] = await Promise.all([first, prepareDecisionImage(file)]);
    assert.equal(downloads, 2);
    assert.notEqual(before.identity, after.identity); assert.notEqual(before.image_url, after.image_url);
    assert.equal(await evidenceUnchanged([before]), false); assert.equal(await evidenceUnchanged([after]), true);
    assert.equal((await prepareDecisionImage(file)).image_url, after.image_url);
  });
});

test("replacement bytes are never cached under an earlier identity after the original is restored", async t => {
  const { file, bytes } = await image(t);
  const replacement = await sharp({ create: { width: 50, height: 50, channels: 3, background: "blue" } }).png().toBuffer();
  const expected = await prepareDecisionBytes(bytes);
  let identity = "original", replaceOnLookup = true, snapshots = 0, identities = 0, decodes = 0;
  const encode = sharp.prototype.toBuffer;
  t.mock.method(sharp.prototype, "toBuffer", function (...args) { decodes++; return encode.apply(this, args); });
  const store = { ...fs,
    imageIdentity: async () => {
      identities++;
      const result = identity;
      if (replaceOnLookup) { replaceOnLookup = false; identity = "replacement"; }
      return result;
    },
    originalImage: async () => {
      snapshots++;
      const snapshot = { identity, etag: '"opaque-original"', bytes: identity === "original" ? bytes : replacement };
      // Restore the original while the replacement's download is in flight.
      identity = "original";
      return snapshot;
    },
    readFile: async () => assert.fail("hosted preparation must bind bytes to the snapshot identity"),
  };
  await withStorage(store, async () => {
    await assert.rejects(prepareDecisionImage(file), { status: 409 });
    assert.equal(decodes, 0, "a mismatched snapshot is rejected before preparation");
    assert.equal(identities, 1, "mismatch detection uses the byte snapshot without an extra identity lookup");
    assert.equal(identity, "original", "the original path was already restored before snapshot validation");
    const restored = await prepareDecisionImage(file);
    assert.equal(restored.image_url, expected.image_url); assert.equal(decodes, 1);
    assert.equal(await evidenceUnchanged([restored]), true);
    assert.equal((await prepareDecisionImage(file)).image_url, expected.image_url);
    assert.equal(snapshots, 2, "failed work is discarded and later cache hits need no download");
    identity = "replacement";
    assert.equal(await evidenceUnchanged([restored]), false);
  });
});

test("missing and corrupt images fail safely before provider dispatch", async t => {
  const { file } = await image(t);
  await fs.writeFile(file, "not an image");
  await assert.rejects(prepareDecisionImage(file), error => error.status === 409 && !error.message.includes(file));
  await fs.unlink(file);
  await assert.rejects(prepareDecisionImage(file), error => error.status === 409 && !error.message.includes(file));
});
