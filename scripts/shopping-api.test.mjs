import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import * as fileSystem from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import sharp from "sharp";
import { wardrobeShoppingApi } from "./shopping-api.mjs";
import { outfitContactSheets } from "./outfit-api.mjs";
import { withStorage } from "./storage-fs.mjs";

const API = "/api/shopping";
const assessment = (overrides = {}) => ({
  itemName: "Olive knit top", verdict: "consider", summary: "Useful with the lighter trousers, but close to a top you own.",
  personalFit: "The simple neckline and muted color can work with the reference's palette; actual fit needs a try-on.",
  wardrobeFit: "Its quieter color supports the patterned skirt.", overlap: "There is a similar green top in the wardrobe.",
  watchOuts: ["Check the shoulder fit in person."], pairings: [{ itemIds: ["bottom-1"], reason: "The lighter trousers balance the darker top." }], ...overrides,
});

async function harness(t, { env = {}, timeoutMs, response } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wardrobe-shopping-test-"));
  const dataDir = path.join(root, "custom-data");
  await mkdir(path.join(dataDir, "imported"), { recursive: true });
  const image = (color, width = 64, height = 80) => sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer();
  const identity = await image("#e7c49b", 80, 100);
  const numberedIdentity = await image("#bb7799", 70, 90);
  await writeFile(path.join(root, "identity.png"), identity);
  await writeFile(path.join(dataDir, "model-reference-2.png"), numberedIdentity);
  const items = [];
  for (const [part, prefix, count] of [["upperbody", "top", 7], ["lowerbody", "bottom", 3], ["wholebody_up", "outer", 1], ["dresses", "dress", 1], ["shoes", "shoe", 1], ["accessories_up", "accessory", 1]]) {
    for (let number = 1; number <= count; number += 1) {
      const id = `${prefix}-${number}`;
      const color = `#${(0x557700 + items.length * 250).toString(16)}`;
      await writeFile(path.join(dataDir, "imported", `${id}.png`), await image(color));
      items.push({ id, name: id, part, color, secondaryColor: null, tags: ["wardrobe detail"], image: `/api/import/library/${id}.png` });
    }
  }
  await writeFile(path.join(dataDir, "library.json"), JSON.stringify(items));
  const candidate = await sharp(await image("#667755", 120, 180)).jpeg().toBuffer();
  const requests = [];
  const imageReads = [];
  let imageReadHook;
  const storage = { ...fileSystem, async readFile(filename, ...args) {
    const bytes = await fileSystem.readFile(filename, ...args);
    if (/\.(?:png|jpe?g|webp)$/i.test(String(filename))) {
      imageReads.push({ file: String(filename), bytes: Buffer.byteLength(bytes) });
      await imageReadHook?.(String(filename));
    }
    return bytes;
  } };
  let providerResponse = response;
  const settings = { OPENAI_API_KEY: "shopping-test-key", OPENAI_API_BASE_URL: "https://shopping-test.invalid/v1/", OPENAI_VISION_MODEL: "gpt-5.6-luna", WARDROBE_DATA_DIR: "custom-data", WARDROBE_MODEL_REFERENCE: "identity.png", ...env };
  const fetchMock = async (url, options) => {
    assert.equal(url, "https://shopping-test.invalid/v1/responses", "tests never call a real provider");
    assert.equal(options.headers.Authorization, "Bearer shopping-test-key");
    assert.ok(options.signal instanceof AbortSignal);
    const request = JSON.parse(options.body);
    requests.push({ request, options });
    if (providerResponse) return providerResponse(request, options);
    return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(assessment()) }] }] });
  };
  const makePlugin = () => wardrobeShoppingApi({ env: settings, fetch: fetchMock, timeoutMs });
  let plugin = makePlugin();
  await plugin.configResolved({ root });
  const middleware = (instance, preview = false) => {
    let handler;
    instance[preview ? "configurePreviewServer" : "configureServer"]({ middlewares: { use(value) { handler = value; } } });
    return handler;
  };
  let handler = middleware(plugin);
  t.after(async () => { plugin.closeBundle(); await rm(root, { recursive: true, force: true }); });
  async function request(method, url, payload, expected = 200, headers = {}) {
    const req = Readable.from(payload === undefined ? [] : [Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload))]);
    Object.assign(req, { method, url, headers: { host: "localhost:5173", ...(method === "POST" ? { "content-type": "application/json" } : {}), ...headers } });
    let result;
    const res = { statusCode: 200, setHeader() {}, end(value) { result = JSON.parse(value); } };
    await withStorage(storage, () => handler(req, res, () => { res.statusCode = 404; result = { error: "Not found" }; }));
    assert.equal(res.statusCode, expected, JSON.stringify(result));
    return result;
  }
  const body = (overrides = {}) => ({ image: `data:image/jpeg;base64,${candidate.toString("base64")}`, modelReferenceId: "default", notes: "An everyday top", wardrobeItems: items, ...overrides });
  async function serve() {
    const server = createServer((req, res) => { void withStorage(storage, () => handler(req, res, () => { res.statusCode = 404; res.end(); })); });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
    return `http://127.0.0.1:${server.address().port}`;
  }
  return { root, dataDir, identity, numberedIdentity, items, candidate, settings, requests, imageReads, request, body,
    serve,
    analyze: (overrides, expected = 200, headers) => request("POST", `${API}/analyze`, body(overrides), expected, headers),
    setResponse(value) { providerResponse = value; }, close() { plugin.closeBundle(); },
    setImageReadHook(value) { imageReadHook = value; },
    async restart({ preview = false } = {}) { const previous = plugin; plugin = makePlugin(); await plugin.configResolved({ root }); previous.closeBundle(); handler = middleware(plugin, preview); },
  };
}

test("configuration includes all categories and only public setup details", async (t) => {
  const h = await harness(t);
  const config = await h.request("GET", `${API}/config`);
  assert.deepEqual(config, { ready: true, hasApiKey: true, hasModelReference: true, wardrobeCount: 14,
    modelReferences: [{ id: "default", label: "Default", imageUrl: "/api/import/model-references/default" }, { id: "model-reference-2", label: "Reference 2", imageUrl: "/api/import/model-references/model-reference-2" }] });
  assert.ok(!JSON.stringify(config).includes(h.root));
  assert.ok(!JSON.stringify(config).includes("shopping-test-key"));
  assert.equal(h.requests.length, 0);
  assert.deepEqual(h.imageReads, [], "settings do not read any original image body");
  assert.deepEqual(await h.request("GET", `${API}/config`), config, "repeat settings reads have the same response");
  assert.deepEqual(h.imageReads, [], "repeat settings reads also avoid all original image bodies");
});

test("metadata-only settings retain path checks and analysis rejects corrupt selected assets before a provider call", async (t) => {
  const h = await harness(t);
  const missing = { ...h.items[0], id: "missing-1", image: "/api/import/library/missing.png" };
  await writeFile(path.join(h.dataDir, "library.json"), JSON.stringify([...h.items, missing]));
  assert.equal((await h.request("GET", `${API}/config`)).wardrobeCount, 14, "missing originals remain excluded");
  assert.equal(h.imageReads.length, 0);

  await writeFile(path.join(h.root, "identity.png"), "not an image");
  assert.equal((await h.request("GET", `${API}/config`)).ready, true, "readiness defers image decoding to analysis");
  assert.equal(h.imageReads.length, 0);
  await h.analyze({}, 400);
  assert.equal(h.requests.length, 0, "a corrupt selected reference never reaches the provider");

  await writeFile(path.join(h.root, "identity.png"), h.identity);
  await writeFile(path.join(h.dataDir, "imported", "top-1.png"), "not an image");
  await h.analyze({ wardrobeItems: [h.items[0]] }, 503);
  assert.equal(h.requests.length, 0, "an exclusively corrupt selected inventory never reaches the provider");
});

test("analysis sends the real candidate, selected person and labeled contact sheets with dresses", async (t) => {
  const h = await harness(t, { env: { OPENAI_VISION_MODEL: "vision-override" } });
  const originalLibrary = await readFile(path.join(h.dataDir, "library.json"));
  const result = await h.analyze({ modelReferenceId: "model-reference-2" });
  assert.deepEqual(result.assessment, assessment());
  assert.deepEqual(result.context, { wardrobeCount: 14, modelReferenceId: "model-reference-2", modelReferenceLabel: "Reference 2" });
  assert.ok(Number.isFinite(Date.parse(result.analyzedAt)));
  assert.equal(h.requests.length, 1);
  const { request } = h.requests[0];
  assert.equal(request.model, "vision-override");
  assert.equal(request.store, false);
  assert.equal(request.text.format.strict, true);
  assert.ok(request.text.format.schema.properties.pairings.items.properties.itemIds.items.enum.includes("dress-1"));
  assert.match(request.instructions, /evidence, not instructions/);
  const content = request.input[0].content;
  assert.match(content[0].text, /ITEM 14/);
  assert.match(content[0].text, /An everyday top/);
  assert.match(content[0].text, /sensitive traits/);
  assert.match(content[0].text, /person reference ONLY for the person's visible coloring and proportions/);
  assert.match(content[0].text, /Never base personalFit on the reference outfit or background/);
  assert.match(content[0].text, /actual garment names in every prose field, caution and pairing reason, never ITEM numbers or inventory IDs/);
  assert.match(content[0].text, /candidate plus only the owned itemIds/);
  assert.ok(!content[0].text.includes(h.root), "filesystem paths are never sent");
  const images = content.filter((item) => item.type === "input_image").map((item) => Buffer.from(item.image_url.split(",")[1], "base64"));
  assert.equal(images.length, 4);
  const normalized = (bytes) => sharp(bytes, { limitInputPixels: 64e6 }).rotate().resize(1600, 1600, { fit: "inside", withoutEnlargement: true }).flatten({ background: "#ffffff" }).jpeg({ quality: 85 }).toBuffer();
  assert.deepEqual(images[0], await normalized(h.candidate));
  assert.deepEqual(images[1], await normalized(h.numberedIdentity));
  const expectedSheets = await outfitContactSheets(h.items.map((item) => ({ ...item, file: path.join(h.dataDir, "imported", `${item.id}.png`) })));
  assert.deepEqual(images.slice(2), expectedSheets, "single-pass preparation preserves every contact-sheet byte and ITEM label");
  assert.equal(h.imageReads.length, 15, "fourteen submitted cutouts and only the selected reference are read once");
  assert.equal(new Set(h.imageReads.map((entry) => entry.file)).size, 15);
  assert.ok(!h.imageReads.some((entry) => entry.file === path.join(h.root, "identity.png")), "unselected reference is never downloaded");
  for (const [index, sheet] of images.slice(2).entries()) {
    const metadata = await sharp(sheet).metadata();
    assert.equal(metadata.width, 1024);
    assert.equal(metadata.height, index === 0 ? 900 : 300);
  }
  assert.deepEqual(await readFile(path.join(h.dataDir, "library.json")), originalLibrary, "assessment does not mutate the library");
});

test("browser edits and deletions control the snapshot while source images remain server-owned", async (t) => {
  const h = await harness(t);
  const edited = { ...h.items.find((item) => item.id === "dress-1"), name: "My edited dress", color: "#123456", secondaryColor: "#abcdef", tags: ["edited tag"], file: "/etc/passwd", image: "https://untrusted.invalid/image.jpg" };
  const visible = [h.items.find((item) => item.id === "bottom-1"), edited, { id: "invented-1", file: "/etc/passwd" }];
  const result = await h.analyze({ wardrobeItems: visible });
  assert.equal(result.context.wardrobeCount, 2);
  const { request } = h.requests[0];
  assert.deepEqual(request.text.format.schema.properties.pairings.items.properties.itemIds.items.enum, ["bottom-1", "dress-1"]);
  const prompt = request.input[0].content[0].text;
  assert.match(prompt, /My edited dress/);
  assert.match(prompt, /#123456/);
  assert.match(prompt, /#abcdef/);
  assert.match(prompt, /edited tag/);
  assert.ok(!prompt.includes("top-1"));
  assert.ok(!prompt.includes("untrusted.invalid"));
  assert.ok(!prompt.includes("/etc/passwd"));
  assert.equal(request.input[0].content.filter((item) => item.type === "input_image").length, 3);
  assert.deepEqual(h.imageReads.map((entry) => path.basename(entry.file)), ["identity.png", "bottom-1.png", "dress-1.png"], "unsubmitted garments and unselected references are never downloaded");
});

test("single-pass Shopping excludes corrupt cutouts and retains contiguous labels and exact healthy images", async (t) => {
  const h = await harness(t);
  await writeFile(path.join(h.dataDir, "imported", "top-1.png"), "corrupt");
  await writeFile(path.join(h.dataDir, "model-reference-2.png"), "corrupt unselected reference");
  const result = await h.analyze({ wardrobeItems: [h.items[0], h.items.find((item) => item.id === "bottom-1")] });
  assert.equal(result.context.wardrobeCount, 1);
  const request = h.requests[0].request;
  assert.deepEqual(request.text.format.schema.properties.pairings.items.properties.itemIds.items.enum, ["bottom-1"]);
  assert.match(request.input[0].content[0].text, /ITEM 1/);
  assert.doesNotMatch(request.input[0].content[0].text, /ITEM 2/);
  const sheet = Buffer.from(request.input[0].content.at(-1).image_url.split(",")[1], "base64");
  assert.deepEqual(sheet, (await outfitContactSheets([{ id: "bottom-1", name: "bottom-1", file: path.join(h.dataDir, "imported", "bottom-1.png") }]))[0]);
  assert.deepEqual(h.imageReads.map((entry) => path.basename(entry.file)), ["identity.png", "top-1.png", "bottom-1.png"]);
});

test("Shopping retains a healthy later image for a duplicate ID and never exposes internal candidate paths", async (t) => {
  const h = await harness(t);
  const first = h.items.find((item) => item.id === "bottom-1");
  await writeFile(path.join(h.dataDir, "imported", "bad.png"), "corrupt");
  await writeFile(path.join(h.dataDir, "library.json"), JSON.stringify([{ ...first, image: "/api/import/library/bad.png" }, ...h.items]));
  await h.analyze({ wardrobeItems: [first] });
  assert.deepEqual(h.imageReads.map((entry) => path.basename(entry.file)), ["identity.png", "bad.png", "bottom-1.png"]);
  assert.ok(!JSON.stringify(h.requests[0].request).includes(h.root));
  assert.doesNotMatch(h.requests[0].request.input[0].content[0].text, /candidates/);
});

test("a selected reference with a readable header but corrupt pixels is rejected before provider submission", async (t) => {
  const h = await harness(t);
  const truncated = h.identity.subarray(0, 80);
  assert.equal((await sharp(truncated).metadata()).width, 80);
  await assert.rejects(sharp(truncated).jpeg().toBuffer());
  await writeFile(path.join(h.root, "identity.png"), truncated);
  await h.analyze({}, 400);
  assert.equal(h.requests.length, 0);
});

test("disconnect during cutout preparation stops the next read and releases the Shopping slot", async (t) => {
  const h = await harness(t);
  let entered, release;
  const started = new Promise((resolve) => { entered = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  h.setImageReadHook(async (file) => { if (file.endsWith("top-1.png")) { entered(); await held; } });
  const origin = await h.serve();
  const controller = new AbortController();
  const response = fetch(`${origin}${API}/analyze`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(h.body()), signal: controller.signal });
  await started;
  controller.abort();
  await assert.rejects(response, { name: "AbortError" });
  await delay(10);
  release();
  await delay(20);
  assert.equal(h.requests.length, 0);
  assert.deepEqual(h.imageReads.map((entry) => path.basename(entry.file)), ["identity.png", "top-1.png"]);
  h.setImageReadHook(undefined);
  await h.analyze();
  assert.equal(h.requests.length, 1, "cancelled preparation does not strand the next check");
});

test("uploaded JPEGs are reoriented, resized and stripped of metadata", async (t) => {
  const h = await harness(t);
  const upload = await sharp({ create: { width: 2200, height: 800, channels: 3, background: "#d5a777" } }).withMetadata({ orientation: 6 }).jpeg().toBuffer();
  await h.analyze({ image: `data:image/jpeg;base64,${upload.toString("base64")}` });
  const candidate = Buffer.from(h.requests[0].request.input[0].content[1].image_url.split(",")[1], "base64");
  const metadata = await sharp(candidate).metadata();
  assert.equal(metadata.width, 582);
  assert.equal(metadata.height, 1600);
  assert.equal(metadata.orientation, undefined);
  assert.equal(metadata.exif, undefined);
});

test("invalid images, oversize uploads, malformed input and excessive notes are rejected before provider use", async (t) => {
  const h = await harness(t);
  for (const image of [undefined, "https://example.invalid/image.jpg", "data:image/png;base64,aGVsbG8=", "data:image/jpeg;base64,bad!!===", "data:image/jpeg;base64,aGVsbG8="]) await h.analyze({ image }, 400);
  await h.analyze({ image: `data:image/jpeg;base64,${Buffer.alloc(2 * 1024 * 1024 + 1).toString("base64")}` }, 413);
  const oversizedPixels = Buffer.from(h.candidate);
  const marker = oversizedPixels.indexOf(Buffer.from([0xff, 0xc0]));
  assert.ok(marker >= 0);
  oversizedPixels.writeUInt16BE(9000, marker + 5);
  oversizedPixels.writeUInt16BE(9000, marker + 7);
  await h.analyze({ image: `data:image/jpeg;base64,${oversizedPixels.toString("base64")}` }, 400);
  await h.analyze({ notes: "a".repeat(1501) }, 400);
  await h.analyze({ wardrobeItems: [h.items[0], h.items[0]] }, 400);
  await h.analyze({ wardrobeItems: [{ ...h.items[0], part: "unsupported" }] }, 400);
  await h.request("POST", `${API}/analyze`, "{", 400);
  await h.request("POST", `${API}/analyze`, "[]", 400);
  await h.request("POST", `${API}/analyze`, "x".repeat(4 * 1024 * 1024 + 1), 413);
  await h.analyze({}, 413, { "content-length": String(4 * 1024 * 1024 + 1) });
  assert.equal(h.requests.length, 0);
});

test("mutations enforce origin and JSON protections", async (t) => {
  const h = await harness(t);
  await h.analyze({}, 403, { origin: "https://attacker.invalid" });
  await h.analyze({}, 403, { origin: "null" });
  await h.analyze({}, 403, { "sec-fetch-site": "cross-site" });
  await h.analyze({}, 415, { "content-type": "text/plain" });
  await h.analyze({}, 415, { "content-type": "application/jsonp" });
  assert.equal(h.requests.length, 0);
  await h.analyze({}, 200, { origin: "http://localhost:5173", "sec-fetch-site": "same-origin", "content-type": "application/json; charset=utf-8" });
  assert.equal(h.requests.length, 1);
});

test("client reference paths and escaped inventory images never become model inputs", async (t) => {
  const h = await harness(t);
  await h.analyze({ modelReferenceId: "../../identity.png" }, 400);
  const escaped = { ...h.items[0], id: "escaped-1", image: "/api/import/library/escaped.png" };
  const remote = { ...h.items[0], id: "remote-1", image: "https://example.invalid/image.png" };
  const traversal = { ...h.items[0], id: "traversal-1", image: "/api/import/library/../../identity.png" };
  await symlink(path.join(h.root, "identity.png"), path.join(h.dataDir, "imported", "escaped.png"));
  await writeFile(path.join(h.dataDir, "library.json"), JSON.stringify([...h.items, escaped, remote, traversal]));
  assert.equal((await h.request("GET", `${API}/config`)).wardrobeCount, 14);
  await h.analyze({ wardrobeItems: [...h.items, escaped, remote, traversal] });
  const ids = h.requests[0].request.text.format.schema.properties.pairings.items.properties.itemIds.items.enum;
  assert.ok(!ids.includes("escaped-1"));
  assert.ok(!ids.includes("remote-1"));
  assert.ok(!ids.includes("traversal-1"));
});

test("default reference cannot follow a symlink outside its configured directory", async (t) => {
  const h = await harness(t, { env: { WARDROBE_MODEL_REFERENCE: "custom-data/default.png" } });
  await rm(path.join(h.dataDir, "model-reference-2.png"));
  await symlink(path.join(h.root, "identity.png"), path.join(h.dataDir, "default.png"));
  const config = await h.request("GET", `${API}/config`);
  assert.equal(config.hasModelReference, false);
  assert.equal(config.ready, false);
  await h.analyze({}, 503);
  assert.equal(h.requests.length, 0);
});

for (const [name, prepare] of [
  ["API key", async (h) => { h.settings.OPENAI_API_KEY = ""; }],
  ["model reference", async (h) => { await rm(path.join(h.root, "identity.png")); await rm(path.join(h.dataDir, "model-reference-2.png")); }],
  ["wardrobe", async (h) => { await writeFile(path.join(h.dataDir, "library.json"), "[]"); }],
]) test(`missing ${name} gives a setup error without a provider request`, async (t) => {
  const h = await harness(t);
  await prepare(h);
  assert.equal((await h.request("GET", `${API}/config`)).ready, false);
  await h.analyze({}, 503);
  assert.equal(h.requests.length, 0);
});

test("an empty visible wardrobe and an invalid library fail without analysis", async (t) => {
  const h = await harness(t);
  await h.analyze({ wardrobeItems: [] }, 503);
  await writeFile(path.join(h.dataDir, "library.json"), "{}");
  await h.request("GET", `${API}/config`, undefined, 503);
  await h.analyze({}, 503);
  assert.equal(h.requests.length, 0);
});

test("structured output is checked locally including unknown IDs, enums, array bounds and field types", async (t) => {
  const h = await harness(t);
  const invalid = [
    assessment({ pairings: [{ itemIds: ["invented-garment"], reason: "Invented" }] }),
    assessment({ pairings: [{ itemIds: ["bottom-1", "bottom-1"], reason: "Duplicate" }] }),
    assessment({ pairings: [{ itemIds: [], reason: "Empty" }] }),
    assessment({ verdict: "buy-immediately" }), assessment({ summary: " " }), assessment({ itemName: 42 }),
    assessment({ watchOuts: [null] }), assessment({ watchOuts: Array(7).fill("Too many") }), assessment({ unexpected: "extra" }),
    assessment({ personalFit: "a".repeat(1201) }), null,
  ];
  for (const value of invalid) {
    h.setResponse(() => Response.json({ output_text: JSON.stringify(value) }));
    await h.analyze({}, 502);
  }
  h.setResponse(() => Response.json({ output_text: "not json" }));
  await h.analyze({}, 502);
  assert.equal(h.requests.length, invalid.length + 1, "there is no automatic retry");
});

test("unclear and skip assessments allow zero pairings", async (t) => {
  const h = await harness(t);
  for (const verdict of ["unclear", "skip"]) {
    h.setResponse(() => Response.json({ output_text: JSON.stringify(assessment({ verdict, pairings: [], watchOuts: [] })) }));
    assert.equal((await h.analyze()).assessment.verdict, verdict);
  }
});

test("internal ITEM labels become actual garment names in every prose field without recursive replacement", async (t) => {
  const h = await harness(t);
  const snapshot = h.items.map((item, index) => index === 0 ? { ...item, name: "cream ITEM 999 graphic sweater" } : item);
  const value = assessment({
    itemName: "Similar to ITEM 1", summary: "Similar to item 1.", personalFit: "Like Item 1, consider the neckline.",
    wardrobeFit: "ITEM 1 provides a similar option.", overlap: "Already covered by ITEM   1.", watchOuts: ["Compare with ITEM 1."],
    pairings: [{ itemIds: ["bottom-1"], reason: "Try with the trousers, as with ITEM 1." }],
  });
  h.setResponse(() => Response.json({ output_text: JSON.stringify(value) }));
  const result = (await h.analyze({ wardrobeItems: snapshot })).assessment;
  const expected = "cream ITEM 999 graphic sweater";
  for (const field of ["itemName", "summary", "personalFit", "wardrobeFit", "overlap"]) assert.ok(result[field].includes(expected), field);
  assert.equal(result.watchOuts[0], `Compare with ${expected}.`);
  assert.equal(result.pairings[0].reason, `Try with the trousers, as with ${expected}.`);
  assert.deepEqual(result.pairings[0].itemIds, ["bottom-1"]);
});

test("unknown ITEM labels are rejected instead of inventing a garment name", async (t) => {
  const h = await harness(t);
  for (const overrides of [
    { overlap: "Similar to ITEM 999." }, { watchOuts: ["Compare with item 0."] },
    { pairings: [{ itemIds: ["bottom-1"], reason: "This works like ITEM 15." }] },
  ]) {
    h.setResponse(() => Response.json({ output_text: JSON.stringify(assessment(overrides)) }));
    await h.analyze({}, 502);
  }
  assert.equal(h.requests.length, 3, "invalid references are not retried automatically");
});

test("provider errors are safe, explicit and never retried automatically", async (t) => {
  const h = await harness(t);
  for (const status of [401, 429, 500]) {
    h.setResponse(() => Response.json({ error: { message: "secret key shopping-test-key at private-url" } }, { status }));
    const result = await h.analyze({}, 502);
    assert.match(result.error, new RegExp(`HTTP ${status}`));
    assert.ok(!result.error.includes("shopping-test-key"));
    assert.ok(!result.error.includes("private-url"));
  }
  h.setResponse(() => { throw new Error("network secret"); });
  const result = await h.analyze({}, 502);
  assert.ok(!result.error.includes("network secret"));
  assert.equal(h.requests.length, 4);
});

test("one concurrent analysis is allowed and the slot is reusable after completion", async (t) => {
  const h = await harness(t);
  let complete;
  let started;
  const start = new Promise((resolve) => { started = resolve; });
  h.setResponse(() => { started(); return new Promise((resolve) => { complete = resolve; }); });
  const first = h.analyze();
  await start;
  await h.analyze({}, 409);
  assert.equal(h.requests.length, 1);
  complete(Response.json({ output_text: JSON.stringify(assessment()) }));
  await first;
  h.setResponse(undefined);
  await h.analyze();
  assert.equal(h.requests.length, 2);
});

test("timeout aborts even an uncooperative provider and does not retry", async (t) => {
  const h = await harness(t, { timeoutMs: 15, response: () => new Promise(() => {}) });
  const work = h.analyze({}, 504);
  // Keep a bounded test timer alive while the production timeout is unreferenced.
  await delay(100);
  const result = await work;
  assert.match(result.error, /timed out/);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].options.signal.aborted, true);
});

test("shutdown cancels pending requests and config replacement supports the preview lifecycle", async (t) => {
  const h = await harness(t);
  let started;
  const start = new Promise((resolve) => { started = resolve; });
  h.setResponse(() => { started(); return new Promise(() => {}); });
  const first = h.analyze({}, 503);
  await start;
  h.close();
  await first;
  assert.equal(h.requests[0].options.signal.aborted, true);
  await h.request("GET", `${API}/config`, undefined, 503);
  h.setResponse(undefined);
  await h.restart({ preview: true });
  await h.analyze();
  assert.equal(h.requests.length, 2);
});

test("a real HTTP client disconnect aborts the provider and releases the next check", async (t) => {
  const h = await harness(t);
  const origin = await h.serve();
  let started, cancelled;
  const start = new Promise((resolve) => { started = resolve; });
  const cancel = new Promise((resolve) => { cancelled = resolve; });
  h.setResponse((request, options) => {
    options.signal.addEventListener("abort", cancelled, { once: true });
    started();
    return new Promise(() => {});
  });
  const controller = new AbortController();
  const response = fetch(`${origin}${API}/analyze`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(h.body()), signal: controller.signal });
  await start;
  controller.abort();
  await assert.rejects(response, { name: "AbortError" });
  await cancel;
  assert.equal(h.requests[0].options.signal.aborted, true);
  // A fulfilled abort listener precedes the middleware's final cleanup microtask.
  await delay(5);
  h.setResponse(undefined);
  await h.analyze();
  assert.equal(h.requests.length, 2);
});

test("disconnecting while uploading does not call the provider or strand the pending slot", async (t) => {
  const h = await harness(t);
  const origin = await h.serve();
  const client = httpRequest(`${origin}${API}/analyze`, { method: "POST", headers: { "Content-Type": "application/json" } });
  client.on("error", () => {});
  client.write('{"notes":"unfinished upload');
  await delay(10);
  client.destroy();
  await delay(10);
  assert.equal(h.requests.length, 0);
  await h.analyze();
  assert.equal(h.requests.length, 1);
});
