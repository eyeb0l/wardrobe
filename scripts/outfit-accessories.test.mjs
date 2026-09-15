import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { API, accessoryIdeas, harness } from "./test-helpers/outfit-harness.mjs";

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
