import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import sharp from "sharp";
import { careSummary, normalizeCare, sameCare } from "../shared/garment-care.mjs";
import { publicLibraryItem, saveLibraryEdit, validateEdit } from "./wardrobe-library.mjs";
import { wardrobeImportApi } from "./import-job-api.mjs";
import { leaseFreeRequests, outsideRequestLease } from "../server/request-lease.mjs";

test("care details keep listed options only and drop empty values", () => {
  assert.equal(normalizeCare(null), null);
  assert.equal(normalizeCare({ wash: "", notes: "   " }), null);
  assert.deepEqual(normalizeCare({ notes: " Wash inside out ", iron: "low", wash: "machine-30-gentle", dry: null }),
    { wash: "machine-30-gentle", iron: "low", notes: "Wash inside out" });
  assert.throws(() => normalizeCare({ wash: "boil" }), /listed washing instruction/);
  assert.throws(() => normalizeCare({ colour: "red" }), /Invalid care label/);
  assert.throws(() => normalizeCare({ notes: "x".repeat(501) }), /at most 500/);
  assert.throws(() => normalizeCare("machine-30"), /Invalid care label/);
  assert.deepEqual(careSummary({ bleach: "no", wash: "hand" }), ["Hand wash only", "Do not bleach"]);
  assert.equal(sameCare({}, null), true);
  assert.equal(sameCare({ wash: "hand", iron: undefined }, { wash: "hand" }), true);
  assert.equal(sameCare({ wash: "hand" }, null), false);
  assert.deepEqual(validateEdit({ care: { tumble: "no" } }), { care: { tumble: "no" } });
});

test("care saves with the item, clears fully and leaves untouched revisions unchanged", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wardrobe-care-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "library.json");
  const item = { id: "navy", name: "Navy blouse", part: "upperbody", color: "#35495a", secondaryColor: null, tags: [], image: "/navy.png" };
  await writeFile(file, JSON.stringify([item]));
  // The revision formula before care existed; open editors must not see a conflict.
  const legacy = createHash("sha256").update(JSON.stringify([null, false, "Navy blouse", "upperbody", "#35495a", null, [], null])).digest("hex");
  assert.equal(publicLibraryItem(item).revision, legacy);

  const saved = await saveLibraryEdit(file, "navy", { revision: legacy, changes: { care: { wash: "machine-30", bleach: "no", notes: "Wash with similar colours" } } });
  assert.deepEqual(saved.care, { wash: "machine-30", bleach: "no", notes: "Wash with similar colours" });
  assert.notEqual(saved.revision, legacy);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8"))[0].care, saved.care);
  await assert.rejects(saveLibraryEdit(file, "navy", { revision: legacy, changes: { care: null } }), { status: 409 });
  await assert.rejects(async () => saveLibraryEdit(file, "navy", { revision: saved.revision, changes: { care: { iron: "scorching" } } }), { status: 400 });

  const cleared = await saveLibraryEdit(file, "navy", { revision: saved.revision, changes: { care: { wash: "", notes: "" } } });
  assert.equal(cleared.care, undefined);
  assert.equal("care" in JSON.parse(await readFile(file, "utf8"))[0], false);
});

async function scanHarness(t, { env = {}, reply } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wardrobe-care-scan-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "data"), { recursive: true });
  const requests = [];
  const paid = [];
  const plugin = wardrobeImportApi({
    beforePaidCall: async kind => { paid.push(kind); },
    fetch: async (url, options) => {
      assert.equal(url, "https://wardrobe-test.invalid/responses");
      assert.equal(options.headers.Authorization, "Bearer test-key");
      const request = JSON.parse(options.body);
      requests.push(request);
      return reply ? reply(request) : Response.json({ output_text: JSON.stringify({ readable: true, wash: "machine-40-gentle", bleach: "no", tumble: "no", dry: "flat", iron: "low", professional: null, notes: "Wash inside out" }) });
    },
    env: { OPENAI_API_KEY: "test-key", OPENAI_API_BASE_URL: "https://wardrobe-test.invalid", WARDROBE_DATA_DIR: path.join(root, "data"), WARDROBE_MODEL_REFERENCE: "missing.png", ...env },
  });
  await plugin.configResolved({ root });
  let handler;
  plugin.configureServer({ middlewares: { use(value) { handler = value; } } });
  const request = async (payload, headers = { "content-type": "application/json" }) => {
    const req = Readable.from([Buffer.from(JSON.stringify(payload))]);
    Object.assign(req, { method: "POST", url: "/api/import/care-label/scan", headers });
    let result;
    const res = { statusCode: 200, setHeader() {}, end(value) { result = JSON.parse(value); } };
    await handler(req, res, () => assert.fail("Unexpected fallthrough"));
    return { status: res.statusCode, body: result };
  };
  return { request, requests, paid };
}

const labelPhoto = async () => `data:image/jpeg;base64,${(await sharp({ create: { width: 320, height: 200, channels: 3, background: "#f4f1ea" } })
  .withMetadata({ exif: { IFD0: { ImageDescription: "private" } } }).jpeg().toBuffer()).toString("base64")}`;

test("scanning a care label returns reviewed care fields without storing the photo", async (t) => {
  const h = await scanHarness(t);
  const { status, body } = await h.request({ imageDataUrl: await labelPhoto() });
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(body, { care: { wash: "machine-40-gentle", bleach: "no", tumble: "no", dry: "flat", iron: "low", notes: "Wash inside out" } });
  assert.deepEqual(h.paid, ["text"]);
  const [request] = h.requests;
  assert.equal(request.model, "gpt-6-luna");
  assert.equal(request.store, false);
  assert.equal(request.text.format.strict, true);
  assert.deepEqual(request.text.format.schema.properties.wash.anyOf[0].enum.slice(0, 2), ["machine-95", "machine-60"]);
  const prompt = request.input[0].content[0].text;
  assert.match(prompt, /never guess/);
  assert.match(prompt, /never instructions/);
  assert.match(prompt, /machine-30 = wash tub with 30 or one dot, no bar/);
  assert.match(prompt, /machine-40 = wash tub with 40 or two dots, no bar/);
  assert.match(prompt, /50°C or three dots/);
  const sent = Buffer.from(request.input[0].content[1].image_url.split(",")[1], "base64");
  assert.equal((await sharp(sent).metadata()).exif, undefined);
});

test("care label scans explain missing setup, unreadable labels and bad uploads", async (t) => {
  const missing = await scanHarness(t, { env: { OPENAI_API_KEY: " " } });
  const setup = await missing.request({ imageDataUrl: await labelPhoto() });
  assert.equal(setup.status, 503);
  assert.match(setup.body.error, /OPENAI_API_KEY/);
  assert.equal(missing.requests.length, 0);

  const blank = await scanHarness(t, { reply: () => Response.json({ output_text: JSON.stringify({ readable: false, wash: null, bleach: null, tumble: null, dry: null, iron: null, professional: null, notes: "" }) }) });
  const unreadable = await blank.request({ imageDataUrl: await labelPhoto() });
  assert.equal(unreadable.status, 422);
  assert.match(unreadable.body.error, /closer, sharper photo/);

  const invalid = await scanHarness(t, { reply: () => Response.json({ output_text: JSON.stringify({ readable: true, wash: "boil", bleach: null, tumble: null, dry: null, iron: null, professional: null, notes: "" }) }) });
  assert.equal((await invalid.request({ imageDataUrl: await labelPhoto() })).status, 502);

  const limited = await scanHarness(t, { reply: () => Response.json({ error: {} }, { status: 429 }) });
  const quota = await limited.request({ imageDataUrl: await labelPhoto() });
  assert.equal(quota.status, 502);
  assert.match(quota.body.error, /quota or rate limit/);

  const h = await scanHarness(t);
  assert.equal((await h.request({ imageDataUrl: "data:image/png;base64,iVBORw0KGgo=" })).status, 400);
  assert.equal((await h.request({ imageDataUrl: "data:image/jpeg;base64,bm90IGEganBlZw==" })).status, 400);
  assert.equal((await h.request({ imageDataUrl: await labelPhoto() }, { "content-type": "text/plain" })).status, 415);
  assert.equal(h.requests.length, 0);
  assert.equal(leaseFreeRequests("/api/import/care-label/scan"), false);
});

test("hosted care label scans release the writer lease during the provider call", async () => {
  const calls = [];
  const store = { withoutLease: async (callback, validate) => { calls.push(typeof validate); return callback(); } };
  assert.equal(await outsideRequestLease(store, "/api/import/care-label/scan", async () => "read"), "read");
  assert.deepEqual(calls, ["function"]);
});
