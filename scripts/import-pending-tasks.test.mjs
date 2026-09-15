import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import * as nativeFs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Readable } from "node:stream";
import { wardrobeImportApi } from "./import-job-api.mjs";
import { withStorage } from "./storage-fs.mjs";

async function harness(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wardrobe-import-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", () => assert.fail("Recovery must not contact a paid API"));
  const jobsDir = path.join(root, "data", "jobs");
  const tasks = [];
  const plugin = wardrobeImportApi({ serverless: true, readOnly: true,
    env: { WARDROBE_DATA_DIR: path.join(root, "data") },
    scheduleTask: async (task) => tasks.push(structuredClone(task)),
  });
  await plugin.configResolved({ root });
  let handler;
  plugin.configureServer({ middlewares: { use(value) { handler = value; } } });
  async function request(id, stage, action, payload = {}) {
    const req = Readable.from([Buffer.from(JSON.stringify(payload))]);
    Object.assign(req, { method: "POST", url: `/api/import/jobs/${id}/stages/${stage}/${action}`,
      headers: { host: "wardrobe.example", "x-forwarded-proto": "https", origin: "https://wardrobe.example", "sec-fetch-site": "same-origin", "content-type": "application/json" } });
    let result;
    const res = { statusCode: 200, setHeader() {}, end(value) { result = JSON.parse(value); } };
    await handler(req, res, () => assert.fail("Unexpected middleware fallthrough"));
    return { status: res.statusCode, body: result };
  }
  async function save(job, id = job.id) {
    const directory = path.join(jobsDir, id);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "job.json"), typeof job === "string" ? job : JSON.stringify(job));
  }
  return { root, jobsDir, plugin, save, request, tasks };
}

const job = (stageName, status, attempts = 0) => ({
  id: randomUUID(), status: "active", stages: {
    crop: { status: "approved" }, garment: { status: "approved", attempts: 1 }, modeled: { status: "pending", attempts: 0 },
    [stageName]: { status, attempts, taskId: randomUUID() },
  },
});

test("import outbox recovery discovers exact current queued, pending, and processing task identities without writes", async (t) => {
  const h = await harness(t);
  const queued = job("garment", "queued", 2);
  const pending = job("modeled", "pending", 1);
  pending.generationId = randomUUID();
  pending.modeledReplacement = true;
  const processing = job("modeled", "processing", 3);
  const jobs = [queued, pending, processing];
  for (const current of jobs) await h.save(current);
  const snapshots = await Promise.all(jobs.map((current) => readFile(path.join(h.jobsDir, current.id, "job.json"), "utf8")));
  const tasks = await h.plugin.pendingTasks();
  assert.equal(tasks.length, 3);
  for (const current of jobs) {
    const stageName = current === queued ? "garment" : "modeled";
    const stage = current.stages[stageName];
    assert.deepEqual(tasks.find((task) => task.jobId === current.id), {
      kind: "import", jobId: current.id, stageName, taskId: stage.taskId,
      attempt: stage.attempts + (stage.status === "processing" ? 0 : 1),
      generationId: current.generationId || null,
    });
  }
  assert.deepEqual(await Promise.all(jobs.map((current) => readFile(path.join(h.jobsDir, current.id, "job.json"), "utf8"))), snapshots);
  assert.deepEqual(await h.plugin.pendingTasks(), tasks, "repeated discovery returns stable task identities");
  assert.deepEqual(h.tasks, [], "discovery does not dispatch work itself");
});

test("import outbox recovery ignores finished, malformed, and superseded stages", async (t) => {
  const h = await harness(t);
  const invalid = [];
  for (const status of ["review", "approved", "failed", "rejected", "ready"]) invalid.push(job("garment", status));
  const complete = job("garment", "queued"); complete.status = "complete"; invalid.push(complete);
  const noIdentity = job("garment", "pending"); delete noIdentity.stages.garment.taskId; invalid.push(noIdentity);
  const invalidIdentity = job("garment", "queued"); invalidIdentity.stages.garment.taskId = "old"; invalid.push(invalidIdentity);
  const cropReview = job("garment", "queued"); cropReview.stages.crop.status = "review"; invalid.push(cropReview);
  const rejected = job("modeled", "queued"); rejected.stages.crop.status = "rejected"; invalid.push(rejected);
  const unapprovedGarment = job("modeled", "queued"); unapprovedGarment.stages.garment.status = "review"; invalid.push(unapprovedGarment);
  const replacingGarment = job("garment", "queued"); replacingGarment.modeledReplacement = true; invalid.push(replacingGarment);
  const wrongId = job("garment", "queued"); await h.save(wrongId, randomUUID());
  const badGeneration = job("modeled", "queued"); badGeneration.generationId = "old"; invalid.push(badGeneration);
  for (const attempts of [-1, 0.5, "1", Number.MAX_SAFE_INTEGER]) {
    const badAttempt = job("garment", "queued", attempts); invalid.push(badAttempt);
  }
  invalid.push(job("modeled", "processing", 0));
  for (const current of invalid) await h.save(current);
  await h.save("{broken", randomUUID());
  await h.save(job("garment", "queued"), "not-a-job");
  await writeFile(path.join(h.jobsDir, randomUUID()), "not-a-directory");
  const before = await readdir(h.jobsDir);
  assert.deepEqual(await h.plugin.pendingTasks(), []);
  assert.deepEqual(await readdir(h.jobsDir), before);
});

test("recovery handles a fresh empty store and stays disabled for local plugins", async (t) => {
  const h = await harness(t);
  assert.deepEqual(await h.plugin.pendingTasks(), []);
  assert.deepEqual(await wardrobeImportApi().pendingTasks(), []);
});

for (const [triggerStage, action, generatedStage] of [
  ["crop", "approve", "garment"],
  ["garment", "approve", "modeled"],
  ["garment", "regenerate", "garment"],
  ["modeled", "regenerate", "modeled"],
]) {
  test(`a crash immediately after ${triggerStage} ${action} saves a recoverable new ${generatedStage} task`, async (t) => {
    const h = await harness(t);
    const current = job(generatedStage, action === "regenerate" ? "review" : "pending", 2);
    current.stages[triggerStage].status = "review";
    await h.save(current);
    await writeFile(path.join(h.root, "data", "model-reference.png"), "reference");
    const previousTaskId = current.stages[generatedStage].taskId;
    const filename = path.join(h.jobsDir, current.id, "job.json");
    let committed;
    const response = await withStorage({ ...nativeFs,
      async rename(source, destination) {
        await nativeFs.rename(source, destination);
        if (destination === filename) {
          committed = JSON.parse(await nativeFs.readFile(filename, "utf8"));
          throw new Error("Simulated process termination after the first committed job save");
        }
      },
    }, () => h.request(current.id, triggerStage, action, { prompt: "Updated direction" }));
    assert.equal(response.status, 500);
    assert.deepEqual(h.tasks, [], "the scheduler callback has not been reached");
    assert.equal(committed.stages[generatedStage].status, "queued");
    assert.match(committed.stages[generatedStage].taskId, /^[a-f0-9-]{36}$/);
    assert.notEqual(committed.stages[generatedStage].taskId, previousTaskId, "a new authorization never reuses a prior task identity");
    if (action === "approve") assert.equal(committed.stages[triggerStage].status, "approved");
    else assert.equal(committed.stages[generatedStage].prompt, "Updated direction");
    assert.deepEqual(await h.plugin.pendingTasks(), [{
      kind: "import", jobId: current.id, stageName: generatedStage,
      taskId: committed.stages[generatedStage].taskId, attempt: 3, generationId: null,
    }]);
  });
}

test("regeneration dispatch reuses its committed identity and performs only one job publication", async (t) => {
  const h = await harness(t);
  const current = job("garment", "review", 2);
  await h.save(current);
  const filename = path.join(h.jobsDir, current.id, "job.json");
  const publications = [];
  const response = await withStorage({ ...nativeFs,
    async rename(source, destination) {
      await nativeFs.rename(source, destination);
      if (destination === filename) publications.push(JSON.parse(await nativeFs.readFile(filename, "utf8")));
    },
  }, () => h.request(current.id, "garment", "regenerate"));
  assert.equal(response.status, 202);
  assert.equal(publications.length, 1);
  assert.equal(h.tasks.length, 1);
  assert.equal(h.tasks[0].taskId, publications[0].stages.garment.taskId);
  assert.notEqual(h.tasks[0].taskId, current.stages.garment.taskId);
  assert.deepEqual(await h.plugin.pendingTasks(), h.tasks);
});

test("failed garment persistence rolls back the newly authorized modeled task", async (t) => {
  const h = await harness(t);
  const current = job("garment", "review", 1);
  current.stages.modeled = { status: "pending", attempts: 0 };
  await h.save(current);
  await writeFile(path.join(h.root, "data", "model-reference.png"), "reference");
  // The missing garment asset makes persistImported fail after approval saves.
  const response = await h.request(current.id, "garment", "approve");
  assert.equal(response.status, 404);
  const persisted = JSON.parse(await readFile(path.join(h.jobsDir, current.id, "job.json"), "utf8"));
  assert.deepEqual(persisted.stages, current.stages);
  assert.deepEqual(await h.plugin.pendingTasks(), []);
  assert.deepEqual(h.tasks, []);
});
