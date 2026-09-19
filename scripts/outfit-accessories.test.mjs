import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as localFs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { API, accessoryIdeas, harness } from "./test-helpers/outfit-harness.mjs";
import { withStorage } from "./storage-fs.mjs";

const endpoint = `${API}/original-1/accessories`;
const response = () => Response.json({ output_text: JSON.stringify({ suggestions: accessoryIdeas }) });
const cacheFile = (h) => path.join(h.dataDir, "outfit-accessories.json");
const readCache = async (h) => JSON.parse(await readFile(cacheFile(h), "utf8"));

test("invalid cached accessory lists are misses and explicit requests repair only that entry", async (t) => {
  const h = await harness(t, { analysis: response });
  await h.request("POST", endpoint, {});
  await h.request("POST", `${API}/original-2/accessories`, {});
  const original = await readCache(h);
  let expectedCalls = 2;
  for (const suggestions of [[], [""], [" ", "valid"], ["same", " SAME "], ["one\ntwo", "three"], ["a".repeat(221), "valid"], ["one", "two", "three", "four", "five"]]) {
    const damaged = structuredClone(original);
    damaged.outfits["original-1"].suggestions = suggestions;
    await writeFile(cacheFile(h), JSON.stringify(damaged));
    assert.equal((await h.request("GET", endpoint)).suggestions, null);
    assert.equal(h.requests.length, expectedCalls, "reading an invalid entry must not pay for regeneration");
    assert.deepEqual((await h.request("POST", endpoint, {})).suggestions, accessoryIdeas);
    assert.equal(h.requests.length, ++expectedCalls);
    assert.deepEqual((await readCache(h)).outfits["original-2"], original.outfits["original-2"]);
  }
});

test("corrupt or unsupported accessory cache files are preserved with actionable errors", async (t) => {
  const h = await harness(t, { analysis: response });
  for (const contents of ["{", "null", "[]", '{"version":1,"outfits":[]}', '{"version":2,"outfits":{"future":{"kept":true}}}']) {
    await writeFile(cacheFile(h), contents);
    for (const method of ["GET", "POST"]) {
      const result = await h.request(method, endpoint, {}, 503);
      assert.match(result.error, /outfit-accessories\.json/);
      assert.match(result.error, /preserved|compatible app version/);
      assert.equal(await readFile(cacheFile(h), "utf8"), contents);
    }
  }
  assert.equal(h.requests.length, 0);
});

test("accessory cache filesystem failures name the file and never call the provider", async (t) => {
  const h = await harness(t, { analysis: response });
  await mkdir(cacheFile(h));
  const result = await h.request("POST", endpoint, {}, 503);
  assert.match(result.error, /Could not read outfit-accessories\.json/);
  assert.match(result.error, /permissions and local disk access/);
  assert.equal(h.requests.length, 0);
});

test("accessory context and recipe changes invalidate saved lists without automatic calls", async (t) => {
  const h = await harness(t, { analysis: response });
  await h.request("POST", endpoint, {});
  const saved = await readCache(h);
  const text = h.requests[0].request.input[0].content[0].text;
  const sentContext = text.slice(text.lastIndexOf("\nOutfit context: ") + "\nOutfit context: ".length);
  assert.equal(saved.outfits["original-1"].contextHash, createHash("sha256").update(sentContext).digest("hex"));
  assert.equal(saved.version, 1);
  assert.equal(saved.outfits["original-1"].recipeVersion, 1);

  saved.outfits["original-1"].recipeVersion = 0;
  await writeFile(cacheFile(h), JSON.stringify(saved));
  assert.equal((await h.request("GET", endpoint)).suggestions, null);
  assert.equal(h.requests.length, 1);
  await h.request("POST", endpoint, {});
  assert.equal(h.requests.length, 2);

  const manifestFile = path.join(h.dataDir, "outfits.json");
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  manifest.outfits[0].occasion = ["formal"];
  manifest.outfits[0].reason = "An evening wedding look";
  await writeFile(manifestFile, JSON.stringify(manifest));
  assert.equal((await h.request("GET", endpoint)).suggestions, null);
  assert.equal(h.requests.length, 2);
  await h.request("POST", endpoint, {});
  assert.equal(h.requests.length, 3);
  assert.notEqual((await readCache(h)).outfits["original-1"].contextHash, saved.outfits["original-1"].contextHash);
});

test("legacy accessory entries remain intact until an explicit regeneration", async (t) => {
  const h = await harness(t, { analysis: response });
  await h.request("POST", endpoint, {});
  const cache = await readCache(h);
  delete cache.outfits["original-1"].contextHash;
  delete cache.outfits["original-1"].recipeVersion;
  const legacy = JSON.stringify(cache);
  await writeFile(cacheFile(h), legacy);
  assert.equal((await h.request("GET", endpoint)).suggestions, null);
  assert.equal(await readFile(cacheFile(h), "utf8"), legacy);
  assert.equal(h.requests.length, 1);
  await h.request("POST", endpoint, {});
  assert.equal(h.requests.length, 2);
  assert.equal((await readCache(h)).outfits["original-1"].recipeVersion, 1);
});

test("in-flight accessory responses cannot commit after their context or model changes", async (t) => {
  let release;
  const h = await harness(t, { analysis: () => new Promise((resolve) => { release = () => resolve(response()); }) });
  const manifestFile = path.join(h.dataDir, "outfits.json");
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  for (const changed of ["context", "model"]) {
    release = null;
    const pending = h.request("POST", endpoint, {}, 409);
    while (!release) await delay(2);
    if (changed === "context") {
      manifest.outfits[0].reason = "Updated styling context";
      await writeFile(manifestFile, JSON.stringify(manifest));
    } else process.env.OPENAI_VISION_MODEL = "changed-vision-model";
    release();
    assert.match((await pending).error, /changed/);
    await assert.rejects(readFile(cacheFile(h)), { code: "ENOENT" });
  }
});

test("a cache schema change during generation cannot be overwritten by the late result", async (t) => {
  let release;
  const h = await harness(t, { analysis: () => new Promise((resolve) => { release = () => resolve(response()); }) });
  const pending = h.request("POST", endpoint, {}, 503);
  while (!release) await delay(2);
  const future = '{"version":2,"outfits":{"future":{"kept":true}}}';
  await writeFile(cacheFile(h), future);
  release();
  assert.match((await pending).error, /unsupported schema version/);
  assert.equal(await readFile(cacheFile(h), "utf8"), future);
});

function immutableStorage() {
  const revisions = new Map();
  const reads = [];
  const store = { ...localFs,
    async imageIdentity(file) {
      await localFs.stat(file); // A stale cache must never bypass current existence.
      return `blob-sha256:fixture-${path.basename(file)}-${revisions.get(path.basename(file)) || 0}`;
    },
    async readFile(file, ...args) {
      const value = await localFs.readFile(file, ...args);
      if (String(file).endsWith(".png")) reads.push(value.length);
      return value;
    },
  };
  return { store, reads, replace(file) { revisions.set(path.basename(file), (revisions.get(path.basename(file)) || 0) + 1); }, run: (work) => withStorage(store, work) };
}

test("immutable accessory cache hits read no image bodies across five fresh plugin instances", async (t) => {
  const h = await harness(t, { analysis: response });
  const storage = immutableStorage();
  await storage.run(() => h.request("POST", endpoint, {}));
  assert.deepEqual(storage.reads, [h.output.length], "generation reads the source once; immutable identity validates the commit");
  storage.reads.length = 0;
  for (let index = 0; index < 5; index++) {
    await h.restart({ freshModule: true });
    assert.deepEqual((await storage.run(() => h.request("GET", endpoint))).suggestions, accessoryIdeas);
    assert.deepEqual((await storage.run(() => h.request("POST", endpoint, {}))).suggestions, accessoryIdeas);
  }
  assert.deepEqual(storage.reads, []);
  assert.equal(h.requests.length, 1);
  assert.match((await readCache(h)).outfits["original-1"].imageIdentity, /^blob-sha256:/);
});

test("legacy and restored accessory caches retain portable hashes and promote identities only on explicit requests", async (t) => {
  const h = await harness(t, { analysis: response });
  const storage = immutableStorage();
  await storage.run(() => h.request("POST", endpoint, {}));
  const file = path.join(h.dataDir, "outfit-images", "original-1.png");
  for (const mode of ["legacy", "restored"]) {
    const cache = await readCache(h);
    if (mode === "legacy") delete cache.outfits["original-1"].imageIdentity;
    else storage.replace(file); // A restore gives identical bytes a different URL.
    await writeFile(cacheFile(h), JSON.stringify(cache));
    const previous = await readFile(cacheFile(h), "utf8");
    storage.reads.length = 0;
    assert.deepEqual((await storage.run(() => h.request("GET", endpoint))).suggestions, accessoryIdeas);
    assert.deepEqual(storage.reads, [h.output.length]);
    assert.equal(await readFile(cacheFile(h), "utf8"), previous, "GET never migrates or writes the cache");
    await storage.run(() => h.request("POST", endpoint, {}));
    assert.equal(h.requests.length, 1, "hash-compatible migration never pays for another analysis");
    assert.equal((await readCache(h)).outfits["original-1"].imageHash, createHash("sha256").update(h.output).digest("hex"));
    storage.reads.length = 0;
    assert.deepEqual((await storage.run(() => h.request("GET", endpoint))).suggestions, accessoryIdeas);
    assert.deepEqual(storage.reads, []);
  }
  assert.deepEqual((await h.request("GET", endpoint)).suggestions, accessoryIdeas, "cloud backup remains usable after restoring onto local files");
});

test("immutable identity does not hide changed context, replacement bytes or deletion", async (t) => {
  const h = await harness(t, { analysis: response });
  const storage = immutableStorage();
  await storage.run(() => h.request("POST", endpoint, {}));
  const manifestFile = path.join(h.dataDir, "outfits.json");
  const originalManifest = await readFile(manifestFile, "utf8");
  const manifest = JSON.parse(originalManifest);
  manifest.outfits[0].reason = "New context";
  await writeFile(manifestFile, JSON.stringify(manifest));
  storage.reads.length = 0;
  assert.equal((await storage.run(() => h.request("GET", endpoint))).suggestions, null);
  assert.deepEqual(storage.reads, [], "context-only invalidation needs no photo download");
  await writeFile(manifestFile, originalManifest);
  const file = path.join(h.dataDir, "outfit-images", "original-1.png");
  await writeFile(file, await h.image("#123456"));
  storage.replace(file);
  assert.equal((await storage.run(() => h.request("GET", endpoint))).suggestions, null);
  assert.equal(storage.reads.length, 1);
  await localFs.rm(file);
  storage.reads.length = 0;
  await storage.run(() => h.request("GET", endpoint, undefined, 404));
  assert.deepEqual(storage.reads, []);
  assert.equal(h.requests.length, 1);
});

test("an immutable photo replacement during accessory analysis rejects the late response", async (t) => {
  let release;
  const h = await harness(t, { analysis: () => new Promise((resolve) => { release = () => resolve(response()); }) });
  const storage = immutableStorage();
  const pending = storage.run(() => h.request("POST", endpoint, {}, 409));
  while (!release) await delay(2);
  const file = path.join(h.dataDir, "outfit-images", "original-1.png");
  await writeFile(file, await h.image("#654321"));
  storage.replace(file);
  release();
  assert.match((await pending).error, /changed/);
  await assert.rejects(readFile(cacheFile(h)), { code: "ENOENT" });
  assert.deepEqual(storage.reads, [h.output.length], "fresh metadata catches replacement without downloading the new body");
});
