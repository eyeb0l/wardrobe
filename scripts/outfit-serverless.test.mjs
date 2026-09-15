import assert from "node:assert/strict";
import * as localFs from "node:fs/promises";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { wardrobeOutfitApi } from "./outfit-api.mjs";
import { withStorage } from "./storage-fs.mjs";
import { API, harness, plan } from "./test-helpers/outfit-harness.mjs";

async function hostedHarness(t, options = {}) {
  const local = await harness(t);
  await local.close();
  const scheduled = [];
  const requests = [];
  const instances = [];
  const env = { OPENAI_API_KEY: "outfit-test-key", OPENAI_API_BASE_URL: "https://outfit-test.invalid/v1", WARDROBE_DATA_DIR: "custom-data", WARDROBE_MODEL_REFERENCE: "identity.png" };
  const fetchMock = async (url, init) => {
    assert.ok(url.startsWith("https://outfit-test.invalid/v1/"), "tests never call a real provider");
    const kind = url.endsWith("/responses") ? "planning" : "image";
    requests.push(kind);
    if (options.fetch) return options.fetch(kind, init);
    return kind === "planning"
      ? Response.json({ output_text: JSON.stringify({ outfits: options.plan || [plan(1), plan(2)] }) })
      : Response.json({ data: [{ b64_json: local.output.toString("base64") }] });
  };
  const makePlugin = async (overrides = {}) => {
    const instance = wardrobeOutfitApi({ serverless: true, env, fetch: fetchMock,
      scheduleTask: async (task) => { scheduled.push(task); await options.scheduleTask?.(task); }, ...overrides });
    instances.push(instance);
    await instance.configResolved({ root: local.root });
    return instance;
  };
  t.after(async () => { for (const instance of instances) await instance.closeBundle(); });
  const request = (instance, ...args) => local.requestPlugin(instance, ...args);
  const create = (instance, count = 2) => request(instance, "POST", `${API}/jobs`, { count, modelReferenceId: "default" }, 202);
  return { ...local, requests, scheduled, makePlugin, request, create };
}

test("hosted scheduling finishes before acceptance and never starts background generation", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let reached;
  const scheduling = new Promise((resolve) => { reached = resolve; });
  const h = await hostedHarness(t, { scheduleTask: async () => { reached(); await gate; } });
  const plugin = await h.makePlugin();
  let completed = false;
  const pending = h.create(plugin).then((value) => { completed = true; return value; });
  await scheduling;
  assert.equal(completed, false, "the response waits for durable task scheduling");
  assert.deepEqual(h.requests, []);
  release();
  const job = await pending;
  assert.equal(job.status, "planning");
  assert.equal(h.scheduled.length, 1);
  assert.deepEqual(h.scheduled[0], { kind: "outfit", jobId: job.id, taskId: h.scheduled[0].taskId });
  assert.match(h.scheduled[0].taskId, /^[a-f0-9-]{36}$/);
  assert.deepEqual(plugin.pendingTasks(), [h.scheduled[0]]);
  assert.deepEqual(h.requests, []);
  await assert.rejects(stat(path.join(h.dataDir, ".outfit-store.lock")), { code: "ENOENT" });
});

test("each hosted task runs one provider operation and survives fresh instances", async (t) => {
  const h = await hostedHarness(t);
  let plugin = await h.makePlugin();
  const job = await h.create(plugin);
  const task = h.scheduled[0];
  const file = path.join(h.dataDir, "outfit-jobs", job.id, "job.json");
  const original = await readFile(file, "utf8");
  await plugin.closeBundle();
  plugin = await h.makePlugin();
  assert.equal(await readFile(file, "utf8"), original, "cold startup preserves queued planning");
  assert.equal(await plugin.runTask(task), true);
  assert.deepEqual(h.requests, ["planning"]);
  let persisted = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(persisted.outfits.map((outfit) => outfit.status), ["planned", "planned"]);
  const plannedBytes = await readFile(file, "utf8");
  await plugin.closeBundle();
  plugin = await h.makePlugin();
  assert.equal(await readFile(file, "utf8"), plannedBytes, "cold startup preserves planned images");
  assert.equal(await plugin.runTask(task), true);
  assert.deepEqual(h.requests, ["planning", "image"]);
  persisted = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(persisted.outfits.map((outfit) => outfit.status), ["review", "planned"]);
  assert.deepEqual(persisted.outfits.map((outfit) => outfit.attempts), [1, 0]);
  await plugin.closeBundle();
  plugin = await h.makePlugin();
  assert.equal(await plugin.runTask(task), false);
  assert.deepEqual(h.requests, ["planning", "image", "image"]);
  const reviewed = await h.request(plugin, "GET", `${API}/jobs/${job.id}`);
  assert.equal(reviewed.status, "review");
  assert.deepEqual(plugin.pendingTasks(), []);
  assert.equal(await plugin.runTask(task), false, "a completed job is safe to redeliver");
  assert.equal(h.requests.length, 3);
  assert.equal(h.scheduled.length, 1, "the external runner owns continuation scheduling");
});

test("hosted startup preserves in-flight work and does not dispose another instance", async (t) => {
  const h = await hostedHarness(t, { plan: [plan()] });
  const first = await h.makePlugin();
  const job = await h.create(first, 1);
  await first.runTask(h.scheduled[0]);
  const file = path.join(h.dataDir, "outfit-jobs", job.id, "job.json");
  const persisted = JSON.parse(await readFile(file, "utf8"));
  persisted.outfits[0].status = "generating";
  persisted.outfits[0].attempts = 1;
  await writeFile(file, JSON.stringify(persisted));
  const before = await readFile(file, "utf8");
  const second = await h.makePlugin();
  assert.equal(await readFile(file, "utf8"), before);
  assert.deepEqual(second.pendingTasks(), [h.scheduled[0]]);
  assert.equal((await h.request(second, "GET", `${API}/jobs/${job.id}`)).outfits[0].status, "generating");
  assert.equal(await second.runTask(h.scheduled[0]), false, "an in-flight image is not automatically repeated");
  await second.closeBundle();
  assert.equal((await h.request(first, "GET", `${API}/config`)).ready, true);
  assert.deepEqual(h.requests, ["planning"]);
});

test("both hosted retry routes schedule saved work without executing it", async (t) => {
  let failImage = true;
  let h;
  h = await hostedHarness(t, { plan: [plan()], fetch: (kind) => kind === "planning"
    ? Response.json({ output_text: JSON.stringify({ outfits: [plan()] }) })
    : failImage ? Response.json({}, { status: 503 }) : Response.json({ data: [{ b64_json: h.output.toString("base64") }] }) });
  const plugin = await h.makePlugin();
  const job = await h.create(plugin, 1);
  const task = h.scheduled[0];
  assert.equal(await plugin.runTask(task), true);
  assert.equal(await plugin.runTask(task), false);
  assert.equal((await h.request(plugin, "GET", `${API}/jobs/${job.id}`)).status, "failed");
  await h.request(plugin, "POST", `${API}/jobs/${job.id}/retry`, {}, 202);
  assert.equal(h.scheduled.length, 2);
  assert.deepEqual(h.requests, ["planning", "image"]);
  failImage = false;
  assert.equal(await plugin.runTask(h.scheduled.at(-1)), false);
  const reviewed = await h.request(plugin, "GET", `${API}/jobs/${job.id}`);
  const outfit = reviewed.outfits[0];
  await h.request(plugin, "POST", `${API}/jobs/${job.id}/outfits/${outfit.id}/retry`, { prompt: "Keep the complete shoes visible." }, 202);
  assert.equal(h.scheduled.length, 3);
  assert.deepEqual(h.requests, ["planning", "image", "image"]);
  const saved = JSON.parse(await readFile(path.join(h.dataDir, "outfit-jobs", job.id, "job.json"), "utf8"));
  assert.equal(saved.outfits[0].status, "planned");
  assert.equal(saved.outfits[0].prompt, "Keep the complete shoes visible.");
  assert.ok(saved.outfits[0].internal.previousImage);
});

test("hosted scheduling failure is not reported as accepted and task validation avoids paid calls", async (t) => {
  const h = await hostedHarness(t, { scheduleTask: async () => { throw Object.assign(new Error("Task storage unavailable"), { status: 503 }); } });
  const plugin = await h.makePlugin();
  const failed = await h.request(plugin, "POST", `${API}/jobs`, { count: 1, modelReferenceId: "default" }, 503);
  assert.match(failed.error, /Task storage unavailable/);
  await assert.rejects(plugin.runTask({ kind: "import", jobId: h.scheduled[0].jobId }), { status: 400 });
  await assert.rejects(plugin.runTask({ kind: "outfit", jobId: "11111111-1111-4111-8111-111111111111" }), { status: 404 });
  assert.deepEqual(h.requests, []);
});

test("explicit task failure preserves review images and makes uncertain and queued work manually retryable", async (t) => {
  const h = await hostedHarness(t, { plan: [plan(1), plan(2), plan(3)] });
  let plugin = await h.makePlugin();
  const job = await h.create(plugin, 3);
  const task = h.scheduled[0];
  await plugin.runTask(task);
  await plugin.runTask(task);
  const file = path.join(h.dataDir, "outfit-jobs", job.id, "job.json");
  const saved = JSON.parse(await readFile(file, "utf8"));
  const reviewImage = saved.outfits[0].image;
  saved.outfits[1].status = "generating";
  saved.outfits[1].attempts = 1;
  await writeFile(file, JSON.stringify(saved));
  await plugin.closeBundle();
  plugin = await h.makePlugin();
  await plugin.failTask(task, "The execution expired. Check API usage before retrying.");
  const failed = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(failed.outfits.map((outfit) => outfit.status), ["review", "failed", "failed"]);
  assert.equal(failed.outfits[0].image, reviewImage);
  assert.match(failed.outfits[1].error, /Check API usage/);
  assert.equal(await plugin.runTask(task), false);
  assert.deepEqual(h.requests, ["planning", "image"]);
  await h.request(plugin, "POST", `${API}/jobs/${job.id}/retry`, {}, 202);
  assert.equal(h.scheduled.length, 2);
  const retry = await h.request(plugin, "GET", `${API}/jobs/${job.id}`);
  assert.deepEqual(retry.outfits.map((outfit) => outfit.status), ["review", "planned", "planned"]);
});

test("explicit task failure stops uncertain planning without calling the provider", async (t) => {
  const h = await hostedHarness(t);
  const plugin = await h.makePlugin();
  const job = await h.create(plugin);
  const task = h.scheduled[0];
  await plugin.failTask(task);
  const failed = await h.request(plugin, "GET", `${API}/jobs/${job.id}`);
  assert.equal(failed.status, "failed");
  assert.deepEqual(plugin.pendingTasks(), []);
  assert.match(failed.error, /unknown/);
  assert.equal(await plugin.runTask(task), false);
  assert.deepEqual(h.requests, []);
});

test("read-only instances never establish files and reject all mutation hooks", async (t) => {
  const h = await hostedHarness(t);
  await rm(path.join(h.dataDir, "outfits.json"));
  await rm(path.join(h.dataDir, "outfit-images"), { recursive: true });
  await rm(path.join(h.dataDir, "outfit-jobs"), { recursive: true });
  const plugin = await h.makePlugin({ readOnly: true });
  assert.deepEqual(await h.request(plugin, "GET", API), { version: 1, outfits: [] });
  assert.deepEqual(await h.request(plugin, "GET", `${API}/jobs`), { jobs: [], warnings: [] });
  assert.equal((await h.request(plugin, "GET", `${API}/config`)).ready, true);
  await h.request(plugin, "POST", `${API}/jobs`, { count: 1, modelReferenceId: "default" }, 409);
  await assert.rejects(plugin.runTask({ kind: "outfit", jobId: "11111111-1111-4111-8111-111111111111" }), { status: 409 });
  await assert.rejects(plugin.failTask({ kind: "outfit", jobId: "11111111-1111-4111-8111-111111111111" }), { status: 409 });
  for (const name of ["outfits.json", "outfit-images", "outfit-jobs", ".outfit-store.lock"]) {
    await assert.rejects(stat(path.join(h.dataDir, name)), { code: "ENOENT" });
  }
  assert.deepEqual(h.requests, []);
  assert.deepEqual(h.scheduled, []);
});

test("old hosted deliveries cannot generate or fail a newer explicit retry", async (t) => {
  const h = await hostedHarness(t, { plan: [plan()] });
  let plugin = await h.makePlugin();
  const job = await h.create(plugin, 1);
  const oldTask = h.scheduled[0];
  await plugin.runTask(oldTask);
  await plugin.failTask(oldTask, "Earlier execution was interrupted.");
  await h.request(plugin, "POST", `${API}/jobs/${job.id}/retry`, {}, 202);
  const retryTask = h.scheduled[1];
  assert.notEqual(retryTask.taskId, oldTask.taskId);
  const file = path.join(h.dataDir, "outfit-jobs", job.id, "job.json");
  const before = await readFile(file, "utf8");
  const saved = JSON.parse(before);
  assert.equal(saved.internal.cloudTaskId, retryTask.taskId);
  await plugin.closeBundle();
  plugin = await h.makePlugin();
  assert.equal(await plugin.runTask(oldTask), false);
  await plugin.failTask(oldTask, "Delayed failure from the old task.");
  assert.equal(await plugin.runTask({ kind: "outfit", jobId: job.id }), false);
  await plugin.failTask({ kind: "outfit", jobId: job.id });
  assert.equal(await readFile(file, "utf8"), before, "stale and unbound tasks do not change retry state");
  assert.deepEqual(h.requests, ["planning"]);
  assert.equal(await plugin.runTask(retryTask), false);
  assert.deepEqual(h.requests, ["planning", "image"]);
  assert.equal((await h.request(plugin, "GET", `${API}/jobs/${job.id}`)).outfits[0].status, "review");
});

test("create and retry atomically persist task identity with the authorized job state", async (t) => {
  const h = await hostedHarness(t, { plan: [plan()] });
  const plugin = await h.makePlugin();
  const snapshots = [];
  const observedStorage = { ...localFs, async rename(source, destination) {
    await localFs.rename(source, destination);
    if (destination.endsWith(`${path.sep}job.json`)) snapshots.push(JSON.parse(await localFs.readFile(destination, "utf8")));
  } };
  const job = await withStorage(observedStorage, () => h.create(plugin, 1));
  assert.equal(snapshots.length, 1, "new work and identity commit in one job write");
  assert.equal(snapshots[0].status, "planning");
  assert.equal(snapshots[0].internal.cloudTaskId, h.scheduled[0].taskId);
  assert.match(snapshots[0].internal.cloudTaskId, /^[a-f0-9-]{36}$/);

  await plugin.failTask(h.scheduled[0]);
  snapshots.length = 0;
  await withStorage(observedStorage, () => h.request(plugin, "POST", `${API}/jobs/${job.id}/retry`, {}, 202));
  assert.equal(snapshots.length, 1, "planning retry and new identity commit together");
  assert.equal(snapshots[0].status, "planning");
  assert.equal(snapshots[0].internal.cloudTaskId, h.scheduled[1].taskId);
  assert.notEqual(snapshots[0].internal.cloudTaskId, h.scheduled[0].taskId);

  await plugin.runTask(h.scheduled[1]);
  await plugin.runTask(h.scheduled[1]);
  const reviewed = await h.request(plugin, "GET", `${API}/jobs/${job.id}`);
  snapshots.length = 0;
  await withStorage(observedStorage, () => h.request(plugin, "POST", `${API}/jobs/${job.id}/outfits/${reviewed.outfits[0].id}/retry`, {}, 202));
  assert.equal(snapshots.length, 1, "image retry and new identity commit together");
  assert.equal(snapshots[0].outfits[0].status, "planned");
  assert.equal(snapshots[0].internal.cloudTaskId, h.scheduled[2].taskId);
  assert.notEqual(snapshots[0].internal.cloudTaskId, h.scheduled[1].taskId);
});
