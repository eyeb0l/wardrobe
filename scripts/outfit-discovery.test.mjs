import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import * as fs from "node:fs/promises";
import { wardrobeDiscoveryApi } from "./outfit-discovery-api.mjs";
import { harness } from "./test-helpers/outfit-harness.mjs";
import { jevResponse } from "./test-helpers/jev-response.mjs";
import { withStorage } from "./storage-fs.mjs";
import { createServer } from "node:http";
import { once } from "node:events";

const API = "/api/outfits/discovery";
async function setup(t, options = {}) {
  const h = await harness(t);
  await h.close();
  const calls = [], charges = [];
  const env = { WARDROBE_DATA_DIR: h.dataDir, WARDROBE_JEV_ENABLED: "1", TYPESAFE_API_KEY: "fake-test-key", ...options.env };
  const make = () => wardrobeDiscoveryApi({ env, timeoutMs: options.timeoutMs, beforePaidCall: async (kind) => { charges.push(kind); }, fetch: async (url, init) => {
    assert.equal(url, "https://api.typesafe.ai/v1/systemone");
    const body = JSON.parse(init.body); calls.push(body);
    if (options.fetch) return options.fetch(body);
    return Response.json(jevResponse(body));
  } });
  let plugin = make();
  await plugin.configResolved({ root: h.root });
  const request = (route = "rank", payload = { brief: "Dinner" }, status = 200, headers = {}) => h.requestPlugin(plugin, "POST", `${API}/${route}`, payload, status, { "content-type": "application/json", ...headers });
  return { ...h, calls, charges, request, get plugin() { return plugin; }, config: () => h.requestPlugin(plugin, "GET", `${API}/config`), restart: async () => { plugin = make(); await plugin.configResolved({ root: h.root }); } };
}

test("metadata-only discovery survives hosted instances, counts dispatches and invalidates edits", async (t) => {
  const h = await setup(t);
  const reads = [];
  const store = { ...fs, readFile: async (file, ...args) => { reads.push(file); assert.ok(file.endsWith(".json"), "no garment or outfit image bytes are downloaded"); return fs.readFile(file, ...args); } };
  const before = await fs.readFile(path.join(h.dataDir, "outfits.json"), "utf8");
  assert.deepEqual(await h.config(), { enabled: true, ready: true });
  const result = await withStorage(store, () => h.request());
  assert.equal(result.candidateCount, 6); assert.equal(result.rankedIds.length, 6);
  assert.equal(result.inputTokens, 123);
  assert.deepEqual(h.charges, ["text"]);
  const sent = JSON.stringify(h.calls[0]);
  assert.doesNotMatch(sent, /\/api\/import|data:image|model-reference|#[a-f\d]{6}/i);
  assert.equal(h.calls[0].state.candidates[0].garments[0].category, "top");
  assert.ok(reads.length > 0);
  await h.restart();
  assert.equal((await h.request()).cached, true);
  assert.equal(h.calls.length, 1);
  const changed = structuredClone(h.items);
  changed[0].name = "Renamed blouse"; changed[0].revision = 2;
  await fs.writeFile(path.join(h.dataDir, "library.json"), JSON.stringify(changed));
  await h.request(); assert.equal(h.calls.length, 2);
  changed[0].hidden = true;
  await fs.writeFile(path.join(h.dataDir, "library.json"), JSON.stringify(changed));
  const filtered = await h.request();
  assert.equal(filtered.candidateCount, 2);
  assert.ok(filtered.rankedIds.every((id) => ["original-5", "original-6"].includes(id)));
  assert.equal(await fs.readFile(path.join(h.dataDir, "outfits.json"), "utf8"), before);
});

test("swaps only propose owned alternatives in the chosen category and keep the rest fixed", async (t) => {
  const h = await setup(t);
  const result = await h.request("swaps", { brief: "Less formal", outfitId: "original-1", garmentId: "top-1" });
  assert.equal(result.candidateCount, 5);
  assert.ok(result.rankedIds.every((id) => /^top-[2-6]$/.test(id)));
  assert.deepEqual(h.calls[0].state.context.fixedPieces.map(({ id }) => id), ["bottom-1"]);
  assert.equal(h.calls[0].state.context.original.id, "top-1");
  await h.request("swaps", { brief: "Dinner", outfitId: "not-saved", garmentId: "top-1" }, 409);
  await h.request("swaps", { brief: "Dinner", outfitId: "original-1", garmentId: "top-6" }, 400);
  assert.equal(h.calls.length, 1);
});

test("deletions during an in-flight search never publish stale recommendations", async (t) => {
  let reached, release;
  const started = new Promise((resolve) => { reached = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const h = await setup(t, { fetch: async (body) => { reached(); await gate; return Response.json(jevResponse(body)); } });
  const pending = h.request("rank", { brief: "Dinner" }, 409);
  await started;
  await fs.unlink(path.join(h.dataDir, "imported", "top-1.png"));
  release();
  assert.match((await pending).error, /changed/);
  const fresh = await h.request();
  assert.equal(fresh.candidateCount, 2);
});

test("empty inventory, unknown evidence and weak matches have explicit empty results", async (t) => {
  const h = await setup(t, { fetch: async (body) => {
    const value = jevResponse(body);
    for (const key of Object.keys(value.answers)) {
      if (key.startsWith("evidence")) value.answers[key].choice = "unknown";
      if (key.startsWith("match")) value.answers[key].score = .3;
    }
    return Response.json(value);
  } });
  const result = await h.request();
  assert.deepEqual(result.rankedIds, []); assert.equal(result.unknownCount, 6);
  await fs.writeFile(path.join(h.dataDir, "library.json"), "[]");
  assert.equal((await h.request()).candidateCount, 0);
  assert.equal(h.calls.length, 1);
});

test("feature gates, origins, methods and input limits are enforced before paid work", async (t) => {
  const h = await setup(t);
  await h.request("rank", { brief: "Dinner" }, 403, { origin: "https://attacker.invalid" });
  await h.request("rank", { brief: "Dinner" }, 403, { "sec-fetch-site": "cross-site" });
  await h.request("rank", { brief: "Dinner" }, 415, { "content-type": "text/plain" });
  for (const body of [[], null, "not json", { brief: "" }, { brief: "x".repeat(501) }]) await h.request("rank", body, 400);
  await h.request("rank", { brief: "x".repeat(5000) }, 413);
  assert.equal(h.calls.length, 0);
  const disabled = await setup(t, { env: { WARDROBE_JEV_ENABLED: "0" } });
  assert.deepEqual(await disabled.config(), { enabled: false, ready: false });
  await disabled.request("rank", { brief: "Dinner" }, 503);
  assert.equal(disabled.calls.length, 0);
});

test("large collections are fully scored in bounded batches and reuse cached batches", async (t) => {
  const h = await setup(t);
  const outfits = Array.from({ length: 30 }, (_, index) => ({ ...h.originals[index % 6], id: `many-${index}`, name: `Look ${index}` }));
  await fs.writeFile(path.join(h.dataDir, "outfits.json"), JSON.stringify({ version: 1, outfits }));
  const result = await h.request();
  assert.equal(result.candidateCount, 30); assert.equal(result.rankings.length, 30);
  assert.deepEqual(h.calls.map((call) => call.state.candidates.length), [12, 12, 6]);
  assert.equal(h.charges.length, 3);
  const repeated = await h.request();
  assert.equal(repeated.cached, true); assert.equal(repeated.inputTokens, 0);
  assert.equal(h.charges.length, 3);
});

test("a disconnected browser never dispatches the remaining batches", async (t) => {
  let reached, release, finished, disconnected;
  const started = new Promise((resolve) => { reached = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const done = new Promise((resolve) => { finished = resolve; });
  const closed = new Promise((resolve) => { disconnected = resolve; });
  const h = await setup(t, { fetch: async (body) => { reached(); await gate; return Response.json(jevResponse(body)); } });
  const outfits = Array.from({ length: 30 }, (_, index) => ({ ...h.originals[index % 6], id: `many-${index}` }));
  await fs.writeFile(path.join(h.dataDir, "outfits.json"), JSON.stringify({ version: 1, outfits }));
  let handler;
  h.plugin.configureServer({ middlewares: { use(value) { handler = value; } } });
  const server = createServer(async (req, res) => { res.once("close", disconnected); try { await handler(req, res, () => res.end()); } finally { finished(); } });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { release(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const controller = new AbortController();
  const request = fetch(`http://127.0.0.1:${server.address().port}${API}/rank`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ brief: "Dinner" }), signal: controller.signal }).catch(() => null);
  await started;
  controller.abort();
  await request; await closed;
  release(); await done;
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.charges, ["text"]);
});
