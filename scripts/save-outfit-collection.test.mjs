import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import sharp from "sharp";
import { saveOutfitCollection } from "./save-outfit-collection.mjs";
import { acquireOutfitStoreLock } from "./outfit-store-lock.mjs";

const execFileAsync = promisify(execFile);
const outfit = (id) => ({ id, name: `Look ${id}`, occasion: ["casual"], garmentIds: ["top-1", "bottom-1"], reason: "Balanced colors", setting: "Stone courtyard", status: "accepted", image: `outfit-images/${id}.png` });
async function fixture(t, { existing = true } = {}) {
  const root = await fs.realpath(await mkdtemp(path.join(os.tmpdir(), "wardrobe-save-collection-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  const stage = path.join(root, "stage");
  await mkdir(path.join(dataDir, "outfit-images"), { recursive: true });
  await mkdir(path.join(stage, "outfit-images"), { recursive: true });
  const image = (color = "#aa9988") => sharp({ create: { width: 40, height: 40, channels: 4, background: color } }).png().toBuffer();
  const bytes = await image();
  const first = { ...outfit("old-look"), futureMetadata: { rating: 3 } };
  const manifest = { version: 1, futureCollectionField: { keep: true }, outfits: existing ? [first] : [] };
  await writeFile(path.join(dataDir, "outfits.json"), JSON.stringify(manifest));
  if (existing) await writeFile(path.join(dataDir, first.image), bytes);
  const stagedManifestPath = path.join(stage, "outfits.json");
  async function staging(items = [outfit("new-look")], content = bytes) {
    for (const item of items) await writeFile(path.join(stage, item.image), content);
    await writeFile(stagedManifestPath, JSON.stringify({ version: 1, outfits: items }));
  }
  await staging();
  return { root, dataDir, stage, stagedManifestPath, manifest, first, bytes, image, staging,
    save: () => saveOutfitCollection({ dataDir, stagedManifestPath }),
    read: async () => JSON.parse(await readFile(path.join(dataDir, "outfits.json"), "utf8")),
  };
}

test("staged saves append, preserve unknown fields, and are idempotent", async (t) => {
  const h = await fixture(t);
  const result = await h.save();
  assert.equal(result.added, 1);
  assert.equal(result.total, 2);
  const saved = await h.read();
  assert.deepEqual(saved.outfits[0], h.first);
  assert.deepEqual(saved.futureCollectionField, { keep: true });
  assert.match(saved.outfits[1].image, /^\/api\/outfits\/images\/new-look-[a-f0-9]{64}\.png$/);
  const originalManifest = await readFile(path.join(h.dataDir, "outfits.json"), "utf8");
  const rerun = await h.save();
  assert.equal(rerun.added, 0);
  assert.equal(rerun.existing, 1);
  assert.equal(await readFile(path.join(h.dataDir, "outfits.json"), "utf8"), originalManifest);
  assert.equal((await readdir(path.join(h.dataDir, "outfit-images"))).length, 2);
});

test("conflicting IDs fail before writing any candidate images", async (t) => {
  const h = await fixture(t);
  await h.staging([outfit("new-look"), { ...outfit("old-look"), name: "Changed" }]);
  await assert.rejects(h.save(), { status: 409 });
  assert.deepEqual(await h.read(), h.manifest);
  assert.deepEqual(await readdir(path.join(h.dataDir, "outfit-images")), ["old-look.png"]);
  await h.staging([outfit("old-look")], await h.image("red"));
  await assert.rejects(h.save(), { status: 409 });
  assert.deepEqual(await readFile(path.join(h.dataDir, h.first.image)), h.bytes);
});

test("an existing identical legacy record retains its metadata and filename", async (t) => {
  const h = await fixture(t);
  await h.staging([outfit("old-look")]);
  const result = await h.save();
  assert.equal(result.existing, 1);
  assert.deepEqual(await h.read(), h.manifest);
});

test("immutable filename collisions never replace stored images", async (t) => {
  const h = await fixture(t);
  const filename = `new-look-${createHash("sha256").update(h.bytes).digest("hex")}.png`;
  const other = await h.image("red");
  await writeFile(path.join(h.dataDir, "outfit-images", filename), other);
  await assert.rejects(h.save(), { status: 409 });
  assert.deepEqual(await readFile(path.join(h.dataDir, "outfit-images", filename)), other);
  assert.deepEqual(await h.read(), h.manifest);
});

test("failed manifest save can be retried with a regenerated image", async (t) => {
  const h = await fixture(t);
  const rename = fs.rename;
  fs.rename = async (source, destination) => {
    if (destination === path.join(h.dataDir, "outfits.json")) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    return rename(source, destination);
  };
  syncBuiltinESMExports();
  try { await assert.rejects(h.save(), /disk full/); }
  finally { fs.rename = rename; syncBuiltinESMExports(); }
  assert.deepEqual(await h.read(), h.manifest);
  await h.staging([outfit("new-look")], await h.image("red"));
  assert.equal((await h.save()).added, 1);
  assert.equal((await h.read()).outfits.length, 2);
});

test("brand-new stores retain a retryable manifest after a partial commit", async (t) => {
  const h = await fixture(t, { existing: false });
  await rm(path.join(h.dataDir, "outfits.json"));
  const rename = fs.rename;
  let writes = 0;
  fs.rename = async (source, destination) => {
    if (destination === path.join(h.dataDir, "outfits.json") && ++writes === 2) throw new Error("interrupted final save");
    return rename(source, destination);
  };
  syncBuiltinESMExports();
  try { await assert.rejects(h.save(), /interrupted final save/); }
  finally { fs.rename = rename; syncBuiltinESMExports(); }
  assert.deepEqual(await h.read(), { version: 1, outfits: [] });
  assert.equal((await h.save()).added, 1);
});

test("staging symlink escapes and live writer ownership are rejected", async (t) => {
  const h = await fixture(t);
  const release = await acquireOutfitStoreLock(h.dataDir);
  await assert.rejects(h.save(), { status: 503 });
  await release();
  const source = path.join(h.stage, "outfit-images", "new-look.png");
  await rm(source);
  await symlink(path.join(h.dataDir, h.first.image), source);
  await assert.rejects(h.save(), /outside its staging directory/);
  assert.deepEqual(await h.read(), h.manifest);
});

test("CLI honors WARDROBE_DATA_DIR without touching repository data", async (t) => {
  const h = await fixture(t);
  const script = new URL("./save-outfit-collection.mjs", import.meta.url);
  const { stdout } = await execFileAsync(process.execPath, [script.pathname, h.stagedManifestPath], { env: { ...process.env, WARDROBE_DATA_DIR: h.dataDir } });
  assert.equal(JSON.parse(stdout).added, 1);
  assert.equal((await h.read()).outfits.length, 2);
});
