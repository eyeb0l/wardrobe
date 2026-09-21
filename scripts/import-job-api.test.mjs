import { readTelemetry, summarizeTelemetry } from "./generation-telemetry.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import * as fileSystem from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import sharp from "sharp";
import { chooseChromaKey, hasCleanProductBackground, wardrobeImportApi } from "./import-job-api.mjs";
import { buildModeledPhotoPrompt, buildModeledSettingPrompt } from "./modeled-photo-prompts.mjs";
import { withStorage } from "./storage-fs.mjs";

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

async function harness(t, env = {}, beforePaidCall) {
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
  const imageReads = [];
  let failCandidateSave = false;
  const storage = { ...fileSystem, async readFile(filename, ...args) {
    const bytes = await fileSystem.readFile(filename, ...args);
    if (/\.(?:png|jpe?g|webp)$/i.test(String(filename))) imageReads.push({ file: String(filename), bytes: Buffer.byteLength(bytes) });
    return bytes;
  }, async writeFile(filename, data, ...args) {
    if (failCandidateSave && String(filename).includes("job.json") && String(data).includes('"detectionRetry":')) {
      failCandidateSave = false;
      throw Object.assign(new Error("Simulated candidate persistence failure"), { code: "EIO" });
    }
    return fileSystem.writeFile(filename, data, ...args);
  } };
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
  const plugin = wardrobeImportApi({ beforePaidCall, env: {
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
    await withStorage(storage, () => handler(req, res, () => assert.fail("Unexpected middleware fallthrough")));
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
  return { root, source, identity, requests, imageReads, request, waitForStage, failNextCandidateSave() { failCandidateSave = true; }, setAnalysis(value, clean = false) { analysisResult = value; isCleanProductShot = clean; }, async restart() { await plugin.configResolved({ root }); } };
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
  test(`original ${transparent ? "transparent" : "white"} dress skips extraction and keeps its pixels through review/restart`, async (t) => {
    const h = await harness(t);
    const source = await productImage(transparent);
    h.setAnalysis([dress], true);
    const { jobs: [job] } = await h.request("POST", "/api/import/jobs", { imageBase64: source.toString("base64") });
    assert.equal(job.canUseOriginal, true);
    assert.equal(job.metadata.part, "dresses");
    const schema = h.requests[0].request.text.format.schema;
    assert.ok(schema.required.includes("isCleanProductShot"));
    assert.ok(schema.properties.items.items.properties.part.enum.includes("dresses"));
    const alpha = await sharp(await productImage(true)).extractChannel(3).png().toBuffer();
    if (!transparent) await h.request("POST", `/api/import/jobs/${job.id}/stages/crop/use-original`, {}, 400);
    const selected = await h.request("POST", `/api/import/jobs/${job.id}/stages/crop/use-original`, transparent ? {} : { maskDataUrl: `data:image/png;base64,${alpha.toString("base64")}` });
    assert.equal(selected.stages.garment.backgroundRemoved, !transparent);
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
    const mask = await sharp(alpha).greyscale().raw().toBuffer();
    if (!transparent) for (let p = 0; p < mask.length; p++) originalRaw[p * 4 + 3] = mask[p];
    assert.deepEqual(await sharp(edits[0].images[1].data).ensureAlpha().raw().toBuffer(), originalRaw);
    const records = await h.request("GET", "/api/import/wardrobe");
    assert.equal(records[0].part, "dresses");
    assert.equal(records[0].name, "Edited dress");
    const saved = await readFile(path.join(h.root, "data", "imported", `import-${job.id}-garment.png`));
    assert.deepEqual(await sharp(saved).ensureAlpha().raw().toBuffer(), originalRaw, "original dimensions and RGB are preserved; only an opaque background becomes transparent");
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

test("modeled generation reads only its garment and reference inputs, without downloading the unused source", async (t) => {
  const h = await harness(t);
  const { jobs: [job] } = await h.request("POST", "/api/import/jobs", { imageBase64: h.source.toString("base64") });
  await h.request("POST", `/api/import/jobs/${job.id}/stages/crop/approve`);
  const extracted = await h.waitForStage(job.id, "garment");
  const garmentName = path.basename(extracted.stages.garment.assetUrl);
  const garment = await readFile(path.join(h.root, "data", "jobs", job.id, garmentName));
  h.imageReads.length = 0;
  await h.request("POST", `/api/import/jobs/${job.id}/stages/garment/approve`);
  await h.waitForStage(job.id, "modeled");
  assert.equal(h.imageReads.filter(({ file }) => path.basename(file) === extracted.internal.originalFile).length, 0, "modeled attempts do not read original upload bodies");
  assert.deepEqual(h.imageReads.map(({ file }) => path.basename(file)).sort(), [garmentName, "identity.png"].sort());
  const edit = h.requests.filter((entry) => entry.type === "edit").at(-1);
  assert.deepEqual(edit.images, [{ name: "model.png", data: h.identity }, { name: "garment.png", data: garment }], "provider input images and order are unchanged");
  assert.equal(edit.form.get("quality"), "high");
  assert.equal(edit.form.get("size"), "1536x1024");
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
    const { jobs: [job] } = await h.request("POST", "/api/import/jobs", { imageBase64: (await productImage(true)).toString("base64") });
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
  const { jobs: [job] } = await h.request("POST", "/api/import/jobs", { imageBase64: (await productImage(true)).toString("base64") });
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
  const { jobs: [job] } = await h.request("POST", "/api/import/jobs", { imageBase64: (await productImage(true)).toString("base64") });
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
  const { jobs: [job] } = await h.request("POST", "/api/import/jobs", { imageBase64: (await productImage(true)).toString("base64") });
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
  const records = await readTelemetry(path.join(h.root, "data"));
  const refused = records.find(event => event.outcome === "refused");
  assert.equal(refused.garments[0].id, `import-${job.id}`);
  assert.equal(refused.garments[0].category, "dresses");
  assert.equal(refused.apiCode, "moderation_blocked");
  assert.equal(refused.attemptNumber, 1);
  const stats = summarizeTelemetry(records).overall;
  assert.equal(stats.manualUploadEpisodes, 2);
  assert.equal(stats.manualApprovedEpisodes, 1);
  assert.equal(stats.manualAfterRefusalEpisodes, 1);

  assert.equal((await sharp(await h.request("GET", `${approved.libraryItem.modeledImage}?format=webp&w=640`)).metadata()).format, "webp");
});


test("import analysis and scene planning reserve text separately from each generated image", async t => {
  const reservations = [];
  const h = await harness(t, {}, async kind => reservations.push(kind));
  const created = await h.request("POST", "/api/import/jobs", { imageBase64: h.source.toString("base64") });
  const job = created.jobs[0];
  await h.request("POST", `/api/import/jobs/${job.id}/stages/crop/approve`, {});
  await h.waitForStage(job.id, "garment");
  await h.request("POST", `/api/import/jobs/${job.id}/stages/garment/approve`, {});
  await h.waitForStage(job.id, "modeled");
  assert.deepEqual(reservations, ["text", "image", "text", "image"]);
});

test("Terra retry reviews full-source candidates without replacing the current crop or spending twice", async t => {
  const reservations = [];
  const h = await harness(t, {}, async kind => reservations.push(kind));
  const originalImage = await productImage(true);
  const created = await h.request("POST", "/api/import/jobs", { imageBase64: originalImage.toString("base64") });
  const job = created.jobs[0];
  const initialCrop = await h.request("GET", job.stages.crop.assetUrl);
  h.setAnalysis([dress], true);
  const base = `/api/import/jobs/${job.id}`;
  const requestId = "00000000-0000-4000-8000-000000000001";
  const [review, duplicate] = await Promise.all([
    h.request("POST", `${base}/detection/retry`, { requestId }),
    h.request("POST", `${base}/detection/retry`, { requestId }),
  ]);
  assert.deepEqual(duplicate, review);
  assert.equal(review.detectionRetry.candidates.length, 1);
  assert.equal(review.detectionRetry.candidates[0].metadata.name, dress.name);
  assert.equal(review.detectionRetry.candidates[0].canUseOriginal, true);
  assert.deepEqual(review.metadata, job.metadata);
  assert.deepEqual(review.stages, job.stages);
  assert.deepEqual(await h.request("GET", job.stages.crop.assetUrl), initialCrop);
  assert.equal(h.requests.length, 2);
  assert.deepEqual(reservations, ["text", "text"]);
  const [normal, retry] = h.requests.map(entry => entry.request);
  assert.equal(normal.model, "gpt-5.6-luna");
  assert.equal(normal.reasoning, undefined);
  assert.equal(retry.model, "gpt-5.6-terra");
  assert.deepEqual(retry.reasoning, { effort: "medium" });
  assert.equal(retry.max_output_tokens, 16384);
  assert.deepEqual(retry.input, normal.input, "same full original, prompt and image bytes");
  assert.deepEqual(retry.text, normal.text);
  await h.restart();
  assert.deepEqual((await h.request("GET", base)).detectionRetry, review.detectionRetry);
  assert.equal(h.requests.length, 2, "restart must not repeat detection");
  await h.request("POST", `${base}/stages/crop/approve`, {}, 409);
  await h.request("POST", `${base}/detection/retry`, { requestId: "00000000-0000-4000-8000-000000000002" }, 409);
  const selection = { retryId: requestId, candidateId: review.detectionRetry.candidates[0].id };
  await h.request("POST", `${base}/detection/accept`, { ...selection, candidateId: "missing" }, 400);
  const accepted = await h.request("POST", `${base}/detection/accept`, selection);
  assert.equal(accepted.metadata.name, dress.name);
  assert.equal(accepted.canUseOriginal, true);
  assert.equal(accepted.detectionRetry, undefined);
  assert.equal(accepted.stages.crop.status, "review");
  assert.equal(accepted.stages.garment.status, "pending");
  assert.deepEqual(await h.request("POST", `${base}/detection/accept`, selection), accepted);
  assert.equal(h.requests.length, 2, "accepting a candidate never generates an image");
  await h.request("POST", `${base}/stages/crop/use-original`);
  await h.request("POST", `${base}/detection/retry`, { requestId: "00000000-0000-4000-8000-000000000003" }, 409);
  assert.equal(h.requests.length, 2);
});

test("keeping the current detection and empty Terra results preserve all existing items", async t => {
  const h = await harness(t);
  h.setAnalysis([dress, { ...dress, name: "Second item", part: "accessories_up" }]);
  const { jobs } = await h.request("POST", "/api/import/jobs", { imageBase64: h.source.toString("base64") });
  const base = `/api/import/jobs/${jobs[0].id}`;
  h.setAnalysis([]);
  const requestId = "00000000-0000-4000-8000-000000000004";
  const review = await h.request("POST", `${base}/detection/retry`, { requestId });
  assert.deepEqual(review.detectionRetry.candidates, []);
  assert.deepEqual((await h.request("GET", `/api/import/jobs/${jobs[1].id}`)), jobs[1]);
  await h.request("POST", `${base}/detection/accept`, { retryId: requestId, candidateId: "missing" }, 400);
  await h.request("POST", `${base}/detection/discard`, { retryId: "stale" }, 409);
  const kept = await h.request("POST", `${base}/detection/discard`, { retryId: requestId });
  assert.deepEqual(kept.metadata, jobs[0].metadata);
  assert.deepEqual(kept.stages, jobs[0].stages);
  assert.equal(kept.detectionRetry, undefined);
  await h.request("POST", `${base}/detection/retry`, { requestId }, 409);
  assert.equal(h.requests.length, 2, "discarded request cannot be replayed for a second charge");
});

test("malformed Terra responses fail without replacing the crop and never retry automatically", async t => {
  const h = await harness(t);
  const { jobs: [job] } = await h.request("POST", "/api/import/jobs", { imageBase64: h.source.toString("base64") });
  const base = `/api/import/jobs/${job.id}`;
  const requestId = "00000000-0000-4000-8000-000000000005";
  h.setAnalysis([{ ...dress, boundingBox: { x: 950, y: 0, width: 200, height: 100 } }]);
  await h.request("POST", `${base}/detection/retry`, { requestId }, 502);
  const failed = await h.request("GET", base);
  assert.deepEqual(failed.metadata, job.metadata);
  assert.deepEqual(failed.stages, job.stages);
  assert.equal(failed.detectionRetry, undefined);
  assert.equal(failed.detectionRetryAttempt.status, "failed");
  await h.restart();
  await h.request("POST", `${base}/detection/retry`, { requestId }, 409);
  assert.equal(h.requests.length, 2);
  h.setAnalysis([dress]);
  const retried = await h.request("POST", `${base}/detection/retry`, { requestId: "00000000-0000-4000-8000-000000000006" });
  assert.equal(retried.detectionRetry.candidates.length, 1);
});

test("quota denial and invalid retry IDs prevent Terra dispatch", async t => {
  let calls = 0;
  const h = await harness(t, {}, async () => {
    if (++calls > 1) throw Object.assign(new Error("Daily quota reached"), { status: 429 });
  });
  const { jobs: [job] } = await h.request("POST", "/api/import/jobs", { imageBase64: h.source.toString("base64") });
  const base = `/api/import/jobs/${job.id}`;
  await h.request("POST", `${base}/detection/retry`, {}, 400);
  await h.request("POST", `${base}/detection/retry`, { requestId: "../bad" }, 400);
  await h.request("POST", `${base}/detection/retry`, { requestId: "00000000-0000-4000-8000-000000000007" }, 429);
  assert.equal(h.requests.length, 1);
  assert.deepEqual((await h.request("GET", base)).stages, job.stages);
});

test("empty initial detection can explicitly use fixed Terra medium, while model injection is rejected", async t => {
  const h = await harness(t, { OPENAI_VISION_MODEL: "custom-default-model" });
  h.setAnalysis([]);
  const imageBase64 = h.source.toString("base64");
  const empty = await h.request("POST", "/api/import/jobs", { imageBase64 });
  assert.equal(empty.noClothingDetected, true);
  assert.equal(h.requests[0].request.model, "custom-default-model");
  await h.request("POST", "/api/import/jobs", { imageBase64, detectionModel: "gpt-5.6-sol" }, 400);
  h.setAnalysis([dress]);
  const retry = await h.request("POST", "/api/import/jobs", { imageBase64, detectionModel: "terra" });
  assert.equal(retry.jobs.length, 1);
  assert.equal(retry.jobs[0].detectionModel, "gpt-5.6-terra");
  assert.equal(retry.jobs[0].detectionEffort, "medium");
  assert.equal(h.requests[1].request.model, "gpt-5.6-terra");
  assert.deepEqual(h.requests[1].request.reasoning, { effort: "medium" });
});

test("older detection request IDs remain spent after subsequent retries and restart", async t => {
  const h = await harness(t);
  const { jobs: [job] } = await h.request("POST", "/api/import/jobs", { imageBase64: h.source.toString("base64") });
  const base = `/api/import/jobs/${job.id}`;
  const ids = ["00000000-0000-4000-8000-000000000020", "00000000-0000-4000-8000-000000000021"];
  for (const requestId of ids) {
    await h.request("POST", `${base}/detection/retry`, { requestId });
    await h.request("POST", `${base}/detection/discard`, { retryId: requestId });
  }
  await h.restart();
  for (const requestId of ids) await h.request("POST", `${base}/detection/retry`, { requestId }, 409);
  assert.equal(h.requests.length, 3);
});

test("candidate persistence failure leaves original review recoverable and reserves the retry identity", async t => {
  const h = await harness(t);
  const { jobs: [job] } = await h.request("POST", "/api/import/jobs", { imageBase64: h.source.toString("base64") });
  const base = `/api/import/jobs/${job.id}`;
  const requestId = "00000000-0000-4000-8000-000000000022";
  h.setAnalysis([dress]);
  h.failNextCandidateSave();
  await h.request("POST", `${base}/detection/retry`, { requestId }, 502);
  await h.restart();
  const after = await h.request("GET", base);
  assert.deepEqual(after.metadata, job.metadata);
  assert.deepEqual(after.stages, job.stages);
  assert.equal(after.detectionRetry, undefined);
  await h.request("POST", `${base}/detection/retry`, { requestId }, 409);
  assert.equal(h.requests.length, 2);
});

test("modeled retry telemetry skips scene-planning failures and keeps image attempt numbers", async t => {
  const h = await harness(t);
  h.setAnalysis([{ ...dress, name: 'Blue bodysuit', part: 'wholebody_up' }], true);
  const { jobs: [job] } = await h.request('POST', '/api/import/jobs', { imageBase64: (await productImage(true)).toString('base64') });
  const url = `/api/import/jobs/${job.id}`;
  await h.request('POST', `${url}/stages/crop/use-original`);
  let images = 0, planningFails = false;
  t.mock.method(globalThis, 'fetch', async endpoint => {
    if (endpoint.endsWith('/responses')) return planningFails
      ? Response.json({ error: { code: 'server_error' } }, { status: 500 })
      : Response.json({ output_text: JSON.stringify({ setting: 'A naturally lit room.' }) });
    images++;
    return images === 1 ? Response.json({ error: { code: 'moderation_blocked' } }, { status: 400 })
      : Response.json({ data: [{ b64_json: h.source.toString('base64') }] });
  });
  async function waitForFailure() {
    for (let i = 0; i < 100; i++) {
      if ((await h.request('GET', url)).stages.modeled.status === 'failed') return;
      await delay(10);
    }
    assert.fail('Expected failed modeled stage');
  }
  await h.request('POST', `${url}/stages/garment/approve`);
  await waitForFailure();
  planningFails = true;
  await h.request('POST', `${url}/stages/modeled/regenerate`, {});
  await waitForFailure();
  assert.equal((await readTelemetry(path.join(h.root, 'data'))).length, 1);
  planningFails = false;
  await h.request('POST', `${url}/stages/modeled/regenerate`, {});
  await h.waitForStage(job.id, 'modeled');
  // Stage state is saved before the best-effort telemetry completion.
  let records;
  for (let i = 0; i < 100; i++) {
    records = (await readTelemetry(path.join(h.root, 'data'))).sort((a, b) => a.attemptNumber - b.attemptNumber);
    if (records[1]?.outcome === 'succeeded') break;
    await delay(10);
  }
  assert.deepEqual(records.map(e => e.attemptNumber), [1, 2]);
  assert.deepEqual(records.map(e => e.pipelineAttempt), [1, 3]);
  assert.equal(records[0].episodeId, records[1].episodeId);
  const report = summarizeTelemetry(records);
  assert.equal(report.overall.secondAttemptRecovery.rate, 1);
  assert.equal(report.cohorts.find(c => c.category === 'subtype:bodysuit').eventualRetryRecovery.rate, 1);
});

test('transparent product is suggested even when vision says false; vision sees white and storage retains alpha', async t => {
  const h = await harness(t);
  const source = await productImage(true);
  h.setAnalysis([{ ...dress, name: 'Tote bag', part: 'accessories_up' }], false);
  const { jobs: [job] } = await h.request('POST', '/api/import/jobs', { imageBase64: source.toString('base64') });
  assert.equal(job.canUseOriginal, true);
  const sent = Buffer.from(h.requests[0].request.input[0].content[1].image_url.split(',')[1], 'base64');
  const sample = await sharp(sent).ensureAlpha().raw().toBuffer();
  assert.deepEqual([...sample.subarray(0, 4)], [255, 255, 255, 255]);
  const result = await h.request('POST', `/api/import/jobs/${job.id}/stages/crop/use-original`);
  assert.equal(result.stages.garment.backgroundRemoved, false);
  const stored = await h.request('GET', result.stages.garment.assetUrl);
  assert.deepEqual(await sharp(stored).raw().toBuffer(), await sharp(source).raw().toBuffer());
  assert.equal(h.requests.length, 1);
});

test('manual original override accepts a reviewed browser mask without a paid extraction', async t => {
  const h = await harness(t);
  h.setAnalysis([dress], false);
  const { jobs: [job] } = await h.request('POST', '/api/import/jobs', { imageBase64: (await productImage()).toString('base64') });
  assert.equal(job.canUseOriginal, false);
  const endpoint = `/api/import/jobs/${job.id}/stages/crop/use-original`;
  await h.request('POST', endpoint, { confirmOriginal: true }, 400);
  await h.request('POST', endpoint, { confirmOriginal: true, maskDataUrl: 'invalid' }, 400);
  assert.equal((await h.request('GET', `/api/import/jobs/${job.id}`)).stages.crop.status, 'review');
  const mask = await sharp(await productImage(true)).extractChannel(3).png().toBuffer();
  const result = await h.request('POST', endpoint, { confirmOriginal: true, maskDataUrl: `data:image/png;base64,${mask.toString('base64')}` });
  assert.equal(result.stages.garment.status, 'review');
  assert.equal(result.stages.garment.backgroundRemoved, true);
  assert.equal(h.requests.length, 1);
  await h.restart();
  assert.equal((await h.request('GET', `/api/import/jobs/${job.id}`)).stages.garment.backgroundRemoved, true);
});
