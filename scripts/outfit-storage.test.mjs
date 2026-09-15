import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { acceptedFilename, atomicJson, publishImage, readManifest, validateJob, validateManifest } from "./outfit-storage.mjs";

const id = "11111111-1111-4111-8111-111111111111";
const date = "2026-09-15T01:00:00.000Z";
const outfit = () => ({ id: "test-look", name: "Test look", garmentIds: ["top-1", "bottom-1"], occasion: ["casual"], reason: "Balanced shapes.", setting: "A courtyard", status: "accepted", image: "outfit-images/test-look.png" });
const manifest = () => ({ version: 1, outfits: [outfit()] });
const job = () => ({
  id, count: 1, direction: "", modelReferenceId: "default", status: "review", createdAt: date, updatedAt: date, error: null,
  outfits: [{ ...outfit(), status: "review", image: `/api/outfits/jobs/${id}/assets/candidate.png`, attempts: 1, prompt: null, error: null,
    internal: { candidateFile: "candidate.png", history: [{ attempt: 1, at: date, model: "test-image-model", prompt: "Generate the outfit.", correction: null, references: ["identity.png", "upperbody-top-1.png"] }] } }], internal: {},
});

async function temporary(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "outfit-storage-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

const invalidStorage = (error) => error.status === 503 && /(?:outfits|job)\.json/.test(error.message) && /Preserve/.test(error.message);

test("manifest accepts legacy image routes and preserves unknown metadata", async (t) => {
  const directory = await temporary(t);
  const file = path.join(directory, "outfits.json");
  for (const prefix of ["outfit-images/", "/api/outfits/images/", "/api/import/outfits/"]) {
    const value = { ...manifest(), collectionNote: { revision: 7 } };
    value.outfits[0].image = `${prefix}test-look.png`;
    value.outfits[0].customStyling = { label: "Keep me" };
    await writeFile(file, JSON.stringify(value));
    const result = await readManifest(directory);
    assert.deepEqual(result, value);
    assert.equal(acceptedFilename(result.outfits[0].image), "test-look.png");
  }
  for (const image of ["../test.png", "/api/outfits/images/../test.png", "https://example.com/test.png", "/api/import/outfits/a/b.png", "outfit-images/test.png?new=1", null, {}]) assert.equal(acceptedFilename(image), null);
});

test("manifest validates consumed row types and IDs before callers can mutate", () => {
  const cases = [
    (value) => { value.outfits = [null]; },
    (value) => { value.outfits.push(structuredClone(value.outfits[0])); },
    (value) => { value.outfits[0].id = "../escape"; },
    (value) => { value.outfits[0].name = {}; },
    (value) => { value.outfits[0].occasion = "casual"; },
    (value) => { value.outfits[0].occasion = [null]; },
    (value) => { value.outfits[0].garmentIds = ["top-1", "top-1"]; },
    (value) => { value.outfits[0].garmentIds = [7]; },
    (value) => { value.outfits[0].reason = {}; },
    (value) => { value.outfits[0].status = "future-state"; },
    (value) => { value.outfits[0].image = "../../secret.png"; },
    (value) => { value.outfits[0].createdAt = 1; },
  ];
  for (const mutate of cases) {
    const value = manifest();
    mutate(value);
    const before = structuredClone(value);
    assert.throws(() => validateManifest(value), invalidStorage);
    assert.deepEqual(value, before);
  }
  for (const status of ["planned", "generating", "generated", "review", "accepted", "rejected", "failed"]) {
    const value = manifest();
    value.outfits[0].status = status;
    if (status !== "accepted") value.outfits[0].image = null;
    assert.deepEqual(validateManifest(value), value);
  }
});

test("missing manifest is empty only when the outfit store is new", async (t) => {
  const directory = await temporary(t);
  const empty = { version: 1, outfits: [] };
  assert.deepEqual(await readManifest(directory), empty);
  await mkdir(path.join(directory, "outfit-images"));
  await mkdir(path.join(directory, "outfit-jobs"));
  await writeFile(path.join(directory, "library.json"), "[]");
  assert.deepEqual(await readManifest(directory), empty);
  const photo = path.join(directory, "outfit-images", "orphan.png");
  await writeFile(photo, "preserved photo");
  await assert.rejects(readManifest(directory), (error) => invalidStorage(error) && /missing/.test(error.message));
  assert.equal(await readFile(photo, "utf8"), "preserved photo");
  await rm(photo);
  await mkdir(path.join(directory, "outfit-jobs", id));
  await assert.rejects(readManifest(directory), invalidStorage);
  await assert.rejects(readFile(path.join(directory, "outfits.json")), { code: "ENOENT" });
});

test("corrupt, unsupported and unreadable manifests remain unchanged", async (t) => {
  const directory = await temporary(t);
  const file = path.join(directory, "outfits.json");
  for (const contents of ["{broken-json", JSON.stringify({ version: 2, outfits: [] }), JSON.stringify({ outfits: [] }), JSON.stringify({ version: 1, outfits: [null] })]) {
    await writeFile(file, contents);
    await assert.rejects(readManifest(directory), invalidStorage);
    assert.equal(await readFile(file, "utf8"), contents);
  }
  await rm(file);
  await mkdir(file);
  await assert.rejects(readManifest(directory), (error) => invalidStorage(error) && /could not be read/.test(error.message));
});

test("job validator clones legacy records and adds only version and internal defaults", () => {
  const value = job();
  delete value.internal;
  delete value.outfits[0].internal;
  value.custom = { keep: true };
  value.outfits[0].custom = ["preserved"];
  const before = structuredClone(value);
  const result = validateJob(value, id);
  assert.equal(result.version, 1);
  assert.deepEqual(result.internal, {});
  assert.deepEqual(result.outfits[0].internal, { history: [] });
  assert.deepEqual(result.custom, value.custom);
  assert.deepEqual(result.outfits[0].custom, value.outfits[0].custom);
  result.custom.keep = false;
  assert.deepEqual(value, before);
  assert.deepEqual(validateJob({ ...job(), version: 1 }, id), { ...job(), version: 1 });
});

test("job validator checks fields used during startup and retry", () => {
  const cases = [
    (value) => { value.outfits = [null]; },
    (value) => { value.id = "../../other"; },
    (value) => { value.count = "1"; },
    (value) => { value.direction = []; },
    (value) => { value.createdAt = null; },
    (value) => { value.updatedAt = "tomorrow-ish"; },
    (value) => { value.modelReferenceId = {}; },
    (value) => { value.status = "unknown"; },
    (value) => { value.internal = []; },
    (value) => { value.outfits[0].attempts = -1; },
    (value) => { value.outfits[0].attempts = "1"; },
    (value) => { value.outfits[0].error = {}; },
    (value) => { value.outfits[0].prompt = []; },
    (value) => { value.outfits[0].internal.history = {}; },
    (value) => { value.outfits[0].internal.history = [null]; },
    (value) => { value.outfits[0].internal.history[0].attempt = 2; },
    (value) => { value.outfits[0].internal.history[0].references = ["../secret.png"]; },
    (value) => { value.outfits[0].internal.candidateFile = "../secret.png"; },
    (value) => { value.outfits[0].internal.previousImage = {}; },
    (value) => { value.count = 2; value.outfits.push(structuredClone(value.outfits[0])); },
  ];
  for (const mutate of cases) {
    const value = job();
    mutate(value);
    const before = structuredClone(value);
    assert.throws(() => validateJob(value, id), invalidStorage);
    assert.deepEqual(value, before);
  }
});

test("future job versions are rejected before normalization and preserve original bytes", async (t) => {
  const directory = await temporary(t);
  const file = path.join(directory, "job.json");
  const contents = JSON.stringify({ version: 2, id, status: "generating", outfits: [null] });
  await writeFile(file, contents);
  const value = JSON.parse(await readFile(file, "utf8"));
  assert.throws(() => validateJob(value, id), (error) => invalidStorage(error) && /Unsupported job version 2/.test(error.message));
  assert.equal(await readFile(file, "utf8"), contents);
  assert.equal(value.internal, undefined);
});

test("job validation accepts valid references without requiring assets to exist", () => {
  const value = job();
  value.modelReferenceId = "model-reference-20";
  value.outfits[0].internal.previousImage = "deleted-previous.png";
  value.outfits[0].internal.extra = { version: 3 };
  value.outfits[0].internal.history[0].providerDetails = { keep: true };
  assert.deepEqual(validateJob(value, id), { ...value, version: 1 });
});

test("atomic JSON replacement leaves no temporary files and preserves an obstructing destination", async (t) => {
  const directory = await temporary(t);
  const file = path.join(directory, "outfits.json");
  await atomicJson(file, manifest());
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), manifest());
  await rm(file);
  await mkdir(file);
  await writeFile(path.join(file, "preserve-me"), "original");
  await assert.rejects(atomicJson(file, manifest()));
  assert.equal(await readFile(path.join(file, "preserve-me"), "utf8"), "original");
  assert.deepEqual(await readdir(directory), ["outfits.json"]);
});

test("image publication is idempotent and never overwrites existing files or symlinks", async (t) => {
  const directory = await temporary(t);
  const file = path.join(directory, "accepted.png");
  await Promise.all([publishImage(file, Buffer.from("complete image")), publishImage(file, Buffer.from("complete image"))]);
  assert.equal(await readFile(file, "utf8"), "complete image");
  await assert.rejects(publishImage(file, Buffer.from("different image")), { status: 409 });
  assert.equal(await readFile(file, "utf8"), "complete image");
  const alias = path.join(directory, "alias.png");
  await symlink(file, alias);
  await assert.rejects(publishImage(alias, Buffer.from("complete image")), { status: 409 });
  assert.deepEqual((await readdir(directory)).sort(), ["accepted.png", "alias.png"]);
});

test("long immutable image and JSON filenames use short temporary siblings", async (t) => {
  const directory = await temporary(t);
  const longId = "x".repeat(160);
  const imageName = `${longId}-${"a".repeat(64)}.png`;
  const imagePath = path.join(directory, imageName);
  const value = manifest();
  value.outfits[0].id = longId;
  value.outfits[0].image = `outfit-images/${imageName}`;
  validateManifest(value);
  await publishImage(imagePath, Buffer.from("complete long-named image"));
  assert.equal(await readFile(imagePath, "utf8"), "complete long-named image");
  await assert.rejects(publishImage(imagePath, Buffer.from("different image")), { status: 409 });
  const jsonName = `${"j".repeat(230)}.json`;
  const jsonPath = path.join(directory, jsonName);
  await atomicJson(jsonPath, value);
  assert.deepEqual(JSON.parse(await readFile(jsonPath, "utf8")), value);
  await rm(jsonPath);
  await mkdir(jsonPath);
  await writeFile(path.join(jsonPath, "preserve-me"), "original");
  await assert.rejects(atomicJson(jsonPath, value));
  assert.equal(await readFile(path.join(jsonPath, "preserve-me"), "utf8"), "original");
  assert.deepEqual((await readdir(directory)).sort(), [imageName, jsonName].sort());
});
