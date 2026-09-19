import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import sharp from "sharp";
import { buildOutfitPrompt } from "./outfit-api.mjs";

import { API, accessoryIdeas, plan, harness } from "./test-helpers/outfit-harness.mjs";

test("configuration uses current model precedence, custom data root and numbered identity references", async (t) => {
  const h = await harness(t);
  const config = await h.request("GET", `${API}/config`);
  assert.equal(config.ready, true);
  assert.deepEqual(config.models, { vision: "gpt-5.6-luna", image: "gpt-image-2.5-sunburst" });
  assert.deepEqual(config.counts, { upperbody: 6, lowerbody: 4, wholebody_up: 1, shoes: 1, accessories_up: 1 });
  assert.equal(config.availableCombinations, 18);
  assert.equal(config.maxCount, 12);
  assert.deepEqual(config.modelReferences.map((item) => item.id), ["default", "model-reference-2"]);
  assert.equal(config.modelReferences[1].imageUrl, "/api/import/model-references/model-reference-2");
  assert.ok(!JSON.stringify(config).includes("outfit-test-key"));
  await rm(path.join(h.root, "identity.png"));
  const secondOnly = await h.request("GET", `${API}/config`);
  assert.equal(secondOnly.hasModelReference, true);
  assert.deepEqual(secondOnly.modelReferences.map((item) => item.id), ["model-reference-2"]);
  await h.request("POST", `${API}/jobs`, { count: 1, modelReferenceId: "default" }, 400);
  const created = await h.create(1, { modelReferenceId: "model-reference-2" });
  assert.equal((await h.settled(created.id)).status, "review");
});

for (const [overrides, imageModel] of [
  [{ OPENAI_IMAGE_MODEL: "global-image" }, "global-image"],
  [{ OPENAI_IMAGE_MODEL: "global-image", OPENAI_MODELED_MODEL: "modeled-image", OPENAI_VISION_MODEL: "vision-override" }, "modeled-image"],
]) test(`configured image model ${imageModel} is used by actual requests`, async (t) => {
  const h = await harness(t, { env: overrides });
  const job = await h.create();
  assert.equal((await h.settled(job.id)).status, "review");
  const edit = h.requests.find((entry) => entry.kind === "edit");
  assert.equal(edit.form.get("model"), imageModel);
  assert.equal(edit.form.get("quality"), "high");
  assert.equal(h.requests[0].request.model, overrides.OPENAI_VISION_MODEL || "gpt-5.6-luna");
});

test("curation receives labeled visual sheets and selected references are sent in exact order", async (t) => {
  const selected = ["accessory-1", "bottom-1", "shoe-1", "top-3", "outer-1"];
  const h = await harness(t, { analysis: [plan(1, selected)] });
  const created = await h.create(1, { direction: "Quiet smart-casual looks" });
  const job = await h.settled(created.id);
  assert.equal(job.status, "review", job.error);
  assert.equal(job.outfits[0].status, "review");
  assert.equal((await h.request("GET", API)).outfits.length, 6, "unreviewed output stays out of the gallery");
  const request = h.requests[0].request;
  assert.equal(request.text.format.strict, true);
  assert.equal(request.text.format.schema.properties.outfits.maxItems, 1);
  assert.ok(!request.text.format.schema.properties.outfits.items.properties.garmentIds.items.enum.includes("dress-1"));
  const content = request.input[0].content;
  assert.match(content[0].text, /ITEM 13/);
  assert.match(content[0].text, /Quiet smart-casual looks/);
  assert.match(content[0].text, /top-1/);
  assert.equal(content.filter((item) => item.type === "input_image").length, 2, "each sheet has at most 12 garments");
  for (const item of content.filter((value) => value.type === "input_image")) {
    const metadata = await sharp(Buffer.from(item.image_url.split(",")[1], "base64")).metadata();
    assert.equal(metadata.width, 1024);
    assert.ok(metadata.height <= 900);
  }
  const edit = h.requests.find((entry) => entry.kind === "edit");
  assert.deepEqual(edit.images.map((item) => item.name), ["identity.png", "upperbody-top-3.png", "lowerbody-bottom-1.png", "wholebody_up-outer-1.png", "shoes-shoe-1.png", "accessories_up-accessory-1.png"]);
  assert.deepEqual(await sharp(edit.images[0].bytes).raw().toBuffer(), await sharp(h.identity).raw().toBuffer());
  for (const [index, id] of ["top-3", "bottom-1", "outer-1", "shoe-1", "accessory-1"].entries()) assert.deepEqual(await sharp(edit.images[index + 1].bytes).raw().toBuffer(), await sharp(h.bytesById.get(id)).raw().toBuffer());
  assert.equal(edit.form.get("size"), "1024x1024");
  assert.equal(edit.form.get("output_format"), "png");
  assert.match(edit.form.get("prompt"), /simple unpatterned black or brown tights/);
  assert.match(edit.form.get("prompt"), /actual closure/);
  assert.equal((await sharp(await h.request("GET", job.outfits[0].image)).metadata()).width, 64);
  const saved = JSON.parse(await readFile(path.join(h.dataDir, "outfit-jobs", job.id, "job.json"), "utf8"));
  assert.equal(saved.outfits[0].internal.history[0].prompt, edit.form.get("prompt"));
  assert.ok(!("internal" in job));
  assert.ok(!("internal" in job.outfits[0]));
});

test("concurrent approvals preserve the original six and are idempotent", async (t) => {
  const h = await harness(t, { analysis: [plan(1), plan(2)] });
  const created = await h.create(2);
  const job = await h.settled(created.id);
  assert.equal(job.status, "review");
  await Promise.all(job.outfits.map((outfit) => h.action(job, outfit, "approve")));
  await h.action(job, job.outfits[0], "approve");
  const saved = JSON.parse(await readFile(path.join(h.dataDir, "outfits.json"), "utf8"));
  assert.equal(saved.outfits.length, 8);
  assert.deepEqual(saved.outfits.slice(0, 6), h.originals);
  assert.equal(new Set(saved.outfits.map((item) => item.id)).size, 8);
  const gallery = await h.request("GET", API);
  assert.equal(gallery.outfits.length, 8);
  for (const outfit of gallery.outfits) assert.ok(Buffer.isBuffer(await h.request("GET", outfit.image)));
  assert.equal((await h.request("GET", `${API}/jobs/${job.id}`)).status, "complete");
  await h.restart();
  assert.equal(h.requests.length, 3, "restart makes no extra API calls");
  assert.equal((await h.request("GET", API)).outfits.length, 8);
});

test("counts, malformed bodies, unknown references and cross-site mutations fail before paid requests", async (t) => {
  const h = await harness(t);
  for (const count of [undefined, 0, -1, 1.5, "2", 13, null]) await h.request("POST", `${API}/jobs`, { count }, 400);
  await h.request("POST", `${API}/jobs`, { count: 1, direction: "x".repeat(2001) }, 400);
  await h.request("POST", `${API}/jobs`, { count: 1, modelReferenceId: "../identity.png" }, 400);
  await h.request("POST", `${API}/jobs`, "{broken", 400);
  await h.request("POST", `${API}/jobs`, "x".repeat(17 * 1024), 413);
  await h.request("POST", `${API}/jobs`, { count: 1 }, 403, { origin: "https://attacker.invalid" });
  await h.request("POST", `${API}/jobs`, { count: 1 }, 403, { "sec-fetch-site": "cross-site" });
  await h.request("POST", `${API}/jobs`, { count: 1 }, 415, { "content-type": "text/plain" });
  assert.equal(h.requests.length, 0);
  const items = h.items.filter((item) => item.part !== "lowerbody" || item.id === "bottom-1");
  await writeFile(path.join(h.dataDir, "library.json"), JSON.stringify(items));
  await h.request("POST", `${API}/jobs`, { count: 5 }, 409);
  assert.equal(h.requests.length, 0);
});

for (const [description, invalid, count] of [
  ["unknown garment", [plan(1, ["top-3", "missing-id"])], 1],
  ["two tops", [plan(1, ["top-3", "top-4", "bottom-1"])], 1],
  ["duplicate garment", [plan(1, ["top-3", "bottom-1", "top-3"])], 1],
  ["existing pair despite different shoes", [plan(1, ["top-1", "bottom-1", "shoe-1"])], 1],
  ["duplicate new pairs despite accessories", [plan(1), plan(2, ["top-3", "bottom-1", "accessory-1"])], 2],
  ["duplicate outfit IDs", [plan(1), { ...plan(2), id: "look-1" }], 2],
  ["wrong result count", [], 1],
  ["unsafe generated ID", [{ ...plan(), id: "../escape" }], 1],
  ["missing outer construction", [{ ...plan(1, ["top-3", "bottom-1", "outer-1"]), outerLayerConstruction: "none" }], 1],
]) test(`invalid curation (${description}) never reaches the image API`, async (t) => {
  const h = await harness(t, { analysis: invalid });
  const created = await h.create(count);
  const job = await h.settled(created.id);
  assert.equal(job.status, "failed");
  assert.ok(job.error);
  assert.equal(h.requests.filter((item) => item.kind === "edit").length, 0);
  assert.equal((await h.request("GET", API)).outfits.length, 6);
});

test("active review candidates reserve their pair and failed planning can be retried", async (t) => {
  const h = await harness(t);
  const first = await h.settled((await h.create()).id);
  assert.equal(first.status, "review");
  const second = await h.settled((await h.create()).id);
  assert.equal(second.status, "failed");
  assert.match(second.error, /repeated/);
  h.setAnalysis([plan(2)]);
  await h.request("POST", `${API}/jobs/${second.id}/retry`, {}, 202);
  assert.equal((await h.settled(second.id)).status, "review");
  assert.equal(h.requests.filter((item) => item.kind === "analysis").length, 3);
  assert.equal(h.requests.filter((item) => item.kind === "edit").length, 2);
});

test("failed images stay out of the gallery; collection retry runs only failed items", async (t) => {
  let call = 0;
  const h = await harness(t, { analysis: [plan(1), plan(2)], edit: async () => {
    call += 1;
    if (call === 1) return Response.json({ error: { message: "secret outfit-test-key should not be exposed" } }, { status: 401 });
    return Response.json({ data: [{ b64_json: h.output.toString("base64") }] });
  } });
  const job = await h.settled((await h.create(2)).id);
  assert.deepEqual(job.outfits.map((item) => item.status), ["failed", "review"]);
  assert.match(job.outfits[0].error, /HTTP 401/);
  assert.ok(!JSON.stringify(job).includes("outfit-test-key"));
  await h.request("POST", `${API}/jobs/${job.id}/retry`, {}, 202);
  const retried = await h.settled(job.id);
  assert.deepEqual(retried.outfits.map((item) => item.attempts), [2, 1]);
  assert.equal(call, 3);
  assert.equal(h.requests.filter((item) => item.kind === "analysis").length, 1);
  await h.action(retried, retried.outfits[0], "reject");
  assert.equal((await h.request("GET", API)).outfits.length, 6);
  await h.action(retried, retried.outfits[0], "approve", {}, 409);
});

test("corrective retry attaches the failed candidate after exact references and records direction", async (t) => {
  const h = await harness(t);
  const job = await h.settled((await h.create()).id);
  await h.action(job, job.outfits[0], "reject");
  await h.action(job, job.outfits[0], "retry", { prompt: "Show both complete shoes and preserve the face." });
  const retried = await h.settled(job.id);
  assert.equal(retried.outfits[0].status, "review");
  assert.equal(retried.outfits[0].attempts, 2);
  assert.notEqual(retried.outfits[0].image, job.outfits[0].image);
  const edit = h.requests.filter((item) => item.kind === "edit").at(-1);
  assert.equal(edit.images.length, 4);
  assert.equal(edit.images[0].name, "identity.png");
  assert.equal(edit.images.at(-1).name, "previous-attempt.png");
  assert.match(edit.form.get("prompt"), /Show both complete shoes/);
  assert.match(edit.form.get("prompt"), /Image 4: previous generated attempt/);
  assert.equal((await h.request("GET", API)).outfits.length, 6);
});

test("non-square and undecodable image responses cannot reach review", async (t) => {
  const h = await harness(t);
  const rectangle = await h.image("#555555", 64, 96);
  for (const output of [rectangle, Buffer.from("not an image")]) {
    h.setEdit(async () => Response.json({ data: [{ b64_json: output.toString("base64") }] }));
    const job = await h.settled((await h.create()).id);
    assert.equal(job.status, "failed");
    assert.match(job.outfits[0].error, /invalid or non-square PNG/);
    await h.action(job, job.outfits[0], "reject");
  }
  assert.equal((await h.request("GET", API)).outfits.length, 6);
});

test("restart preserves review and marks interrupted work retryable without new requests", async (t) => {
  const h = await harness(t);
  const reviewed = await h.settled((await h.create()).id);
  const id = "11111111-1111-4111-8111-111111111111";
  await mkdir(path.join(h.dataDir, "outfit-jobs", id));
  await writeFile(path.join(h.dataDir, "outfit-jobs", id, "job.json"), JSON.stringify({ id, count: 1, direction: "", modelReferenceId: "default", status: "planning", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), error: null, outfits: [], internal: {} }));
  const interrupted = structuredClone(JSON.parse(await readFile(path.join(h.dataDir, "outfit-jobs", reviewed.id, "job.json"), "utf8")));
  const secondId = "22222222-2222-4222-8222-222222222222";
  interrupted.id = secondId;
  interrupted.status = "generating";
  interrupted.outfits[0].status = "generating";
  interrupted.outfits[0].id = "interrupted-look";
  interrupted.outfits[0].garmentIds = ["top-4", "bottom-1"];
  await mkdir(path.join(h.dataDir, "outfit-jobs", secondId));
  await writeFile(path.join(h.dataDir, "outfit-jobs", secondId, "job.json"), JSON.stringify(interrupted));
  await h.restart();
  assert.equal(h.requests.length, 2);
  assert.equal((await h.request("GET", `${API}/jobs/${reviewed.id}`)).status, "review");
  const planning = await h.request("GET", `${API}/jobs/${id}`);
  assert.equal(planning.status, "failed");
  assert.match(planning.error, /no API request was restarted automatically/);
  const generating = await h.request("GET", `${API}/jobs/${secondId}`);
  assert.equal(generating.outfits[0].status, "failed");
  assert.match(generating.outfits[0].error, /Check API usage/);
});

test("asset routes are allowlisted and reject traversal, unrelated files and symlink escapes", async (t) => {
  const h = await harness(t);
  await writeFile(path.join(h.dataDir, "outfit-images", "unlisted.png"), h.output);
  await h.request("GET", `${API}/images/unlisted.png`, undefined, 404);
  await h.request("GET", `${API}/images/%2e%2e%2fidentity.png`, undefined, 404);
  await h.request("GET", `${API}/images/..%5cidentity.png`, undefined, 404);
  const job = await h.settled((await h.create()).id);
  await h.request("GET", `${API}/jobs/${job.id}/assets/job.json`, undefined, 404);
  await h.request("GET", `${API}/jobs/${job.id}/assets/%2e%2e%2fidentity.png`, undefined, 404);
  await rm(path.join(h.dataDir, "outfit-images", "original-1.png"));
  await symlink(path.join(h.root, "identity.png"), path.join(h.dataDir, "outfit-images", "original-1.png"));
  await h.request("GET", `${API}/images/original-1.png`, undefined, 404);
  await rm(path.join(h.dataDir, "imported", "top-6.png"));
  await symlink(path.join(h.root, "identity.png"), path.join(h.dataDir, "imported", "top-6.png"));
  await rm(path.join(h.dataDir, "imported", "top-5.png"));
  const config = await h.request("GET", `${API}/config`);
  assert.equal(config.counts.upperbody, 4, "missing and escaped source images are excluded");
});

test("timeouts report unknown paid result without automatic retries", async (t) => {
  const h = await harness(t, { timeoutMs: 15, analysis: async (_, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  }) });
  const job = await h.settled((await h.create()).id);
  assert.equal(job.status, "failed");
  assert.match(job.error, /timed out/);
  assert.match(job.error, /result is unknown/);
  assert.equal(h.requests.length, 1);
  await h.restart();
  assert.equal(h.requests.length, 1);
});

test("pullover layering never offers invented openings", () => {
  const outfit = { name: "Knit layers", setting: "a courtyard", internal: { outerLayerConstruction: "pullover", outerLayerNote: "A closed crew neck pullover." } };
  const prompt = buildOutfitPrompt(outfit, [{ name: "Tee", part: "upperbody" }, { name: "Trousers", part: "lowerbody" }, { name: "Pullover", part: "wholebody_up" }]);
  assert.match(prompt, /Keep the outer garment closed exactly as designed/);
  assert.ok(!prompt.includes("may be naturally open"));
});

test("Vite-order module reload takes ownership before recovery and ignores late old-generation output", async (t) => {
  let release;
  let signal;
  const h = await harness(t, { edit: async (_, options) => {
    signal = options.signal;
    // Simulate an adapter that ignores abort and reports its result late.
    return new Promise((resolve) => { release = resolve; });
  } });
  const job = await h.create();
  for (let index = 0; index < 200 && !release; index += 1) await delay(10);
  assert.ok(release, "first image request started");
  await symlink(h.dataDir, path.join(h.root, "alias-data"));
  // Vite creates/configures its replacement before closing the old instance.
  // A fresh module and symlinked root must still find the same process owner.
  await h.restart({ viteOrder: true, freshModule: true, dataDirectory: "alias-data" });
  assert.equal(signal.aborted, true);
  const interrupted = await h.request("GET", `${API}/jobs/${job.id}`);
  assert.equal(interrupted.outfits[0].status, "failed");
  assert.equal(interrupted.outfits[0].attempts, 1);
  h.setEdit(null);
  await h.request("POST", `${API}/jobs/${job.id}/retry`, {}, 202);
  const retried = await h.settled(job.id);
  assert.equal(retried.outfits[0].status, "review");
  assert.equal(retried.outfits[0].attempts, 2);
  const persistedBefore = await readFile(path.join(h.dataDir, "outfit-jobs", job.id, "job.json"), "utf8");
  release(Response.json({ data: [{ b64_json: h.output.toString("base64") }] }));
  await delay(30);
  assert.equal(await readFile(path.join(h.dataDir, "outfit-jobs", job.id, "job.json"), "utf8"), persistedBefore, "old plugin cannot overwrite the new retry");
  assert.equal((await h.request("GET", API)).outfits.length, 6);
});

test("new-before-old-close startup waits for an outstanding approval's atomic manifest write", async (t) => {
  const h = await harness(t, { analysis: [plan(1), plan(2)] });
  const job = await h.settled((await h.create(2)).id);
  const originalRename = fs.rename;
  const destination = path.join(await fs.realpath(h.dataDir), "outfits.json");
  let release;
  let entered;
  let blocked = false;
  const waitingForWrite = new Promise((resolve) => { entered = resolve; });
  const pausedWrite = new Promise((resolve) => { release = resolve; });
  fs.rename = async (from, to) => {
    if (to === destination && !blocked) {
      blocked = true;
      entered();
      await pausedWrite;
    }
    return originalRename(from, to);
  };
  syncBuiltinESMExports();
  t.after(() => { release(); fs.rename = originalRename; syncBuiltinESMExports(); });
  const approving = h.action(job, job.outfits[0], "approve", undefined, 503);
  await waitingForWrite;
  let replacementReady = false;
  const restarting = h.restart({ viteOrder: true, freshModule: true }).then(() => { replacementReady = true; });
  let oldStatus = 200;
  for (let index = 0; index < 200 && oldStatus !== 503; index += 1) {
    oldStatus = (await h.request("GET", `${API}/config`, undefined, null)).status;
    if (oldStatus !== 503) await delay(5);
  }
  assert.equal(oldStatus, 503, "replacement has reached ownership handoff and retired the old instance");
  assert.equal(replacementReady, false, "new startup must wait until the old manifest transaction settles");
  release();
  await Promise.all([approving, restarting]);
  fs.rename = originalRename;
  syncBuiltinESMExports();
  const restored = await h.request("GET", `${API}/jobs/${job.id}`);
  assert.deepEqual(restored.outfits.map((item) => item.status), ["accepted", "review"], "recovery reads the just-committed manifest before restoring job state");
  await h.action(restored, restored.outfits[1], "approve");
  const saved = JSON.parse(await readFile(destination, "utf8"));
  assert.equal(saved.outfits.length, 8);
  assert.deepEqual(saved.outfits.slice(0, 6), h.originals);
  assert.equal((await h.request("GET", `${API}/jobs/${job.id}`)).status, "complete");
});

test("concurrent ownership handoffs serialize and old close cannot unregister the active owner", async (t) => {
  let signal;
  const h = await harness(t, { edit: async (_, options) => {
    signal = options.signal;
    return new Promise(() => {});
  } });
  await h.create();
  for (let index = 0; index < 200 && !signal; index += 1) await delay(10);
  assert.ok(signal);
  const [second, third] = await Promise.all([h.makePlugin({ freshModule: true }), h.makePlugin({ freshModule: true })]);
  await Promise.all([second.configResolved({ root: h.root }), third.configResolved({ root: h.root })]);
  assert.equal(signal.aborted, true);
  const results = await Promise.all([second, third].map((instance) => h.requestPlugin(instance, "GET", `${API}/config`, undefined, null)));
  assert.deepEqual(results.map((item) => item.status).sort(), [200, 503], "only one owner can serve the data directory");
  const active = results[0].status === 200 ? second : third;
  const retired = active === second ? third : second;
  await retired.closeBundle();
  const fourth = await h.makePlugin({ freshModule: true });
  await fourth.configResolved({ root: h.root });
  await h.requestPlugin(active, "GET", `${API}/config`, undefined, 503);
  assert.equal((await h.requestPlugin(fourth, "GET", `${API}/config`)).hasApiKey, true);
  await Promise.all([second.closeBundle(), third.closeBundle(), fourth.closeBundle()]);
});

test("ownership and disposal remain independent for different data directories", async (t) => {
  let signal;
  const first = await harness(t, { edit: async (_, options) => {
    signal = options.signal;
    return new Promise(() => {});
  } });
  await first.create();
  for (let index = 0; index < 200 && !signal; index += 1) await delay(10);
  assert.ok(signal);
  const second = await harness(t);
  assert.equal(signal.aborted, false);
  await second.restart({ viteOrder: true, freshModule: true });
  await second.close();
  assert.equal(signal.aborted, false, "closing another data root cannot cancel this generation");
  await first.close();
  assert.equal(signal.aborted, true);
});

test("plan commitment rechecks combinations reserved by a retry during vision work", async (t) => {
  const h = await harness(t);
  const first = await h.settled((await h.create()).id);
  await h.action(first, first.outfits[0], "reject");
  let release;
  h.setAnalysis(async () => new Promise((resolve) => { release = resolve; }));
  const second = await h.create();
  for (let index = 0; index < 200 && !release; index += 1) await delay(10);
  assert.ok(release);
  await h.action(first, first.outfits[0], "retry", { prompt: "Preserve the real sleeve shape." });
  release(Response.json({ output_text: JSON.stringify({ outfits: [plan()] }) }));
  const conflicted = await h.settled(second.id);
  assert.equal(conflicted.status, "failed");
  assert.match(conflicted.error, /while planning/);
  assert.equal(conflicted.outfits.length, 0);
  assert.equal((await h.settled(first.id)).outfits[0].status, "review");
  assert.equal(h.requests.filter((item) => item.kind === "edit").length, 2, "only the original and its explicit retry were generated");
});

test("accessory suggestions use the configured vision model and outfit photo, persist, and never edit originals", async (t) => {
  const h = await harness(t, { env: { OPENAI_VISION_MODEL: 'custom-vision' }, analysis: () => Response.json({ output_text: JSON.stringify({ suggestions: accessoryIdeas }) }) });
  const endpoint = `${API}/original-1/accessories`;
  const manifestBefore = await readFile(path.join(h.dataDir, 'outfits.json'));
  const initial = await h.request('GET', endpoint);
  assert.equal(initial.suggestions, null);
  assert.equal(h.requests.length, 0, 'opening a look must not trigger a paid request');
  const result = await h.request('POST', endpoint, {});
  assert.deepEqual(result.suggestions, accessoryIdeas);
  assert.equal(result.generating, false);
  assert.equal(h.requests.length, 1);
  const request = h.requests[0].request;
  assert.equal(request.model, 'custom-vision');
  assert.equal(request.text.format.name, 'outfit_accessories');
  const inputs = request.input[0].content.filter(item => item.type === 'input_image');
  assert.equal(inputs.length, 1, 'only the existing modeled outfit photo is sent');
  const photo = Buffer.from(inputs[0].image_url.split(',')[1], 'base64');
  assert.deepEqual(await sharp(photo).raw().toBuffer(), await sharp(h.output).raw().toBuffer());
  assert.match(request.input[0].content[0].text, /not claims that the person owns/);
  assert.deepEqual(await readFile(path.join(h.dataDir, 'outfits.json')), manifestBefore);
  assert.deepEqual(await readFile(path.join(h.dataDir, 'outfit-images/original-1.png')), h.output);
  assert.ok(h.requests.every(item => item.kind === 'analysis'));
  await h.restart({ viteOrder: true });
  assert.deepEqual((await h.request('GET', endpoint)).suggestions, accessoryIdeas);
  assert.deepEqual((await h.request('POST', endpoint, {})).suggestions, accessoryIdeas);
  assert.equal(h.requests.length, 1, 'reopening/reposting reuses saved text');
});

test("simultaneous accessory requests share a paid call and separate outfits retain their lists", async (t) => {
  const h = await harness(t, { analysis: async () => { await delay(30); return Response.json({ output_text: JSON.stringify({ suggestions: accessoryIdeas }) }); } });
  const a = `${API}/original-1/accessories`, b = `${API}/original-2/accessories`;
  const results = await Promise.all([h.request('POST', a, {}), h.request('POST', a, {}), h.request('POST', b, {})]);
  assert.ok(results.every(r => r.suggestions.length === 3));
  assert.equal(h.requests.length, 2);
  const cache = JSON.parse(await readFile(path.join(h.dataDir, 'outfit-accessories.json'), 'utf8'));
  assert.deepEqual(Object.keys(cache.outfits).sort(), ['original-1', 'original-2']);
});

test("accessory suggestions invalidate on photo or model change", async (t) => {
  const h = await harness(t, { analysis: () => Response.json({ output_text: JSON.stringify({ suggestions: accessoryIdeas }) }) });
  const endpoint = `${API}/original-1/accessories`;
  await h.request('POST', endpoint, {});
  const changedPhoto = await h.image('#123456');
  await writeFile(path.join(h.dataDir, 'outfit-images/original-1.png'), changedPhoto);
  assert.equal((await h.request('GET', endpoint)).suggestions, null);
  await h.request('POST', endpoint, {});
  const cacheFile = path.join(h.dataDir, 'outfit-accessories.json');
  const cache = JSON.parse(await readFile(cacheFile, 'utf8'));cache.outfits['original-1'].model = 'old-vision';await writeFile(cacheFile, JSON.stringify(cache));
  assert.equal((await h.request('GET', endpoint)).suggestions, null);
  await h.request('POST', endpoint, {});
  assert.equal(h.requests.length, 3);
  assert.deepEqual(await readFile(path.join(h.dataDir, 'outfit-images/original-1.png')), changedPhoto);
});

test("invalid, missing and cross-site accessory requests cannot call the provider", async (t) => {
  const h = await harness(t, { env: { OPENAI_API_KEY: '' } });
  await h.request('POST', `${API}/unknown/accessories`, {}, 404);
  await h.request('POST', `${API}/original-1/accessories`, {}, 403, { origin: 'https://other.invalid' });
  await h.request('POST', `${API}/original-1/accessories`, {}, 503);
  assert.equal(h.requests.length, 0);
});

test("accessory provider failures and malformed output are retryable without changing photos", async (t) => {
  const h = await harness(t, { analysis: () => Response.json({ error: { message: 'private provider message' } }, { status: 503 }) });
  const endpoint = `${API}/original-1/accessories`;
  const failed = await h.request('POST', endpoint, {}, 502);
  assert.ok(!failed.error.includes('private provider message'));
  for (const suggestions of [[], ['one'], ['same', 'same'], ['one', 2], ['one\ntwo', 'three']]) {
    h.setAnalysis(() => Response.json({ output_text: JSON.stringify({ suggestions }) }));
    await h.request('POST', endpoint, {}, 502);
    const state = await h.request('GET', endpoint);
    assert.equal(state.suggestions, null);assert.equal(state.generating, false);
  }
  h.setAnalysis(() => Response.json({ output: [{ content: [{ type: 'output_text', text: JSON.stringify({ suggestions: accessoryIdeas }) }] }] }));
  assert.deepEqual((await h.request('POST', endpoint, {})).suggestions, accessoryIdeas);
  assert.deepEqual(await readFile(path.join(h.dataDir, 'outfit-images/original-1.png')), h.output);
});

test("accessory response cannot be saved across an outfit photo change or restart", async (t) => {
  let release;
  const h = await harness(t, { analysis: () => new Promise(resolve => { release = () => resolve(Response.json({ output_text: JSON.stringify({ suggestions: accessoryIdeas }) })); }) });
  const endpoint = `${API}/original-1/accessories`;
  const changed = h.request('POST', endpoint, {}, 409);
  while (!release) await delay(2);
  assert.equal((await h.request('GET', endpoint)).generating, true);
  await writeFile(path.join(h.dataDir, 'outfit-images/original-1.png'), await h.image('#445566'));
  release();await changed;
  release = null;
  const interrupted = h.request('POST', endpoint, {}, null);
  while (!release) await delay(2);
  await h.restart({ viteOrder: true, freshModule: true });
  assert.equal((await interrupted).status, 503);
  release();await delay(10);
  const state = await h.request('GET', endpoint);
  assert.equal(state.suggestions, null);assert.equal(state.generating, false);
});

test("refused outfit photos expose the sent prompt and accept a manual photo through review without more model calls", async (t) => {
  const h = await harness(t, { edit: () => Response.json({ error: { code: "moderation_blocked", message: "Refused" } }, { status: 400 }) });
  const job = await h.settled((await h.create()).id);
  const outfit = job.outfits[0];
  assert.equal(outfit.status, "failed");
  assert.equal(outfit.generationPrompt, h.requests.find((entry) => entry.kind === "edit").form.get("prompt"));
  const calls = h.requests.length;
  const invalid = { imageDataUrl: `data:image/png;base64,${(await h.image("#887766", 900, 600)).toString("base64")}` };
  await h.action(job, outfit, "upload", invalid, 400);
  assert.equal((await h.request("GET", `${API}/jobs/${job.id}`)).outfits[0].status, "failed");
  const input = { imageDataUrl: `data:image/png;base64,${(await h.image("#887766", 1024, 1024)).toString("base64")}` };
  const uploaded = await h.action(job, outfit, "upload", input);
  assert.equal(uploaded.outfits[0].status, "review");
  assert.equal(uploaded.outfits[0].source, "uploaded");
  assert.equal((await h.request("GET", API)).outfits.length, h.originals.length);
  const variant = await h.request("GET", `${uploaded.outfits[0].image}?format=webp&w=640`, undefined, null);
  assert.equal(variant.headers["content-type"], "image/webp");
  assert.equal((await sharp(variant.result).metadata()).width, 640);
  await h.restart();
  const restored = await h.request("GET", `${API}/jobs/${job.id}`);
  assert.equal(restored.outfits[0].image, uploaded.outfits[0].image);
  await h.action(job, outfit, "reject");
  assert.equal((await h.request("GET", API)).outfits.length, h.originals.length);
  const replacement = await h.action(job, outfit, "upload", input);
  assert.notEqual(replacement.outfits[0].image, uploaded.outfits[0].image);
  const approved = await h.action(job, outfit, "approve");
  assert.equal(approved.outfits[0].status, "accepted");
  const collection = await h.request("GET", API);
  assert.equal(collection.outfits.length, h.originals.length + 1);
  assert.equal(h.requests.length, calls);
  await h.action(job, outfit, "upload", input, 409);
  assert.equal((await sharp(await h.request("GET", `${approved.outfits[0].image}?format=webp&w=640`)).metadata()).format, "webp");
});

test("reading outfit settings transfers no image bytes and real generation still validates images",async t=>{
  const {withStorage}=await import('./storage-fs.mjs');
  const h=await harness(t);const imageReads=[];
  const tracking={...fs,readFile:async(file,...args)=>{if(/\.(png|jpe?g|webp)$/i.test(file))imageReads.push(file);return fs.readFile(file,...args)}};
  const config=await withStorage(tracking,()=>h.request('GET',`${API}/config`));
  assert.equal(config.counts.upperbody,6);assert.equal(config.availableCombinations,18);
  assert.deepEqual(imageReads,[],'a settings request must not download full-resolution wardrobe/reference images');
  assert.equal(h.requests.length,0,'reading settings must not call a paid provider');
  await writeFile(path.join(h.dataDir,'imported','top-6.png'),'damaged image');
  await writeFile(path.join(h.dataDir,'library.json'),JSON.stringify(h.items.map(item=>item.id==='top-5'?{...item,hidden:true}:item)));
  const refreshed=await withStorage(tracking,()=>h.request('GET',`${API}/config`));
  assert.equal(refreshed.counts.upperbody,5,'metadata updates and hidden records are resolved on every request');
  const created=await withStorage(tracking,()=>h.create());await h.settled(created.id);
  assert.ok(imageReads.length>0,'generation retains image validation');
  const prompt=h.requests.find(r=>r.kind==='analysis').request.input[0].content[0].text;
  assert.ok(!prompt.includes('top-6'),'damaged images are excluded before paid curation');
  assert.ok(!prompt.includes('top-5'),'hidden images are excluded before paid curation');
});

test('empty accessory suggestions validate the saved image path without downloading it',async t=>{
  const {withStorage}=await import('./storage-fs.mjs');const h=await harness(t);let images=0;
  const tracking={...fs,readFile:async(file,...args)=>{if(/\.png$/i.test(file))images++;return fs.readFile(file,...args)}};
  const status=await withStorage(tracking,()=>h.request('GET',`${API}/original-1/accessories`));
  assert.equal(status.suggestions,null);assert.equal(images,0);
  await withStorage(tracking,()=>h.request('GET',`${API}/missing/accessories`,undefined,404));
  await rm(path.join(h.dataDir,'outfit-images','original-1.png'));
  await withStorage(tracking,()=>h.request('GET',`${API}/original-1/accessories`,undefined,404));assert.equal(images,0);
});
