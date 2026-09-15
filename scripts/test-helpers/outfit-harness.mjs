import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import sharp from "sharp";
import { wardrobeOutfitApi } from "../outfit-api.mjs";

const API = "/api/outfits";
const accessoryIdeas = ["Small gold hoops to echo the warm tones.", "A compact brown leather bag for a polished finish.", "A slim watch with a simple cream dial."];
const plan = (number = 1, garmentIds = ["top-3", `bottom-${number}`]) => ({
  id: `look-${number}`, name: `Look ${number}`, occasion: ["casual"], garmentIds,
  reason: "A clean top balances the fuller trousers.", setting: "a warm stone courtyard",
  outerLayerConstruction: garmentIds.includes("outer-1") ? "full-front-opening" : "none",
  outerLayerNote: garmentIds.includes("outer-1") ? "A visible full button front." : "",
});

async function harness(t, { env = {}, timeoutMs, seed = true, edit, analysis } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wardrobe-outfits-test-"));
  t.after(async () => { await plugin?.closeBundle(); await rm(root, { recursive: true, force: true }); });
  for (const name of ["OPENAI_IMAGE_MODEL", "OPENAI_VISION_MODEL", "OPENAI_MODELED_MODEL", "OPENAI_IMAGE_QUALITY"]) {
    const original = process.env[name];
    delete process.env[name];
    t.after(() => { if (original === undefined) delete process.env[name]; else process.env[name] = original; });
  }
  const dataDir = path.join(root, "custom-data");
  await mkdir(path.join(dataDir, "imported"), { recursive: true });
  await mkdir(path.join(dataDir, "outfit-images"), { recursive: true });
  const image = async (color, width = 64, height = 64) => sharp({ create: { width, height, channels: 4, background: color } }).png().toBuffer();
  const identity = await image("#eeccaa", 60, 80);
  await writeFile(path.join(root, "identity.png"), identity);
  await writeFile(path.join(dataDir, "model-reference-2.png"), identity);
  const output = await image("#aa9988");
  const items = [];
  const bytesById = new Map();
  for (const [part, prefix, count] of [["upperbody", "top", 6], ["lowerbody", "bottom", 4], ["wholebody_up", "outer", 1], ["shoes", "shoe", 1], ["accessories_up", "accessory", 1], ["dresses", "dress", 1]]) {
    for (let index = 1; index <= count; index += 1) {
      const id = `${prefix}-${index}`;
      const color = `#${(0x778800 + items.length * 200).toString(16)}`;
      const bytes = await image(color);
      await writeFile(path.join(dataDir, "imported", `${id}.png`), bytes);
      bytesById.set(id, bytes);
      items.push({ id, name: id, part, color, tags: ["test detail"], image: `/api/import/library/${id}.png` });
    }
  }
  await writeFile(path.join(dataDir, "library.json"), JSON.stringify(items));
  const originals = seed ? Array.from({ length: 6 }, (_, index) => ({
    id: `original-${index + 1}`, name: `Original ${index + 1}`, occasion: ["casual"],
    garmentIds: [`top-${Math.floor(index / 4) + 1}`, `bottom-${index % 4 + 1}`],
    reason: "Original styling", setting: "Original scene", status: "accepted", image: `outfit-images/original-${index + 1}.png`,
  })) : [];
  for (const item of originals) await writeFile(path.join(dataDir, item.image), output);
  await writeFile(path.join(dataDir, "outfits.json"), JSON.stringify({ version: 1, outfits: originals }));
  const requests = [];
  let analysisResult = analysis || [plan()];
  let editResponse = edit;
  const fetchMock = async (url, options) => {
    assert.ok(url.startsWith("https://outfit-test.invalid/v1/"), "tests must never call a real provider");
    assert.equal(options.headers.Authorization, "Bearer outfit-test-key");
    assert.ok(options.signal instanceof AbortSignal);
    if (url.endsWith("/responses")) {
      const request = JSON.parse(options.body);
      requests.push({ kind: "analysis", request });
      if (typeof analysisResult === "function") return analysisResult(request, options);
      return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ outfits: analysisResult }) }] }] });
    }
    assert.ok(url.endsWith("/images/edits"));
    const form = options.body;
    const images = await Promise.all(form.getAll("image[]").map(async (file) => ({ name: file.name, bytes: Buffer.from(await file.arrayBuffer()) })));
    const entry = { kind: "edit", form, images };
    requests.push(entry);
    if (editResponse) return editResponse(entry, options);
    return Response.json({ data: [{ b64_json: output.toString("base64") }] });
  };
  const settings = { OPENAI_API_KEY: "outfit-test-key", OPENAI_API_BASE_URL: "https://outfit-test.invalid/v1/", WARDROBE_DATA_DIR: "custom-data", WARDROBE_MODEL_REFERENCE: "identity.png", ...env };
  let plugin, handler;
  function middleware(instance) {
    let result;
    instance.configureServer({ middlewares: { use(value) { result = value; } } });
    return result;
  }
  async function makePlugin({ freshModule = false, dataDirectory = settings.WARDROBE_DATA_DIR } = {}) {
    const factory = freshModule ? (await import(`../outfit-api.mjs?test-reload=${Date.now()}-${Math.random()}`)).wardrobeOutfitApi : wardrobeOutfitApi;
    return factory({ env: { ...settings, WARDROBE_DATA_DIR: dataDirectory }, fetch: fetchMock, timeoutMs });
  }
  async function restart({ viteOrder = false, ...options } = {}) {
    const previous = plugin;
    if (!viteOrder) await previous?.closeBundle();
    const replacement = await makePlugin(options);
    await replacement.configResolved({ root });
    if (viteOrder) await previous?.closeBundle();
    plugin = replacement;
    handler = middleware(plugin);
  }
  await restart();
  async function sendRequest(target, method, url, payload, expectedStatus = 200, headers = {}) {
    const req = Readable.from(payload === undefined ? [] : [Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload))]);
    Object.assign(req, { method, url, headers: { host: "localhost:5173", ...headers } });
    let result;
    const responseHeaders = {};
    const res = { statusCode: 200, setHeader(name, value) { responseHeaders[name.toLowerCase()] = value; }, end(value) { result = Buffer.isBuffer(value) ? value : JSON.parse(value); } };
    await target(req, res, () => { res.statusCode = 404; result = { error: "Not found" }; });
    if (expectedStatus === null) return { status: res.statusCode, result, headers: responseHeaders };
    assert.equal(res.statusCode, expectedStatus, JSON.stringify(result));
    return result;
  }
  const request = (...args) => sendRequest(handler, ...args);
  async function settled(id) {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const job = await request("GET", `${API}/jobs/${id}`);
      if (!["planning", "generating"].includes(job.status)) { await delay(1); return job; }
      await delay(10);
    }
    assert.fail("Timed out waiting for the mocked job");
  }
  const create = (count = 1, extra = {}) => request("POST", `${API}/jobs`, { count, modelReferenceId: "default", ...extra }, 202);
  const action = (job, outfit, name, body, status = name === "retry" ? 202 : 200) => request("POST", `${API}/jobs/${job.id}/outfits/${outfit.id}/${name}`, body, status);
  return { root, dataDir, originals, items, identity, output, bytesById, requests, request, settled, create, action, restart, image, makePlugin, close: () => plugin.closeBundle(), requestPlugin: (instance, ...args) => sendRequest(middleware(instance), ...args),
    setAnalysis(value) { analysisResult = value; }, setEdit(value) { editResponse = value; } };
}

export { API, accessoryIdeas, plan, harness };
