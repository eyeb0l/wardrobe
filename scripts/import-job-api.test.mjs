import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import sharp from "sharp";
import { chooseChromaKey, hasCleanProductBackground, wardrobeImportApi } from "./import-job-api.mjs";
import { buildModeledPhotoPrompt, buildModeledSettingPrompt } from "./modeled-photo-prompts.mjs";

test("chroma selection protects either recorded garment color", () => {
  for (const [primary, secondary, expected] of [
    ["#00ff00", "#ff00ff", "#00ffff"],
    ["#ff00ff", "#00ffff", "#00ff00"],
    ["#00ffff", "#00ff00", "#ff00ff"],
  ]) {
    assert.equal(chooseChromaKey(primary, secondary), expected);
    assert.equal(chooseChromaKey(secondary, primary), expected);
  }
  assert.match(chooseChromaKey("invalid", null), /^#[0-9a-f]{6}$/);
});

async function harness(t, env = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wardrobe-model-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // Never read .env or allow a real network request in these tests.
  for (const name of ["OPENAI_IMAGE_MODEL", "OPENAI_VISION_MODEL", "OPENAI_GARMENT_MODEL", "OPENAI_MODELED_MODEL", "OPENAI_IMAGE_QUALITY"]) {
    const previous = process.env[name];
    delete process.env[name];
    t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
  }
  const source = await sharp({ create: { width: 96, height: 128, channels: 3, background: "#777777" } }).png().toBuffer();
  const identity = await sharp({ create: { width: 80, height: 100, channels: 3, background: "#aaaaaa" } }).png().toBuffer();
  await writeFile(path.join(root, "identity.png"), identity);
  const requests = [];
  let analysisResult = [{ name: "Grey top", part: "upperbody", color: "#777777", secondaryColor: null, tags: ["short sleeve"], boundingBox: { x: 100, y: 100, width: 800, height: 800 } }];
  let isCleanProductShot = false;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.ok(url.startsWith("https://wardrobe-test.invalid/"));
    assert.equal(options.headers.Authorization, "Bearer test-key");
    if (url.endsWith("/responses")) {
      const request = JSON.parse(options.body);
      if (request.text.format.name === "wardrobe_modeled_setting") {
        requests.push({ type: "setting", request });
        return Response.json({ output_text: JSON.stringify({ setting: `An invented location for photograph ${requests.filter(entry => entry.type === "setting").length}, with natural light and spatial depth.` }) });
      }
      requests.push({ type: "analysis", request });
      return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ items: analysisResult, isCleanProductShot }) }] }] });
    }
    assert.ok(url.endsWith("/images/edits"));
    const form = options.body;
    const images = await Promise.all(form.getAll("image[]").map(async (image) => ({ name: image.name, data: Buffer.from(await image.arrayBuffer()) })));
    requests.push({ type: "edit", form, images });
    let output = source;
    if (images.length === 1) {
      const key = form.get("prompt").match(/uniform solid (#[0-9a-f]{6})/)[1];
      const item = await sharp({ create: { width: 32, height: 40, channels: 3, background: "#777777" } }).png().toBuffer();
      output = await sharp({ create: { width: 64, height: 64, channels: 3, background: key } }).composite([{ input: item, left: 16, top: 12 }]).png().toBuffer();
    }
    return Response.json({ data: [{ b64_json: output.toString("base64") }] });
  });
  const plugin = wardrobeImportApi({ env: {
    OPENAI_API_KEY: "test-key", OPENAI_API_BASE_URL: "https://wardrobe-test.invalid",
    WARDROBE_DATA_DIR: path.join(root, "data"), WARDROBE_MODEL_REFERENCE: "identity.png", ...env,
  } });
  await plugin.configResolved({ root });
  let handler;
  plugin.configureServer({ middlewares: { use(value) { handler = value; } } });
  async function request(method, url, payload, expectedStatus) {
    const req = Readable.from(payload ? [Buffer.from(JSON.stringify(payload))] : []);
    Object.assign(req, { method, url, headers: payload ? { 'content-type': 'application/json' } : {} });
    let result;
    const res = { statusCode: 200, setHeader() {}, end(value) { result = Buffer.isBuffer(value) ? value : JSON.parse(value); } };
    await handler(req, res, () => assert.fail("Unexpected middleware fallthrough"));
    if (expectedStatus) assert.equal(res.statusCode, expectedStatus, JSON.stringify(result));
    else assert.ok(res.statusCode < 300, JSON.stringify(result));
    return result;
  }
  async function waitForStage(id, stage) {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const job = JSON.parse(await readFile(path.join(root, "data", "jobs", id, "job.json"), "utf8"));
      assert.notEqual(job.stages[stage].status, "failed", job.stages[stage].error);
      if (job.stages[stage].status === "review") return job;
      await delay(25);
    }
    assert.fail(`Timed out waiting for ${stage}`);
  }
  return { root, source, identity, requests, request, waitForStage, setAnalysis(value, clean = false) { analysisResult = value; isCleanProductShot = clean; }, async restart() { await plugin.configResolved({ root }); } };
}

const dress = { name: "Blue dress", part: "dresses", color: "#123456", secondaryColor: null, tags: ["sleeveless"], boundingBox: { x: 250, y: 200, width: 500, height: 600 } };

async function productImage(transparent = false) {
  const item = await sharp({ create: { width: 48, height: 72, channels: 4, background: "#123456" } }).png().toBuffer();
  return sharp({ create: { width: 96, height: 128, channels: 4, background: { r: 255, g: 255, b: 255, alpha: transparent ? 0 : 1 } } }).composite([{ input: item, left: 24, top: 28 }]).png().toBuffer();
}

test("background checks accept white/alpha product borders but reject blank or ordinary images", async () => {
  for (const transparent of [false, true]) assert.equal(await hasCleanProductBackground(await productImage(transparent)), true);
  for (const background of ["#ffffff", "#777777", { r: 0, g: 0, b: 0, alpha: 0 }]) {
    const blank = await sharp({ create: { width: 64, height: 64, channels: 4, background } }).png().toBuffer();
    assert.equal(await hasCleanProductBackground(blank), false);
  }
});

for (const transparent of [false, true]) {
  test(`original ${transparent ? "transparent" : "white"} dress skips extraction and survives review/restart unchanged`, async (t) => {
    const h = await harness(t);
    const source = await productImage(transparent);
    h.setAnalysis([dress], true);
    const { jobs: [job] } = await h.request("POST", "/api/import/jobs", { imageBase64: source.toString("base64") });
    assert.equal(job.canUseOriginal, true);
    assert.equal(job.metadata.part, "dresses");
    const schema = h.requests[0].request.text.format.schema;
    assert.ok(schema.required.includes("isCleanProductShot"));
    assert.ok(schema.properties.items.items.properties.part.enum.includes("dresses"));
    const selected = await h.request("POST", `/api/import/jobs/${job.id}/stages/crop/use-original`);
    assert.equal(h.requests.length, 1, "no image model called when selecting original");
    assert.equal(selected.stages.garment.status, "review");
    assert.equal(selected.stages.garment.source, "original");
    assert.equal(selected.stages.garment.attempts, 0);
    await h.restart();
    const restored = await h.request("GET", `/api/import/jobs/${job.id}`);
    assert.equal(restored.stages.garment.source, "original");
    assert.equal(h.requests.length, 1, "restart must not trigger extraction or modeled generation before approval");
    await h.request("POST", `/api/import/jobs/${job.id}/stages/crop/use-original`, undefined, 409);
    await h.request("PATCH", `/api/import/jobs/${job.id}/metadata`, { metadata: { name: "Edited dress", part: "dresses" } });
    await h.request("POST", `/api/import/jobs/${job.id}/stages/garment/approve`);
    await h.waitForStage(job.id, "modeled");
    const edits = h.requests.filter((entry) => entry.type === "edit");
    assert.equal(edits.length, 1);
    assert.equal(edits[0].images.length, 2, "only modeled generation is called");
    const originalRaw = await sharp(source).ensureAlpha().raw().toBuffer();
    assert.deepEqual(await sharp(edits[0].images[1].data).ensureAlpha().raw().toBuffer(), originalRaw);
    const records = await h.request("GET", "/api/import/wardrobe");
    assert.equal(records[0].part, "dresses");
    assert.equal(records[0].name, "Edited dress");
    const saved = await readFile(path.join(h.root, "data", "imported", `import-${job.id}-garment.png`));
    assert.deepEqual(await sharp(saved).ensureAlpha().raw().toBuffer(), originalRaw, "original dimensions, colors, white background and alpha remain unchanged");
  });
}

test("clean product shots can still choose extraction", async (t) => {
  const h = await harness(t);
  h.setAnalysis([dress], true);
  const { jobs: [job] } = await h.request("POST", "/api/import/jobs", { imageBase64: (await productImage()).toString("base64") });
  await h.request("POST", `/api/import/jobs/${job.id}/stages/crop/approve`);
  const extracted = await h.waitForStage(job.id, "garment");
  assert.equal(extracted.stages.garment.source, "generated");
  assert.equal(h.requests.filter((entry) => entry.type === "edit").length, 1);
});

test("ordinary photos, multiple items and uncertain classification cannot bypass extraction", async (t) => {
  const h = await harness(t);
  for (const scenario of [
    { items: [dress], clean: false, source: await productImage() },
    { items: [dress, { ...dress, name: "Second dress" }], clean: true, source: await productImage() },
    { items: [dress], clean: true, source: h.source },
  ]) {
    h.setAnalysis(scenario.items, scenario.clean);
    const { jobs } = await h.request("POST", "/api/import/jobs", { imageBase64: scenario.source.toString("base64"), canUseOriginal: true });
    for (const job of jobs) {
      assert.equal(job.canUseOriginal, false);
      await h.request("POST", `/api/import/jobs/${job.id}/stages/crop/use-original`, undefined, 409);
    }
  }
  assert.ok(h.requests.every((entry) => entry.type === "analysis"));
});

test("default models complete the import and review flow with ordered PNG references", async (t) => {
  const h = await harness(t);
  const created = await h.request("POST", "/api/import/jobs", { imageBase64: h.source.toString("base64") });
  const id = created.jobs[0].id;
  const analysis = h.requests[0].request;
  assert.equal(analysis.model, "gpt-5.6-luna");
  assert.equal(analysis.text.format.strict, true);
  assert.equal(analysis.text.format.schema.properties.items.maxItems, 8);
  assert.match(analysis.input[0].content[1].image_url, /^data:image\/png;base64,/);
  assert.equal(created.jobs[0].stages.crop.status, "review");
  await h.request("POST", `/api/import/jobs/${id}/stages/crop/approve`);
  await h.waitForStage(id, "garment");
  await h.request("POST", `/api/import/jobs/${id}/stages/garment/approve`);
  await h.waitForStage(id, "modeled");
  const edits = h.requests.filter((entry) => entry.type === "edit");
  assert.equal(edits.length, 2);
  for (const { form } of edits) {
    assert.equal(form.get("model"), "gpt-image-2.5-sunburst");
    assert.equal(form.get("quality"), "high");
    assert.equal(form.get("output_format"), "png");
    assert.equal(form.has("input_fidelity"), false);
  }
  assert.equal(edits[0].form.get("size"), "1024x1024");
  assert.deepEqual(edits[0].images.map((image) => image.name), ["crop.png"]);
  assert.equal(edits[1].form.get("size"), "1536x1024");
  assert.deepEqual(edits[1].images.map((image) => image.name), ["model.png", "garment.png"]);
  const plan = h.requests.find(entry => entry.type === "setting").request;
  assert.equal(plan.model, "gpt-5.6-luna");
  assert.equal(plan.input[0].content[0].text, buildModeledSettingPrompt({ metadata: created.jobs[0].metadata }));
  const plannedGarment = Buffer.from(plan.input[0].content[1].image_url.split(",")[1], "base64");
  assert.deepEqual(await sharp(plannedGarment).raw().toBuffer(), await sharp(edits[1].images[1].data).raw().toBuffer(), "scene planning inspects the exact reviewed garment");
  assert.deepEqual(await sharp(edits[1].images[0].data).raw().toBuffer(), await sharp(h.identity).raw().toBuffer());
  const garment = await sharp(edits[1].images[1].data).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(garment.data[3], 0, "cutout corner is transparent");
  assert.equal(garment.data[((512 * garment.info.width + 512) * 4) + 3], 255, "garment center is opaque");
  await h.request("POST", `/api/import/jobs/${id}/stages/modeled/approve`);
  const library = await h.request("GET", "/api/import/wardrobe");
  assert.equal(library.length, 1);
  assert.ok(library[0].modeledImage);
});

test("explicit per-stage models and quality remain configurable", async (t) => {
  const h = await harness(t, { OPENAI_VISION_MODEL: "gpt-5.4-mini", OPENAI_IMAGE_MODEL: "unused-global-model", OPENAI_GARMENT_MODEL: "gpt-image-2", OPENAI_MODELED_MODEL: "gpt-image-2.5-sunburst-2026-09-08", OPENAI_IMAGE_QUALITY: "medium" });
  const created = await h.request("POST", "/api/import/jobs", { imageBase64: h.source.toString("base64") });
  const id = created.jobs[0].id;
  assert.equal(h.requests[0].request.model, "gpt-5.4-mini");
  await h.request("POST", `/api/import/jobs/${id}/stages/crop/approve`);
  await h.waitForStage(id, "garment");
  await h.request("POST", `/api/import/jobs/${id}/stages/garment/approve`);
  await h.waitForStage(id, "modeled");
  const edits = h.requests.filter((entry) => entry.type === "edit");
  assert.deepEqual(edits.map(({ form }) => form.get("model")), ["gpt-image-2", "gpt-image-2.5-sunburst-2026-09-08"]);
  assert.ok(edits.every(({ form }) => form.get("quality") === "medium"));
  assert.equal(h.requests.find(entry => entry.type === "setting").request.model, "gpt-5.4-mini");
});

test("scene planning receives other items' settings and fails without an image call on invalid output", async (t) => {
  const h = await harness(t);
  h.setAnalysis([dress], true);
  const create = async () => {
    const { jobs: [job] } = await h.request("POST", "/api/import/jobs", { imageBase64: (await productImage()).toString("base64") });
    await h.request("POST", `/api/import/jobs/${job.id}/stages/crop/use-original`);
    return job;
  };
  const first = await create();
  await h.request("POST", `/api/import/jobs/${first.id}/stages/garment/approve`);
  const planned = await h.waitForStage(first.id, "modeled");
  const second = await create();
  const workingFetch = globalThis.fetch;
  let planPrompt;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url.endsWith("/responses") && JSON.parse(options.body).text.format.name === "wardrobe_modeled_setting") {
      planPrompt = JSON.parse(options.body).input[0].content[0].text;
      return Response.json({ output_text: JSON.stringify({ setting: "  " }) });
    }
    return workingFetch(url, options);
  });
  const editsBefore = h.requests.filter(entry => entry.type === "edit").length;
  await h.request("POST", `/api/import/jobs/${second.id}/stages/garment/approve`);
  let failed;
  for (let attempt = 0; attempt < 100; attempt++) {
    failed = await h.request("GET", `/api/import/jobs/${second.id}`);
    if (failed.stages.modeled.status === "failed") break;
    await delay(10);
  }
  assert.equal(failed.stages.modeled.status, "failed");
  assert.match(failed.stages.modeled.error, /Scene planning/);
  assert.equal(failed.stages.modeled.generationPrompt, null);
  assert.equal(h.requests.filter(entry => entry.type === "edit").length, editsBefore, "invalid scene never reaches image generation");
  assert.ok(JSON.parse(planPrompt.split("Context (JSON):\n")[1]).recentSettings.includes(planned.stages.modeled.setting));
});

test("empty vision results create no jobs or image requests", async (t) => {
  const h = await harness(t);
  h.setAnalysis([]);
  const created = await h.request("POST", "/api/import/jobs", { imageBase64: h.source.toString("base64") });
  assert.deepEqual(created, { jobs: [], noClothingDetected: true });
  assert.equal(h.requests.length, 1);
});

test("reference discovery keeps the configured default and finds numbered PNGs in numeric order", async (t) => {
  const h = await harness(t);
  for (const name of ["model-reference-10.png", "model-reference-3.png", "model-reference-2.png", "model-reference-1.png", "unrelated.png"]) {
    await writeFile(path.join(h.root, "data", name), h.identity);
  }
  await mkdir(path.join(h.root, "data", "model-reference-4.png"));
  await symlink(path.join(h.root, "identity.png"), path.join(h.root, "data", "model-reference-5.png"));
  const config = await h.request("GET", "/api/import/config");
  assert.equal(config.ready, true);
  assert.deepEqual(config.modelReferences.map((reference) => reference.id), ["default", "model-reference-2", "model-reference-3", "model-reference-10"]);
  assert.ok(config.modelReferences.every((reference) => !Object.hasOwn(reference, "path")));
  const preview = await h.request("GET", "/api/import/model-references/model-reference-2");
  assert.equal((await sharp(preview).metadata()).format, "png");
  await h.request("GET", "/api/import/model-references/model-reference-99", undefined, 400);
  await writeFile(path.join(h.root, "data", "model-reference-6.png"), h.identity);
  const refreshed = await h.request("GET", "/api/import/config");
  assert.ok(refreshed.modelReferences.some((reference) => reference.id === "model-reference-6"), "new photos appear without a server restart");
});

test("selected reference persists and is used for modeling and regeneration", async (t) => {
  const h = await harness(t);
  const alternate = await sharp({ create: { width: 80, height: 100, channels: 3, background: "#224466" } }).png().toBuffer();
  const alternatePath = path.join(h.root, "data", "model-reference-2.png");
  await writeFile(alternatePath, alternate);
  h.setAnalysis([dress], true);
  const { jobs: [job] } = await h.request("POST", "/api/import/jobs", { imageBase64: (await productImage()).toString("base64") });
  await h.request("POST", `/api/import/jobs/${job.id}/stages/crop/use-original`);
  const approve = `/api/import/jobs/${job.id}/stages/garment/approve`;
  for (const modelReferenceId of ["../../identity.png", "model-reference-99", 2]) {
    await h.request("POST", approve, { modelReferenceId }, 400);
  }
  assert.equal(h.requests.length, 1, "invalid references cannot start image generation");
  await h.request("POST", approve, { modelReferenceId: "model-reference-2" });
  await h.waitForStage(job.id, "modeled");
  let edits = h.requests.filter((entry) => entry.type === "edit");
  const initialScene = (await h.request("GET", `/api/import/jobs/${job.id}`)).stages.modeled.setting;
  assert.equal(initialScene, "An invented location for photograph 1, with natural light and spatial depth.");
  assert.equal(edits[0].form.get("prompt"), buildModeledPhotoPrompt({ setting: initialScene }));
  assert.deepEqual(await sharp(edits[0].images[0].data).raw().toBuffer(), await sharp(alternate).raw().toBuffer());
  await h.restart();
  const restored = await h.request("GET", `/api/import/jobs/${job.id}`);
  assert.equal(restored.modelReferenceId, "model-reference-2");
  assert.equal((await h.request("GET", "/api/import/wardrobe"))[0].modelReferenceId, "model-reference-2");
  // Retry without a new selection retains the chosen photo.
  const regenerate = `/api/import/jobs/${job.id}/stages/modeled/regenerate`;
  await h.request("POST", regenerate, { prompt: "Use neutral daylight" });
  await h.waitForStage(job.id, "modeled");
  edits = h.requests.filter((entry) => entry.type === "edit");
  const retryScene = (await h.request("GET", `/api/import/jobs/${job.id}`)).stages.modeled.setting;
  assert.notEqual(retryScene, initialScene, "regeneration changes the scene after restart");
  assert.match(edits[1].form.get("prompt"), /User regeneration direction: Use neutral daylight/);
  const retryPlan = h.requests.filter(entry => entry.type === "setting").at(-1).request;
  const planContext = JSON.parse(retryPlan.input[0].content[0].text.split("Context (JSON):\n")[1]);
  assert.equal(planContext.previousSetting, initialScene);
  assert.ok(planContext.recentSettings.includes(initialScene));
  assert.equal(planContext.userDirection, "Use neutral daylight");
  assert.equal(edits[1].form.get("prompt"), buildModeledPhotoPrompt({ setting: retryScene, direction: "Use neutral daylight" }));
  assert.deepEqual(await sharp(edits[1].images[0].data).raw().toBuffer(), await sharp(alternate).raw().toBuffer());
  // Removing it never silently switches the person/reference back to default.
  await rm(alternatePath);
  await h.request("POST", regenerate, {}, 400);
  await h.request("POST", regenerate, { modelReferenceId: "default" });
  await h.waitForStage(job.id, "modeled");
  edits = h.requests.filter((entry) => entry.type === "edit");
  assert.deepEqual(await sharp(edits[2].images[0].data).raw().toBuffer(), await sharp(h.identity).raw().toBuffer());
  assert.equal((await h.request("GET", `/api/import/jobs/${job.id}`)).modelReferenceId, "default");
});

test("saved modeled shots reopen, regenerate and replace only after approval", async (t) => {
  const h = await harness(t);
  h.setAnalysis([dress], true);
  const { jobs: [job] } = await h.request("POST", "/api/import/jobs", { imageBase64: (await productImage()).toString("base64") });
  const jobUrl = `/api/import/jobs/${job.id}`;
  const itemUrl = `/api/import/wardrobe/import-${job.id}/modeled`;
  await h.request("POST", `${jobUrl}/stages/crop/use-original`);
  await h.request("POST", `${jobUrl}/stages/garment/approve`);
  await h.waitForStage(job.id, "modeled");
  await h.request("POST", `${jobUrl}/stages/modeled/approve`);
  await h.request("GET", jobUrl, undefined, 404);
  const [original] = await h.request("GET", "/api/import/wardrobe");
  const garment = await h.request("GET", original.image);
  const previousShot = await h.request("GET", original.modeledImage);
  const callCount = h.requests.length;
  const [opened, repeated] = await Promise.all([h.request("POST", itemUrl), h.request("POST", itemUrl)]);
  assert.equal(opened.generationId, repeated.generationId, "opening twice resumes one replacement job");
  assert.equal(opened.stages.modeled.status, "ready");
  assert.equal(opened.stages.modeled.assetUrl, original.modeledImage);
  assert.equal(opened.stages.modeled.setting, original.modeledSetting);
  await h.restart();
  assert.equal(h.requests.length, callCount, "opening and restarting do not spend a generation");
  await h.request("POST", `${jobUrl}/stages/modeled/approve`, undefined, 409);
  await h.request("POST", `${jobUrl}/stages/garment/regenerate`, {}, 409);
  await writeFile(path.join(h.root, "data", "model-reference-2.png"), h.source);
  await h.request("POST", `${jobUrl}/stages/modeled/regenerate`, { modelReferenceId: "model-reference-2", prompt: "Show the full garment in daylight" });
  await h.waitForStage(job.id, "modeled");
  const lastRequest = h.requests.at(-1);
  const replacementScene = (await h.request("GET", jobUrl)).stages.modeled.setting;
  assert.notEqual(replacementScene, original.modeledSetting, "replacement advances from the approved scene");
  assert.deepEqual(lastRequest.images[0].data, h.source);
  assert.deepEqual(lastRequest.images[1].data, garment);
  assert.match(lastRequest.form.get("prompt"), /Show the full garment in daylight/);
  assert.deepEqual(await h.request("GET", "/api/import/wardrobe"), [original], "pending replacement keeps saved item untouched");
  await h.request("POST", `${jobUrl}/stages/modeled/reject`);
  assert.deepEqual(await h.request("GET", "/api/import/wardrobe"), [original], "rejecting keeps the original shot");
  await h.request("POST", itemUrl);
  const workingFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Image service unavailable"); });
  await h.request("POST", `${jobUrl}/stages/modeled/regenerate`, { modelReferenceId: "model-reference-2" });
  let failed;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    failed = await h.request("GET", jobUrl);
    if (failed.stages.modeled.status === "failed") break;
    await delay(10);
  }
  assert.equal(failed.stages.modeled.status, "failed");
  assert.match(failed.stages.modeled.error, /Image service unavailable/);
  assert.deepEqual(await h.request("GET", "/api/import/wardrobe"), [original], "generation failure preserves the original shot");
  t.mock.method(globalThis, "fetch", workingFetch);
  await h.request("POST", `${jobUrl}/stages/modeled/regenerate`, { modelReferenceId: "model-reference-2" });
  await h.waitForStage(job.id, "modeled");
  const approved = await h.request("POST", `${jobUrl}/stages/modeled/approve`);
  const [updated] = await h.request("GET", "/api/import/wardrobe");
  assert.notEqual(updated.modeledImage, original.modeledImage, "new URL prevents stale image caches");
  assert.equal(approved.libraryItem.modeledImage, updated.modeledImage);
  assert.match(updated.modeledSetting, /^An invented location/);
  assert.deepEqual({ ...updated, modeledImage: original.modeledImage, modelReferenceId: original.modelReferenceId, modeledSetting: original.modeledSetting }, original);
  assert.deepEqual(await h.request("GET", updated.image), garment);
  assert.deepEqual(await h.request("GET", original.modeledImage), previousShot, "original file is preserved");
  await h.restart();
  assert.deepEqual(await h.request("GET", "/api/import/wardrobe"), [updated]);
  assert.deepEqual(await h.request("GET", "/api/import/jobs"), []);
  await h.request("POST", "/api/import/wardrobe/import-00000000-0000-0000-0000-000000000000/modeled", undefined, 404);
  await h.request("DELETE", `/api/import/wardrobe/${updated.id}`, { revision: updated.revision });
  assert.deepEqual(await h.request("GET", "/api/import/wardrobe"), []);
  await h.request("GET", updated.modeledImage, undefined, 404);
  await h.request("GET", original.modeledImage, undefined, 404);
});

test("a refused modeled shot exposes the exact prompt and manual uploads require approval, survive restart and serve WebP", async (t) => {
  const h = await harness(t);
  h.setAnalysis([dress], true);
  const { jobs: [job] } = await h.request("POST", "/api/import/jobs", { imageBase64: (await productImage()).toString("base64") });
  const jobUrl = `/api/import/jobs/${job.id}`;
  const upload = `${jobUrl}/stages/modeled/upload`;
  const photo = await sharp({ create: { width: 900, height: 600, channels: 3, background: "#887766" } }).jpeg().toBuffer();
  const input = { imageDataUrl: `data:image/jpeg;base64,${photo.toString("base64")}` };
  await h.request("POST", upload, input, 409);
  await h.request("POST", `${jobUrl}/stages/crop/use-original`);
  await h.request("POST", `${jobUrl}/stages/garment/approve`);
  await h.waitForStage(job.id, "modeled");
  await h.request("POST", `${jobUrl}/stages/modeled/approve`);
  const [original] = await h.request("GET", "/api/import/wardrobe");
  const originalBytes = await h.request("GET", original.modeledImage);
  await h.request("POST", `/api/import/wardrobe/import-${job.id}/modeled`);
  let sentPrompt;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    if (_url.endsWith("/responses")) return Response.json({ output_text: JSON.stringify({ setting: "A newly imagined riverside location." }) });
    sentPrompt = options.body.get("prompt");
    return Response.json({ error: { code: "moderation_blocked", message: "Image request refused" } }, { status: 400 });
  });
  await h.request("POST", `${jobUrl}/stages/modeled/regenerate`, { prompt: "Keep the complete dress visible" });
  let failed;
  for (let i = 0; i < 100; i++) {
    failed = await h.request("GET", jobUrl);
    if (failed.stages.modeled.status === "failed") break;
    await delay(10);
  }
  assert.equal(failed.stages.modeled.status, "failed");
  assert.equal(failed.stages.modeled.generationPrompt, sentPrompt);
  assert.match(sentPrompt, /Keep the complete dress visible/);
  t.mock.method(globalThis, "fetch", () => assert.fail("Manual uploads must not call a model"));
  await h.request("POST", upload, { imageDataUrl: `data:image/png;base64,${h.source.toString("base64")}` }, 400);
  assert.equal((await h.request("GET", jobUrl)).stages.modeled.status, "failed");
  const reviewed = await h.request("POST", upload, input);
  assert.equal(reviewed.stages.modeled.status, "review");
  assert.equal(reviewed.stages.modeled.source, "uploaded");
  assert.equal(reviewed.stages.modeled.setting, null, "an uploaded photo does not inherit generated scene metadata");
  assert.deepEqual(await h.request("GET", "/api/import/wardrobe"), [original]);
  const display = await h.request("GET", `${reviewed.stages.modeled.assetUrl}?format=webp&w=640`);
  assert.equal((await sharp(display).metadata()).format, "webp");
  assert.equal((await sharp(display).metadata()).width, 640);
  await h.restart();
  assert.equal((await h.request("GET", jobUrl)).stages.modeled.assetUrl, reviewed.stages.modeled.assetUrl);
  await h.request("POST", `${jobUrl}/stages/modeled/reject`);
  assert.deepEqual(await h.request("GET", "/api/import/wardrobe"), [original]);
  await h.request("POST", `/api/import/wardrobe/import-${job.id}/modeled`);
  await h.request("POST", upload, input);
  const approved = await h.request("POST", `${jobUrl}/stages/modeled/approve`);
  assert.notEqual(approved.libraryItem.modeledImage, original.modeledImage);
  const saved = await h.request("GET", approved.libraryItem.modeledImage);
  assert.equal((await sharp(saved).metadata()).width, 900);
  assert.deepEqual(await h.request("GET", original.modeledImage), originalBytes);
  assert.equal((await sharp(await h.request("GET", `${approved.libraryItem.modeledImage}?format=webp&w=640`)).metadata()).format, "webp");
});
