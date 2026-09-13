import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import sharp from "sharp";
import { chooseChromaKey, hasCleanProductBackground, wardrobeImportApi } from "./import-job-api.mjs";

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
    Object.assign(req, { method, url });
    let result;
    const res = { statusCode: 200, setHeader() {}, end(value) { result = JSON.parse(value); } };
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
});

test("empty vision results create no jobs or image requests", async (t) => {
  const h = await harness(t);
  h.setAnalysis([]);
  const created = await h.request("POST", "/api/import/jobs", { imageBase64: h.source.toString("base64") });
  assert.deepEqual(created, { jobs: [], noClothingDetected: true });
  assert.equal(h.requests.length, 1);
});
