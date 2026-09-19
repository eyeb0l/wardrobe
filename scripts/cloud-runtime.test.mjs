import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { CLOUD_ROOT, createCloudStore } from "./cloud-store.mjs";
import { currentStorage, mkdir, readFile, withStorage, writeFile } from "./storage-fs.mjs";
import { createPlugin } from "../server/plugins.mjs";
import { executeCloudTask, INTERRUPTED } from "../server/task-runner.mjs";
import { createTask, readTask, saveTask } from "../server/task-store.mjs";

async function harness(t) {
  // All persistence is an embedded test database and private in-memory blobs.
  // Any accidental live provider/network call must fail immediately.
  t.mock.method(globalThis, "fetch", async () => assert.fail("Cloud runtime tests must never make network or paid API calls"));
  const pg = new PGlite();
  t.after(() => pg.close());
  const database = {
    async query(sql, values = []) { return (await pg.query(sql, values)).rows; },
    async transaction(statements) {
      return pg.transaction(async (transaction) => {
        const results = [];
        for (const { text, values = [] } of statements) results.push((await transaction.query(text, values)).rows);
        return results;
      });
    },
  };
  const blobs = new Map();
  const blobReads = [];
  const blob = {
    async put(name, bytes, options) {
      assert.equal(options.access, "private");
      assert.equal(options.allowOverwrite, false);
      const url = `https://runtime-private.test/${name}`;
      assert.ok(!blobs.has(url));
      blobs.set(url, Buffer.from(bytes));
      return { url };
    },
    async get(url, options) {
      blobReads.push({ url, options });
      assert.equal(options.access, "private");
      assert.equal(options.useCache, true);
      return blobs.has(url) ? { statusCode: 200, stream: new Response(blobs.get(url)).body } : null;
    },
  };
  const store = createCloudStore({ database, blob });
  await store.initialize();
  const write = (operation) => store.withLease(() => withStorage(store, operation));
  const read = (operation) => withStorage(store, operation);
  return {
    pg, store, blobs, blobReads, write, read,
    otherStore: () => createCloudStore({ database, blob }),
    task: (payload) => write(() => createTask(payload)),
    storedTask: (id) => read(() => readTask(id)),
  };
}

function fakeRuntime(h, behavior = {}) {
  const calls = { factory: [], reserve: 0, run: [], fail: [], close: 0 };
  return {
    calls,
    options: {
      store: h.store,
      enabled: () => true,
      async reserve() {
        calls.reserve += 1;
        assert.equal(currentStorage(), h.store);
        if (behavior.reserve) return behavior.reserve();
        await writeFile(`${CLOUD_ROOT}/reserved.json`, JSON.stringify({ count: calls.reserve }));
      },
      async pluginFactory(kind) {
        calls.factory.push(kind);
        return {
          async runTask(payload) {
            calls.run.push(structuredClone(payload));
            return behavior.run ? behavior.run(payload, calls.run.length) : undefined;
          },
          async failTask(payload, message) {
            calls.fail.push({ payload: structuredClone(payload), message });
            await writeFile(`${CLOUD_ROOT}/failure.json`, JSON.stringify({ payload, message }));
          },
          async closeBundle() { calls.close += 1; },
        };
      },
    },
  };
}

test("durable task completion exposes persisted bytes and duplicate delivery makes no second paid call", async (t) => {
  const h = await harness(t);
  const task = await h.task({ kind: "import", jobId: "import-one", stageName: "garment", taskId: randomUUID() });
  const bytes = Buffer.from([137, 80, 78, 71, 0, 255, 9]);
  const runtime = fakeRuntime(h, { run: async () => {
    await mkdir(`${CLOUD_ROOT}/results`, { recursive: true });
    await writeFile(`${CLOUD_ROOT}/results/image.png`, bytes);
    await writeFile(`${CLOUD_ROOT}/results/result.json`, JSON.stringify({ image: "image.png", accepted: false }));
    return { skipped: false, job: { stages: { garment: { status: "review" } } } };
  } });
  assert.deepEqual(await executeCloudTask(task.id, 0, runtime.options), { more: false });
  const stored = await h.storedTask(task.id);
  assert.equal(stored.state, "done");
  assert.equal(stored.step, 1);
  const freshStore = h.otherStore();
  assert.deepEqual(await freshStore.readFile(`${CLOUD_ROOT}/results/image.png`), bytes);
  assert.deepEqual(JSON.parse(await freshStore.readFile(`${CLOUD_ROOT}/results/result.json`, "utf8")), { image: "image.png", accepted: false });
  for (const step of [0, 1, 0]) assert.deepEqual(await executeCloudTask(task.id, step, runtime.options), { more: false });
  assert.equal(runtime.calls.reserve, 1);
  assert.equal(runtime.calls.run.length, 1);
  assert.equal(runtime.calls.close, 1);
  assert.deepEqual(runtime.calls.factory, ["import"]);
  assert.equal(runtime.calls.fail.length, 0, "settled import does not reload the job for redundant reconciliation");
  assert.equal(h.blobs.size, 1);
  assert.equal(h.blobReads.length, 1);
});

test("outfit continuations advance one durable step and old deliveries cannot repeat it", async (t) => {
  const h = await harness(t);
  const task = await h.task({ kind: "outfit", jobId: "outfit-one", taskId: randomUUID() });
  const runtime = fakeRuntime(h, { run: async (payload, count) => {
    await writeFile(`${CLOUD_ROOT}/progress.json`, JSON.stringify({ count }));
    return count === 1;
  } });
  assert.deepEqual(await executeCloudTask(task.id, 0, runtime.options), { more: true });
  assert.equal((await h.storedTask(task.id)).state, "pending");
  assert.equal((await h.storedTask(task.id)).step, 1);
  assert.deepEqual(await executeCloudTask(task.id, 0, runtime.options), { more: true });
  assert.equal(runtime.calls.run.length, 1);
  await assert.rejects(executeCloudTask(task.id, 2, runtime.options), /out of order/);
  assert.equal((await h.storedTask(task.id)).step, 1);
  assert.deepEqual(await executeCloudTask(task.id, 1, runtime.options), { more: false });
  assert.equal((await h.storedTask(task.id)).state, "done");
  assert.equal((await h.storedTask(task.id)).step, 2);
  assert.deepEqual(await executeCloudTask(task.id, 1, runtime.options), { more: false });
  assert.equal(runtime.calls.run.length, 2);
  assert.equal(runtime.calls.reserve, 2);
  assert.equal(runtime.calls.close, 2);
  assert.equal(JSON.parse(await h.store.readFile(`${CLOUD_ROOT}/progress.json`, "utf8")).count, 2);
});

test("an interrupted running task fails visibly without reserving or repeating paid work", async (t) => {
  const h = await harness(t);
  const task = await h.task({ kind: "import", jobId: "interrupted", taskId: randomUUID() });
  await h.write(() => saveTask({ ...task, state: "running", startedAt: new Date().toISOString() }));
  const runtime = fakeRuntime(h);
  assert.deepEqual(await executeCloudTask(task.id, 0, runtime.options), { more: false });
  assert.equal(runtime.calls.reserve, 0);
  assert.equal(runtime.calls.run.length, 0);
  assert.deepEqual(runtime.calls.fail, [{ payload: task.payload, message: INTERRUPTED }]);
  const stored = await h.storedTask(task.id);
  assert.equal(stored.state, "failed");
  assert.equal(stored.error, INTERRUPTED);
  assert.equal(JSON.parse(await h.store.readFile(`${CLOUD_ROOT}/failure.json`, "utf8")).message, INTERRUPTED);
  assert.deepEqual(await executeCloudTask(task.id, 0, runtime.options), { more: false });
  assert.equal(runtime.calls.fail.length, 1);
  assert.equal(runtime.calls.close, 1);
});

test("failure after provider dispatch is recorded and never retried by task redelivery", async (t) => {
  const h = await harness(t);
  const task = await h.task({ kind: "import", jobId: "failed", taskId: randomUUID() });
  const runtime = fakeRuntime(h, { run: async () => {
    await writeFile(`${CLOUD_ROOT}/provider-started.json`, "true");
    throw new Error("provider connection lost after dispatch");
  } });
  assert.deepEqual(await executeCloudTask(task.id, 0, runtime.options), { more: false });
  assert.equal((await h.storedTask(task.id)).state, "failed");
  assert.equal((await h.storedTask(task.id)).error, INTERRUPTED);
  assert.equal(await h.store.readFile(`${CLOUD_ROOT}/provider-started.json`, "utf8"), "true");
  assert.deepEqual(await executeCloudTask(task.id, 0, runtime.options), { more: false });
  assert.equal(runtime.calls.reserve, 1);
  assert.equal(runtime.calls.run.length, 1);
  assert.equal(runtime.calls.fail.length, 1);
  assert.equal(runtime.calls.close, 1);
});

test("the mutation lease excludes a competing worker throughout paid generation", async (t) => {
  const h = await harness(t);
  const task = await h.task({ kind: "import", jobId: "held", taskId: randomUUID() });
  let signalStarted;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  let release;
  const waitForRelease = new Promise((resolve) => { release = resolve; });
  const runtime = fakeRuntime(h, { run: async () => { signalStarted(); await waitForRelease; } });
  const running = executeCloudTask(task.id, 0, runtime.options);
  await started;
  try {
    const competing = h.otherStore();
    await assert.rejects(executeCloudTask(task.id, 0, { ...runtime.options, store: competing }), { code: "EBUSY" });
    assert.equal(runtime.calls.reserve, 1);
    assert.equal(runtime.calls.run.length, 1);
    assert.equal((await h.storedTask(task.id)).state, "running");
  } finally { release(); }
  assert.deepEqual(await running, { more: false });
  assert.equal((await h.storedTask(task.id)).state, "done");
});

test("a spending limit failure records an actionable error before any paid dispatch", async (t) => {
  const h = await harness(t);
  const task = await h.task({ kind: "outfit", jobId: "limited", taskId: randomUUID() });
  const message = "The daily limit has been reached. Try again tomorrow.";
  const runtime = fakeRuntime(h, { reserve: async () => { throw Object.assign(new Error(message), { status: 429 }); } });
  assert.deepEqual(await executeCloudTask(task.id, 0, runtime.options), { more: false });
  assert.equal(runtime.calls.run.length, 0);
  assert.equal(runtime.calls.reserve, 1);
  assert.equal((await h.storedTask(task.id)).state, "failed");
  assert.equal((await h.storedTask(task.id)).error, message);
  assert.deepEqual(runtime.calls.fail, [{ payload: task.payload, message }]);
});

test("disabled hosted generation fails the task before reserving or dispatching paid work", async (t) => {
  const h = await harness(t);
  const task = await h.task({ kind: "import", jobId: "disabled", taskId: randomUUID() });
  const runtime = fakeRuntime(h);
  assert.deepEqual(await executeCloudTask(task.id, 0, { ...runtime.options, enabled: () => false }), { more: false });
  assert.equal(runtime.calls.run.length, 0);
  assert.equal(runtime.calls.reserve, 0);
  assert.deepEqual(runtime.calls.fail, [{ payload: task.payload, message: "Hosted generation is disabled." }]);
  assert.equal((await h.storedTask(task.id)).state, "failed");
  assert.equal((await h.storedTask(task.id)).error, "Hosted generation is disabled.");
  assert.equal(runtime.calls.close, 1);
  assert.deepEqual(await executeCloudTask(task.id, 0, runtime.options), { more: false });
  assert.equal(runtime.calls.run.length, 0, "reenabling generation does not replay an explicitly failed task");
});

test("real plugin pending tasks reconstruct missing outbox entries with the original durable identity", async (t) => {
  const h = await harness(t);
  const imported = { jobId: randomUUID(), taskId: randomUUID() };
  const outfit = { jobId: randomUUID(), taskId: randomUUID() };
  const date = new Date().toISOString();
  await h.write(async () => {
    await mkdir(`${CLOUD_ROOT}/jobs/${imported.jobId}`, { recursive: true });
    await mkdir(`${CLOUD_ROOT}/outfit-jobs/${outfit.jobId}`, { recursive: true });
    for (const directory of ["imported", "outfit-images"]) await mkdir(`${CLOUD_ROOT}/${directory}`);
    await writeFile(`${CLOUD_ROOT}/library.json`, "[]");
    await writeFile(`${CLOUD_ROOT}/outfits.json`, JSON.stringify({ version: 1, outfits: [] }));
    await writeFile(`${CLOUD_ROOT}/jobs/${imported.jobId}/job.json`, JSON.stringify({
      id: imported.jobId, status: "active", createdAt: date, updatedAt: date,
      stages: { crop: { status: "approved" }, garment: { status: "queued", attempts: 0, taskId: imported.taskId }, modeled: { status: "pending", attempts: 0 } },
    }));
    await writeFile(`${CLOUD_ROOT}/outfit-jobs/${outfit.jobId}/job.json`, JSON.stringify({
      version: 1, id: outfit.jobId, count: 1, direction: "", modelReferenceId: "default", status: "planning",
      createdAt: date, updatedAt: date, error: null, outfits: [], internal: { cloudTaskId: outfit.taskId },
    }));
  });
  const expected = [
    { kind: "import", jobId: imported.jobId, stageName: "garment", taskId: imported.taskId, attempt: 1, generationId: null },
    { kind: "outfit", jobId: outfit.jobId, taskId: outfit.taskId },
  ];
  const discovered = [];
  await h.read(async () => {
    for (const kind of ["import", "outfit"]) {
      const plugin = await createPlugin(kind, { readOnly: true });
      try { discovered.push(...await plugin.pendingTasks()); }
      finally { await plugin.closeBundle?.(); }
    }
  });
  assert.deepEqual(discovered, expected);
  for (const payload of discovered) {
    await assert.rejects(h.storedTask(payload.taskId), { code: "ENOENT" });
    const reconstructed = await h.task(payload);
    assert.equal(reconstructed.id, payload.taskId, "job state and outbox share a stable task identity");
    assert.equal(reconstructed.state, "pending");
    assert.deepEqual((await h.storedTask(payload.taskId)).payload, payload);
    await assert.rejects(h.task(payload), { code: "EEXIST" }, "recovery cannot create a second outbox record for the same paid attempt");
  }
  assert.equal(h.blobs.size, 0);
});

test("actual import reconciliation fails orphaned processing and preserves completed review or approval", async (t) => {
  const h = await harness(t);
  const date = new Date().toISOString();
  const cases = [];
  await h.write(async () => {
    for (const status of ["processing", "review", "approved"]) {
      const id = randomUUID();
      const taskId = randomUUID();
      const file = `${CLOUD_ROOT}/jobs/${id}/job.json`;
      const job = {
        id, status: "active", createdAt: date, updatedAt: date,
        stages: {
          crop: { status: "approved" },
          garment: { status, attempts: 1, taskId, error: null, assetUrl: status === "processing" ? null : `/api/import/assets/${id}/garment-1.png` },
          modeled: { status: "pending", attempts: 0 },
        },
      };
      await mkdir(`${CLOUD_ROOT}/jobs/${id}`, { recursive: true });
      const original = JSON.stringify(job);
      await writeFile(file, original);
      // An absent outbox is reconstructed pending even though the job's
      // processing state proves the original attempt may have reached OpenAI.
      const task = await createTask({ kind: "import", jobId: id, stageName: "garment", taskId, attempt: 1, generationId: null });
      cases.push({ task, file, status, original });
    }
  });
  let reservations = 0;
  const options = { store: h.store, enabled: () => true, reserve: async () => { reservations += 1; } };
  for (const fixture of cases) {
    assert.deepEqual(await executeCloudTask(fixture.task.id, 0, options), { more: false });
    const written = await h.store.readFile(fixture.file, "utf8");
    const job = JSON.parse(written);
    if (fixture.status === "processing") {
      assert.equal(job.stages.garment.status, "failed");
      assert.equal(job.stages.garment.error, INTERRUPTED);
      assert.equal(job.stages.garment.attempts, 1, "recovery never starts a new paid attempt");
    } else {
      assert.equal(written, fixture.original, "settled stage state and output remain unchanged");
    }
    assert.equal((await h.storedTask(fixture.task.id)).state, "done");
    assert.deepEqual(await executeCloudTask(fixture.task.id, 0, options), { more: false });
  }
  assert.equal(reservations, 3, "redelivery does not consume another reservation");
  assert.equal(h.blobs.size, 0);
});

test("actual outfit reconciliation fails only orphaned generating items and preserves settled output", async (t) => {
  const h = await harness(t);
  const date = new Date().toISOString();
  const cases = [];
  const accepted = [];
  await h.write(async () => {
    await mkdir(`${CLOUD_ROOT}/outfit-jobs`, { recursive: true });
    await writeFile(`${CLOUD_ROOT}/library.json`, "[]");
    for (const orphan of [true, false]) {
      const id = randomUUID();
      const taskId = randomUUID();
      const file = `${CLOUD_ROOT}/outfit-jobs/${id}/job.json`;
      const prefix = orphan ? "orphan" : "settled";
      const makeOutfit = (status, suffix) => ({
        id: `${prefix}-${suffix}`, name: `${status} outfit`, garmentIds: [`top-${prefix}-${suffix}`, `bottom-${prefix}-${suffix}`],
        occasion: ["casual"], reason: "A balanced outfit.", setting: "A quiet courtyard", status,
        image: status === "accepted" ? `/api/outfits/images/${prefix}-${suffix}.png`
          : status === "review" ? `/api/outfits/jobs/${id}/assets/${prefix}-${suffix}.png` : null,
        attempts: 1, prompt: null, error: null, internal: { history: [] },
      });
      const outfits = [...(orphan ? [makeOutfit("generating", "uncertain")] : []), makeOutfit("review", "review"), makeOutfit("accepted", "accepted")];
      accepted.push(structuredClone(outfits.at(-1)));
      const job = { version: 1, id, count: outfits.length, direction: "", modelReferenceId: "default", status: orphan ? "generating" : "review", createdAt: date, updatedAt: date, error: null, outfits, internal: { cloudTaskId: taskId } };
      await mkdir(`${CLOUD_ROOT}/outfit-jobs/${id}`);
      const original = JSON.stringify(job);
      await writeFile(file, original);
      const task = await createTask({ kind: "outfit", jobId: id, taskId });
      cases.push({ orphan, file, task, original, outfits });
    }
    await writeFile(`${CLOUD_ROOT}/outfits.json`, JSON.stringify({ version: 1, outfits: accepted }));
  });
  const manifestBefore = await h.store.readFile(`${CLOUD_ROOT}/outfits.json`, "utf8");
  let reservations = 0;
  const options = { store: h.store, enabled: () => true, reserve: async () => { reservations += 1; } };
  for (const fixture of cases) {
    assert.deepEqual(await executeCloudTask(fixture.task.id, 0, options), { more: false });
    const written = await h.store.readFile(fixture.file, "utf8");
    const job = JSON.parse(written);
    if (fixture.orphan) {
      assert.equal(job.outfits[0].status, "failed");
      assert.equal(job.outfits[0].error, INTERRUPTED);
      assert.equal(job.outfits[0].attempts, 1, "the uncertain image request was not repeated");
      assert.deepEqual(job.outfits.slice(1), fixture.outfits.slice(1), "review and accepted outfits survive recovery exactly");
    } else {
      assert.equal(written, fixture.original, "settled jobs are not rewritten or marked failed");
    }
    assert.equal((await h.storedTask(fixture.task.id)).state, "done");
    assert.deepEqual(await executeCloudTask(fixture.task.id, 0, options), { more: false });
  }
  assert.equal(reservations, 2);
  assert.equal(await h.store.readFile(`${CLOUD_ROOT}/outfits.json`, "utf8"), manifestBefore);
  assert.equal(h.blobs.size, 0);
});

test("real cloud import and outfit plugins can initialize and serve reads without a write lease", async (t) => {
  const h = await harness(t);
  await h.write(async () => {
    for (const directory of ["jobs", "imported", "outfit-jobs", "outfit-images"]) await mkdir(`${CLOUD_ROOT}/${directory}`);
    await writeFile(`${CLOUD_ROOT}/library.json`, "[]");
    await writeFile(`${CLOUD_ROOT}/outfits.json`, JSON.stringify({ version: 1, outfits: [] }));
  });
  const before = (await h.pg.query("SELECT path, kind, text_content, blob_url, size, updated_at FROM wardrobe_files ORDER BY path")).rows;
  async function get(plugin, url) {
    let handler;
    plugin.configureServer({ middlewares: { use(value) { handler = value; } } });
    const req = Object.assign(Readable.from([]), { method: "GET", url, headers: {} });
    let result;
    const res = { statusCode: 200, setHeader() {}, end(value) { result = JSON.parse(value); } };
    await handler(req, res, () => assert.fail("Unexpected middleware fallthrough"));
    assert.equal(res.statusCode, 200, JSON.stringify(result));
    return result;
  }
  await h.read(async () => {
    const imports = await createPlugin("import", { readOnly: true });
    try {
      assert.deepEqual(await get(imports, "/api/import/wardrobe"), []);
      assert.deepEqual(await get(imports, "/api/import/jobs"), []);
      assert.equal((await get(imports, "/api/import/config")).hasModelReference, false);
    } finally { await imports.closeBundle?.(); }
    const outfits = await createPlugin("outfit", { readOnly: true });
    try {
      assert.deepEqual(await get(outfits, "/api/outfits"), { version: 1, outfits: [] });
      assert.deepEqual(await get(outfits, "/api/outfits/jobs"), { jobs: [], warnings: [] });
    } finally { await outfits.closeBundle?.(); }
  });
  const after = (await h.pg.query("SELECT path, kind, text_content, blob_url, size, updated_at FROM wardrobe_files ORDER BY path")).rows;
  assert.deepEqual(after, before, "read-only initialization cannot recover, publish, or update files");
  assert.equal(h.blobs.size, 0);
});
