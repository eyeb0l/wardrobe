import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fileSystem from "node:fs/promises";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { contactTiles, contactThumbnail } from "./contact-tiles.mjs";
import { withStorage } from "./storage-fs.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function fixture(t, count = 9) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wardrobe-tiles-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = [], bytes = new Map();
  for (let index = 0; index < count; index += 1) {
    const file = path.join(root, `item-${index}.png`);
    const value = await sharp({ create: { width: 40 + index, height: 60, channels: 4, background: `#${(0x203040 + index * 0x0a0b0c).toString(16)}` } }).png().toBuffer();
    await writeFile(file, value); files.push(file); bytes.set(file, value);
  }
  const corrupt = path.join(root, "corrupt.png");
  await writeFile(corrupt, Buffer.from("not an image"));
  return { root, files, bytes, corrupt };
}

test("tiles keep group order, skip corrupt candidates and carry the source hash", async (t) => {
  const h = await fixture(t, 3);
  const missing = path.join(h.root, "missing.png");
  const results = await contactTiles([[h.files[0]], [h.corrupt, h.files[1]], [missing], [missing, h.corrupt], [h.files[2]]]);
  assert.deepEqual(results.map((result) => result?.file ?? null), [h.files[0], h.files[1], null, null, h.files[2]]);
  for (const result of results.filter(Boolean)) {
    assert.equal(result.hash, sha256(h.bytes.get(result.file)));
    assert.deepEqual(result.tile, await contactThumbnail(h.bytes.get(result.file)));
    assert.equal(result.identity, null);
  }
});

test("reads run at most six at a time and a cancelled preparation starts no further reads", async (t) => {
  const h = await fixture(t, 14);
  let active = 0, peak = 0;
  const reads = [];
  const store = { ...fileSystem, async readFile(file, ...args) {
    reads.push(file); active += 1; peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return fileSystem.readFile(file, ...args);
  } };
  await withStorage(store, () => contactTiles(h.files.map((file) => [file])));
  assert.equal(reads.length, 14);
  assert.ok(peak > 1 && peak <= 6, `peak concurrency ${peak}`);
  reads.length = 0;
  let cancelled = false;
  const cancel = () => { if (cancelled) throw Object.assign(new Error("cancelled"), { status: 499 }); };
  const work = withStorage(store, () => contactTiles(h.files.map((file) => [file]), { ensureActive: cancel }));
  cancelled = true;
  await assert.rejects(work, { status: 499 });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(reads.length, 6, "only already-started reads ran");
});

test("hosted-style stores pair identity and bytes from one snapshot", async (t) => {
  const h = await fixture(t, 2);
  const store = { ...fileSystem, async originalImage(file) { return { identity: `id:${path.basename(file)}`, bytes: h.bytes.get(file) }; },
    async readFile() { throw new Error("snapshot must be used"); } };
  const results = await withStorage(store, () => contactTiles(h.files.map((file) => [file]), { identities: true }));
  assert.deepEqual(results.map((result) => result.identity), ["id:item-0.png", "id:item-1.png"]);
  assert.deepEqual(results.map((result) => result.hash), h.files.map((file) => sha256(h.bytes.get(file))));
});

async function cloud(t) {
  const { PGlite } = await import("@electric-sql/pglite");
  const { createCloudStore, CLOUD_ROOT } = await import("./cloud-store.mjs");
  const pg = new PGlite();
  t.after(() => pg.close());
  const queries = [];
  const database = {
    async query(text, values = []) { queries.push(text); return (await pg.query(text, values)).rows; },
    async transaction(statements) { return pg.transaction(async (tx) => {
      const results = [];
      for (const { text, values = [] } of statements) results.push((await tx.query(text, values)).rows);
      return results;
    }); },
  };
  const objects = new Map(), reads = [];
  let serial = 0;
  const blob = {
    async put(name, bytes) { const pathname = `${name.replace(/\.png$/, "")}-${serial += 1}.png`; const url = `https://private.test/${pathname}`; objects.set(url, { url, pathname, size: bytes.length, bytes: Buffer.from(bytes) }); return { url }; },
    async get(url) { reads.push(url); const value = objects.get(url); return value ? { statusCode: 200, stream: new Response(value.bytes).body } : null; },
    async list({ prefix }) { return { blobs: [...objects.values()].filter((value) => value.pathname.startsWith(prefix)), hasMore: false }; },
    async del(url) { objects.delete(url); },
  };
  const store = createCloudStore({ database, blob });
  await store.initialize();
  const write = (file, bytes) => store.withLease(() => withStorage(store, async () => {
    await store.mkdir(path.dirname(file), { recursive: true });
    await store.writeFile(file, bytes);
  }));
  return { pg, store, write, reads, queries, CLOUD_ROOT, cold: () => createCloudStore({ database, blob }) };
}

test("hosted tiles persist by immutable source, skip original downloads on later runs and follow replacements", async (t) => {
  const h = await cloud(t);
  const image = (color) => sharp({ create: { width: 50, height: 70, channels: 4, background: color } }).png().toBuffer();
  const files = ["a", "b", "c"].map((name) => `${h.CLOUD_ROOT}/imported/${name}.png`);
  const bytes = [await image("#335577"), await image("#775533"), await image("#557733")];
  for (const [index, file] of files.entries()) await h.write(file, bytes[index]);
  const bad = `${h.CLOUD_ROOT}/imported/bad.png`;
  await h.write(bad, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  const groups = [[files[0]], [bad, files[1]], [`${h.CLOUD_ROOT}/imported/missing.png`], [files[2]]];
  const first = await withStorage(h.cold(), () => contactTiles(groups));
  assert.deepEqual(first.map((result) => result?.file ?? null), [files[0], files[1], null, files[2]]);
  for (const [index, result] of [[0, first[0]], [1, first[1]], [2, first[3]]]) {
    assert.equal(result.hash, sha256(bytes[index]));
    assert.deepEqual(result.tile, await contactThumbnail(bytes[index]));
    assert.equal(result.identity, await h.store.imageIdentity(result.file));
  }
  assert.equal((await h.pg.query("SELECT * FROM wardrobe_contact_tiles")).rows.length, 3, "corrupt sources are not cached");
  h.reads.length = 0; h.queries.length = 0;
  const second = await withStorage(h.cold(), () => contactTiles(groups));
  const summary = (results) => results.map((result) => result && [result.file, result.hash, result.identity, result.tile.toString("base64")]);
  assert.deepEqual(summary(second), summary(first));
  const [{ blob_url: badUrl }] = (await h.pg.query("SELECT blob_url FROM wardrobe_files WHERE path = $1", [bad])).rows;
  assert.deepEqual(h.reads, [badUrl], "cached tiles need no original downloads; only the uncacheable corrupt source is retried");
  assert.ok(h.queries.length <= 4, `batched metadata and tile reads (${h.queries.length} queries)`);
  const replacement = await image("#aa2244");
  await h.write(files[0], replacement);
  const [replaced] = await withStorage(h.cold(), () => contactTiles([[files[0]]]));
  assert.equal(replaced.hash, sha256(replacement), "a replaced path never reuses the earlier source's tile");
  assert.deepEqual(replaced.tile, await contactThumbnail(replacement));
  assert.equal(replaced.identity, await h.store.imageIdentity(files[0]));
  assert.equal((await h.store.collectGarbage()).contactTilesPruned, 1, "the daily collector prunes tiles of unreferenced sources");
  assert.equal((await h.pg.query("SELECT * FROM wardrobe_contact_tiles")).rows.length, 3);
  await h.pg.query("DROP TABLE wardrobe_contact_tiles");
  const [uncached] = await withStorage(h.cold(), () => contactTiles([[files[1]]]));
  assert.equal(uncached.hash, sha256(bytes[1]), "an uninitialised cache table only disables persistence");
  assert.equal((await h.store.collectGarbage()).contactTilesPruned, undefined);
});
