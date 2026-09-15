import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import test from "node:test";
import { API, harness, plan } from "./test-helpers/outfit-harness.mjs";

async function failRename(t, destination, code = "ENOSPC") {
  const original = fs.rename;
  let remaining = 1;
  fs.rename = async (from, to) => {
    if (to === destination && remaining-- > 0) throw Object.assign(new Error("Injected local write failure"), { code });
    return original(from, to);
  };
  syncBuiltinESMExports();
  const restore = () => { fs.rename = original; syncBuiltinESMExports(); };
  t.after(restore);
  return restore;
}
const jobPath = async (h, job) => path.join(await fs.realpath(h.dataDir), "outfit-jobs", job.id, "job.json");

for (const action of ["retry", "reject"]) test(`failed ${action} save leaves review unchanged and usable`, async (t) => {
  const h = await harness(t);
  const job = await h.settled((await h.create()).id);
  const file = await jobPath(h, job);
  const before = await fs.readFile(file, "utf8");
  const calls = h.requests.length;
  const restore = await failRename(t, file);
  await h.action(job, job.outfits[0], action, {}, 500);
  restore();
  assert.equal(await fs.readFile(file, "utf8"), before);
  assert.deepEqual(await h.request("GET", `${API}/jobs/${job.id}`), job);
  assert.equal(h.requests.length, calls);
  await h.action(job, job.outfits[0], action, {});
  const next = await h.settled(job.id);
  assert.equal(next.outfits[0].status, action === "retry" ? "review" : "rejected");
});

test("failed planning retry save remains explicitly retryable without restart", async (t) => {
  const h = await harness(t, { analysis: () => Response.json({}, { status: 503 }) });
  const job = await h.settled((await h.create()).id);
  const file = await jobPath(h, job);
  const before = await fs.readFile(file, "utf8");
  const restore = await failRename(t, file);
  await h.request("POST", `${API}/jobs/${job.id}/retry`, {}, 500);
  restore();
  assert.equal((await h.request("GET", `${API}/jobs/${job.id}`)).status, "failed");
  assert.equal(await fs.readFile(file, "utf8"), before);
  h.setAnalysis([plan()]);
  await h.request("POST", `${API}/jobs/${job.id}/retry`, {}, 202);
  assert.equal((await h.settled(job.id)).status, "review");
});

test("failed manifest save followed by regeneration can accept the new image", async (t) => {
  const h = await harness(t);
  const job = await h.settled((await h.create()).id);
  const manifest = path.join(await fs.realpath(h.dataDir), "outfits.json");
  const before = await fs.readFile(manifest, "utf8");
  const restore = await failRename(t, manifest, "EACCES");
  await h.action(job, job.outfits[0], "approve", {}, 500);
  restore();
  assert.equal(await fs.readFile(manifest, "utf8"), before);
  const oldImages = await fs.readdir(path.join(h.dataDir, "outfit-images"));
  const orphan = oldImages.find((name) => name.startsWith(job.outfits[0].id));
  assert.ok(orphan);
  const oldBytes = await fs.readFile(path.join(h.dataDir, "outfit-images", orphan));
  const different = await h.image("#123456");
  h.setEdit(() => Response.json({ data: [{ b64_json: different.toString("base64") }] }));
  await h.action(job, job.outfits[0], "retry", {});
  const next = await h.settled(job.id);
  await h.action(next, next.outfits[0], "approve", {});
  await h.action(next, next.outfits[0], "approve", {});
  const saved = JSON.parse(await fs.readFile(manifest, "utf8"));
  assert.equal(saved.outfits.length, 7);
  assert.deepEqual(saved.outfits.slice(0, 6), h.originals);
  assert.notEqual(path.basename(saved.outfits[6].image), orphan);
  assert.deepEqual(await fs.readFile(path.join(h.dataDir, "outfit-images", orphan)), oldBytes);
  assert.deepEqual(await fs.readFile(path.join(h.dataDir, "outfit-images", path.basename(saved.outfits[6].image))), different);
});

test("manifest commit survives job-save failure and blocks reject or paid retry", async (t) => {
  const h = await harness(t);
  const job = await h.settled((await h.create()).id);
  const restore = await failRename(t, await jobPath(h, job));
  await h.action(job, job.outfits[0], "approve", {}, 500);
  restore();
  assert.equal((await h.request("GET", API)).outfits.length, 7);
  const calls = h.requests.length;
  await h.action(job, job.outfits[0], "reject", {}, 409);
  await h.action(job, job.outfits[0], "retry", {}, 409);
  assert.equal(h.requests.length, calls);
  assert.equal((await h.request("GET", `${API}/jobs/${job.id}`)).outfits[0].status, "accepted");
  await h.restart();
  assert.equal((await h.request("GET", `${API}/jobs/${job.id}`)).outfits[0].status, "accepted");
  assert.equal(h.requests.length, calls);
});

for (const corrupt of [false, true]) test(`retry tolerates a ${corrupt ? "corrupt" : "missing"} optional previous candidate`, async (t) => {
  const h = await harness(t);
  const job = await h.settled((await h.create()).id);
  const file = path.join(h.dataDir, "outfit-jobs", job.id, path.basename(job.outfits[0].image));
  if (corrupt) await fs.writeFile(file, "not a PNG"); else await fs.rm(file);
  await h.action(job, job.outfits[0], "retry", {});
  const next = await h.settled(job.id);
  assert.equal(next.status, "review");
  assert.equal(h.requests.filter((request) => request.kind === "edit").length, 2);
  assert.ok(!h.requests.at(-1).images.some((image) => image.name === "previous-attempt.png"));
});

test("startup isolates corrupt and future jobs, exposes warnings, and preserves their bytes", async (t) => {
  const h = await harness(t);
  const reviewed = await h.settled((await h.create()).id);
  const template = JSON.parse(await fs.readFile(await jobPath(h, reviewed), "utf8"));
  await h.close();
  const files = [];
  for (const kind of ["parse", "null", "future"]) {
    const id = randomUUID();
    const dir = path.join(h.dataDir, "outfit-jobs", id);
    await fs.mkdir(dir);
    const value = { ...template, id, ...(kind === "null" ? { outfits: [null] } : { version: 2, status: "planning", outfits: [] }) };
    const bytes = kind === "parse" ? "{" : JSON.stringify(value);
    const file = path.join(dir, "job.json");
    await fs.writeFile(file, bytes);
    files.push({ file, bytes, id });
  }
  const calls = h.requests.length;
  await h.restart();
  const result = await h.request("GET", `${API}/jobs`);
  assert.deepEqual(result.jobs.map((job) => job.id), [reviewed.id]);
  assert.equal(result.warnings.length, 3);
  for (const { file, bytes, id } of files) {
    assert.equal(await fs.readFile(file, "utf8"), bytes);
    assert.ok(result.warnings.some((warning) => warning.includes(`outfit-jobs/${id}/job.json`)));
  }
  assert.equal(h.requests.length, calls);
});

test("missing established manifest fails closed and failed startup releases ownership", async (t) => {
  const h = await harness(t);
  const file = path.join(h.dataDir, "outfits.json");
  const original = await fs.readFile(file);
  await h.close();
  await fs.rm(file);
  await assert.rejects(h.restart(), /outfits\.json.*missing.*photos or jobs/);
  await assert.rejects(fs.stat(file), { code: "ENOENT" });
  await fs.writeFile(file, original);
  await h.restart();
  assert.equal((await h.request("GET", API)).outfits.length, 6);
});

test("brand-new store establishes an empty manifest before first generation", async (t) => {
  const h = await harness(t, { seed: false });
  await h.close();
  await fs.rm(path.join(h.dataDir, "outfits.json"));
  await h.restart();
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(h.dataDir, "outfits.json"), "utf8")), { version: 1, outfits: [] });
  const job = await h.settled((await h.create()).id);
  assert.equal(job.version, 1);
  assert.equal(job.status, "review");
});

test("accepted photo responses do not retain same-filename stale browser images", async (t) => {
  const h = await harness(t);
  const response = await h.request("GET", `${API}/images/original-1.png`, undefined, null);
  assert.equal(response.status, 200);
  assert.equal(response.headers["cache-control"], "no-store");
});

test("accepted jobs missing from an older restored manifest are preserved and reported", async (t) => {
  const h = await harness(t);
  const manifest = path.join(h.dataDir, "outfits.json");
  const older = await fs.readFile(manifest);
  const job = await h.settled((await h.create()).id);
  await h.action(job, job.outfits[0], "approve", {});
  const jobFile = await jobPath(h, job);
  const accepted = await fs.readFile(jobFile);
  await h.close();
  await fs.writeFile(manifest, older);
  await h.restart();
  const result = await h.request("GET", `${API}/jobs`);
  assert.equal(result.jobs.length, 0);
  assert.match(result.warnings[0], /Accepted outfit .* missing from outfits.json/);
  assert.deepEqual(await fs.readFile(jobFile), accepted);
  assert.deepEqual(await fs.readFile(manifest), older);
});

test("API holds process ownership until shutdown and then allows another writer", async (t) => {
  const { acquireOutfitStoreLock } = await import("./outfit-store-lock.mjs");
  const h = await harness(t);
  await assert.rejects(acquireOutfitStoreLock(h.dataDir), { status: 503 });
  await h.close();
  const release = await acquireOutfitStoreLock(h.dataDir);
  await release();
  await h.restart();
  await assert.rejects(acquireOutfitStoreLock(h.dataDir), { status: 503 });
});

test("persistent progress-save failure reports retryable failure without paid replay", async (t) => {
  let releaseAnalysis;
  const h = await harness(t, { analysis: () => new Promise((resolve) => { releaseAnalysis = () => resolve(Response.json({ output_text: JSON.stringify({ outfits: [plan()] }) })); }) });
  const job = await h.create();
  const file = await jobPath(h, job);
  const original = fs.rename;
  fs.rename = async (from, to) => {
    if (to === file) throw Object.assign(new Error("Injected persistent disk full"), { code: "ENOSPC" });
    return original(from, to);
  };
  syncBuiltinESMExports();
  t.after(() => { fs.rename = original; syncBuiltinESMExports(); });
  for (let i = 0; i < 200 && !releaseAnalysis; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(releaseAnalysis);
  releaseAnalysis();
  const failed = await h.settled(job.id);
  assert.equal(failed.status, "failed");
  assert.ok(!failed.outfits.some((outfit) => ["planned", "generating"].includes(outfit.status)));
  assert.equal(h.requests.length, 1);
  fs.rename = original; syncBuiltinESMExports();
  h.setAnalysis([plan()]);
  await h.request("POST", `${API}/jobs/${job.id}/retry`, {}, 202);
  assert.equal((await h.settled(job.id)).status, "review");
});
