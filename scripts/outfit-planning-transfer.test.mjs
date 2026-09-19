import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { wardrobeOutfitApi, outfitContactSheets } from "./outfit-api.mjs";
import { withStorage } from "./storage-fs.mjs";
import { API, harness, plan } from "./test-helpers/outfit-harness.mjs";

async function planningHarness(t, duringPlanning = () => {}) {
  const h = await harness(t);
  await h.close();
  const calls = [];
  const tasks = [];
  const plugin = wardrobeOutfitApi({ serverless: true,
    env: { OPENAI_API_KEY: "outfit-test-key", OPENAI_API_BASE_URL: "https://outfit-test.invalid/v1", WARDROBE_DATA_DIR: "custom-data", WARDROBE_MODEL_REFERENCE: "identity.png" },
    scheduleTask: async (task) => tasks.push(task),
    fetch: async (url, init) => {
      assert.equal(url, "https://outfit-test.invalid/v1/responses", "planning must never submit an image or real provider request");
      calls.push(JSON.parse(init.body));
      await duringPlanning(h);
      return Response.json({ output_text: JSON.stringify({ outfits: [plan()] }) });
    },
  });
  await plugin.configResolved({ root: h.root });
  t.after(() => plugin.closeBundle());
  const request = (...args) => h.requestPlugin(plugin, ...args);
  const job = await request("POST", `${API}/jobs`, { count: 1, modelReferenceId: "default" }, 202);
  return { ...h, calls, request, job, run: () => plugin.runTask(tasks[0]) };
}

test("planning reads each cutout once for contact sheets and rechecks only selected inputs before commitment", async (t) => {
  const h = await planningHarness(t);
  const reads = [];
  const storage = { ...fs, async readFile(file, ...args) {
    const bytes = await fs.readFile(file, ...args);
    if (path.dirname(String(file)).endsWith("/imported")) reads.push({ file: path.basename(file), bytes: bytes.length });
    return bytes;
  } };
  assert.equal(await withStorage(storage, h.run), true);
  const eligible = h.items.filter((item) => item.part !== "dresses");
  const selected = new Set(["top-3", "bottom-1"]);
  assert.equal(reads.length, eligible.length + selected.size);
  assert.equal(reads.reduce((sum, read) => sum + read.bytes, 0), eligible.reduce((sum, item) => sum + h.bytesById.get(item.id).length * (selected.has(item.id) ? 2 : 1), 0));
  for (const item of eligible) assert.equal(reads.filter((read) => read.file === `${item.id}.png`).length, selected.has(item.id) ? 2 : 1, item.id);
  const expectedSheets = await outfitContactSheets(eligible.map((item) => ({ ...item, file: path.join(h.dataDir, "imported", `${item.id}.png`) })));
  const sentSheets = h.calls[0].input[0].content.filter((item) => item.type === "input_image").map((item) => Buffer.from(item.image_url.split(",")[1], "base64"));
  assert.deepEqual(sentSheets, expectedSheets, "the same original images and contact sheet encoding reach the provider");
  const state = await h.request("GET", `${API}/jobs/${h.job.id}`);
  assert.equal(state.outfits[0].status, "planned");
});

for (const mutation of ["replacement", "corrupt", "deleted", "hidden", "category"]) test(`planning cannot commit a selected garment changed during curation: ${mutation}`, async (t) => {
  const h = await planningHarness(t, async (local) => {
    const file = path.join(local.dataDir, "imported", "top-3.png");
    if (mutation === "replacement") await fs.writeFile(file, await local.image("#123456"));
    else if (mutation === "corrupt") await fs.writeFile(file, "invalid png");
    else if (mutation === "deleted") await fs.rm(file);
    else {
      const library = path.join(local.dataDir, "library.json");
      const records = JSON.parse(await fs.readFile(library, "utf8"));
      const item = records.find((record) => record.id === "top-3");
      if (mutation === "hidden") item.hidden = true;
      else item.part = "shoes";
      await fs.writeFile(library, JSON.stringify(records));
    }
  });
  assert.equal(await h.run(), false);
  const state = await h.request("GET", `${API}/jobs/${h.job.id}`);
  assert.equal(state.status, "failed");
  assert.equal(state.outfits.length, 0);
  assert.equal(h.calls.length, 1, "only the mocked planning request ran");
});

test("planning excludes corrupt unused cutouts from both visual sheets and permitted IDs", async (t) => {
  const h = await planningHarness(t);
  await fs.writeFile(path.join(h.dataDir, "imported", "top-6.png"), "invalid png");
  assert.equal(await h.run(), true);
  const ids = h.calls[0].text.format.schema.properties.outfits.items.properties.garmentIds.items.enum;
  assert.ok(!ids.includes("top-6"));
  assert.equal(ids.length, 12);
});
