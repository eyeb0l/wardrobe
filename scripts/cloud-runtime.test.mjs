import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { PGlite } from "@electric-sql/pglite";
import { CLOUD_ROOT, createCloudStore } from "./cloud-store.mjs";
import { currentStorage, mkdir, readFile, withStorage, writeFile } from "./storage-fs.mjs";
import { createPlugin } from "../server/plugins.mjs";
import { executeCloudTask, INTERRUPTED } from "../server/task-runner.mjs";
import { createTask, readTask, saveTask, reservePaidCall } from "../server/task-store.mjs";
import sharp from "sharp";
import { outsideRequestLease, independentDecisionLeases, leaseFreeRequests } from "../server/request-lease.mjs";
import { decide } from "./decisions.mjs";
import { decisionsResponse } from "./test-helpers/decisions-response.mjs";

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
      async pluginFactory(kind, { beforePaidCall }) {
        calls.factory.push(kind);
        return {
          async runTask(payload) {
            await beforePaidCall("image");
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
  assert.equal(reservations, 0, "skipped work and redelivery consume no reservations");
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
  assert.equal(reservations, 0, "reconciliation dispatches no provider requests");
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
      assert.deepEqual(await get(outfits, "/api/outfits"), { version: 1, outfits: [], plans: [], plansRevision: "initial" });
      assert.deepEqual(await get(outfits, "/api/outfits/jobs"), { jobs: [], warnings: [] });
    } finally { await outfits.closeBundle?.(); }
  });
  const after = (await h.pg.query("SELECT path, kind, text_content, blob_url, size, updated_at FROM wardrobe_files ORDER BY path")).rows;
  assert.deepEqual(after, before, "read-only initialization cannot recover, publish, or update files");
  assert.equal(h.blobs.size, 0);
});

test('detached generation permits other saves, makes duplicate delivery wait, and reserves once', async t => {
  const h = await harness(t), jobId=randomUUID();
  const file=`${CLOUD_ROOT}/jobs/${jobId}/job.json`;
  await h.write(async()=>{await mkdir(`${CLOUD_ROOT}/jobs/${jobId}`,{recursive:true});await writeFile(file,JSON.stringify({stages:{garment:{status:'processing'}}}));});
  const task=await h.task({kind:'import',jobId,stageName:'garment',taskId:randomUUID()});
  let release,started; const gate=new Promise(r=>release=r), entered=new Promise(r=>started=r); let reservations=0,dispatches=0;
  const options={store:h.store,enabled:()=>true,reserve:async()=>{reservations++;},pluginFactory:async(kind,{beforePaidCall,outsideLease})=>({
    async runTask(){await beforePaidCall('image');await outsideLease(async()=>{dispatches++;started();await gate;await assert.rejects(writeFile(file,'unsafe'),{code:'ESTALE'});});return {skipped:false,job:{stages:{garment:{status:'review'}}}};},
    async failTask(){assert.fail('Live task must not fail');}
  })};
  const running=executeCloudTask(task.id,0,options);await entered;
  try {
    const other=h.otherStore();
    await other.withLease(()=>other.writeFile(`${CLOUD_ROOT}/other-item.json`,'saved'));
    const duplicate=await executeCloudTask(task.id,0,{...options,store:other});
    assert.equal(duplicate.busy,true);
    assert.equal(Date.parse(duplicate.retryAt),Date.parse((await h.storedTask(task.id)).activeUntil)+1000,'a duplicate sleeps until the live claim ends instead of polling');
    assert.equal(dispatches,1);assert.equal(reservations,1);
  }finally{release();}
  assert.deepEqual(await running,{more:false});assert.equal((await h.storedTask(task.id)).state,'done');
  assert.equal(await h.store.readFile(`${CLOUD_ROOT}/other-item.json`,'utf8'),'saved');
});

test('source changes during detached work fence all stale result and error writes', async t => {
  const h=await harness(t),jobId=randomUUID(),file=`${CLOUD_ROOT}/outfit-jobs/${jobId}/job.json`;
  await h.write(async()=>{await mkdir(`${CLOUD_ROOT}/outfit-jobs/${jobId}`,{recursive:true});await writeFile(file,'original');});
  const task=await h.task({kind:'outfit',jobId,taskId:randomUUID()});
  let failures=0;
  assert.deepEqual(await executeCloudTask(task.id,0,{store:h.store,enabled:()=>true,pluginFactory:async(kind,{outsideLease})=>({
    async runTask(){await outsideLease(async()=>{const other=h.otherStore();await other.withLease(()=>other.writeFile(file,'new revision'));});await writeFile(file,'stale');},
    async failTask(){failures++;await writeFile(file,'stale failure');}
  })}),{busy:true});
  assert.equal(failures,0);assert.equal(await h.store.readFile(file,'utf8'),'new revision');
  const settled=await h.storedTask(task.id);
  assert.equal(settled.state,'running');
  assert.ok(Date.parse(settled.activeUntil)<=Date.now(),'the lost owner expires its own claim so redelivery settles without polling');
});

// The worker needs a test-sized claim: a blocking request holds the shared
// writer through the detached provider call and beyond, as a long backup could.
function detachedWorker(h, { hold, run = () => "PAID IMAGE" }) {
  const jobId = randomUUID(), file = `${CLOUD_ROOT}/jobs/${jobId}/job.json`, calls = { reserve: 0, dispatch: 0, fail: [] };
  let holding;
  const options = { store: h.store, enabled: () => true, reserve: async () => { calls.reserve++; }, pluginFactory: async (kind, { beforePaidCall, outsideLease }) => ({
    async runTask() {
      await beforePaidCall("image");
      const result = await outsideLease(async () => {
        calls.dispatch++;
        const other = h.otherStore();
        holding = other.withLease(() => delay(hold));
        await delay(50);
        return run();
      });
      await writeFile(`${CLOUD_ROOT}/jobs/${jobId}/result.json`, JSON.stringify({ result }));
      return { skipped: false, job: { stages: { garment: { status: "review" } } } };
    },
    async failTask(payload, message) { await writeFile(file, JSON.stringify({ failed: message })); calls.fail.push(message); },
  }) };
  return { jobId, file, calls, options, held: () => holding,
    setup: async () => { await h.write(async () => { await mkdir(`${CLOUD_ROOT}/jobs/${jobId}`, { recursive: true }); await writeFile(file, "{}"); }); return h.task({ kind: "import", jobId, stageName: "garment", taskId: randomUUID() }); } };
}

test("a finished paid result waits out a busy writer for its whole remaining claim", async t => {
  const h = await harness(t), worker = detachedWorker(h, { hold: 1_500 });
  const task = await worker.setup();
  const budgets = [];
  const store = { ...h.store, withoutLease: (callback, validate, options) => { budgets.push(options.reacquireBy - Date.now()); return h.store.withoutLease(callback, validate, options); } };
  assert.deepEqual(await executeCloudTask(task.id, 0, { ...worker.options, store }), { more: false });
  await worker.held();
  assert.ok(budgets[0] > 200_000, `default reacquire budget follows the 260 s claim, not a fixed 30 s (${budgets[0]} ms)`);
  assert.deepEqual(JSON.parse(await h.store.readFile(`${CLOUD_ROOT}/jobs/${worker.jobId}/result.json`, "utf8")), { result: "PAID IMAGE" });
  assert.equal((await h.storedTask(task.id)).state, "done");
  assert.deepEqual([worker.calls.reserve, worker.calls.dispatch, worker.calls.fail.length], [1, 1, 0]);
});

test("a worker that cannot reacquire in time expires its claim and redelivery settles without a second paid call", async t => {
  const h = await harness(t), worker = detachedWorker(h, { hold: 2_000 });
  const task = await worker.setup();
  const started = Date.now();
  assert.deepEqual(await executeCloudTask(task.id, 0, { ...worker.options, detachedMs: 3_000, settleWaitMs: 4_000 }), { busy: true });
  await worker.held();
  assert.ok(Date.now() - started < 4_500, "no waiting for the 3 s claim to expire on its own");
  await assert.rejects(h.store.readFile(`${CLOUD_ROOT}/jobs/${worker.jobId}/result.json`), { code: "ENOENT" }, "the stale result is never published");
  assert.ok(Date.parse((await h.storedTask(task.id)).activeUntil) <= Date.now());
  assert.deepEqual(await executeCloudTask(task.id, 0, worker.options), { more: false });
  assert.deepEqual(worker.calls.fail, [INTERRUPTED]);
  assert.equal((await h.storedTask(task.id)).state, "failed");
  assert.deepEqual([worker.calls.reserve, worker.calls.dispatch], [1, 1]);
});

test("a lost worker that cannot even settle asks the workflow to sleep until its claim ends", async t => {
  const h = await harness(t), worker = detachedWorker(h, { hold: 2_500 });
  const task = await worker.setup();
  const result = await executeCloudTask(task.id, 0, { ...worker.options, detachedMs: 9_000, stepMs: 100, settleWaitMs: 300 });
  await worker.held();
  assert.equal(result.busy, true);
  assert.equal(Date.parse(result.retryAt), Date.parse((await h.storedTask(task.id)).activeUntil) + 1_000);
  assert.equal(worker.calls.dispatch, 1);
});

test("shopping requests take only short leases, while job and outfit routes keep a request writer", () => {
  for (const pathname of ["/api/shopping/analyze", "/api/shopping/gaps", "/api/shopping/import-website", "/api/outfits/discovery/rank"]) assert.equal(leaseFreeRequests(pathname), true, pathname);
  for (const pathname of ["/api/import/jobs", "/api/outfits/look-1/accessories", "/api/outfits/jobs", "/api/shopping/config"]) assert.equal(leaseFreeRequests(pathname), false, pathname);
});

for (const pathname of ["/api/import/jobs", "/api/outfits/look-1/accessories"]) {
  test(`${pathname} releases the request writer during provider work and reacquires before saving`, async t => {
    const h = await harness(t);
    let release, started;
    const gate = new Promise(resolve => { release = resolve; });
    const entered = new Promise(resolve => { started = resolve; });
    const running = h.write(async () => {
      const result = await outsideRequestLease(h.store, pathname, async () => {
        started();
        await gate;
        await assert.rejects(writeFile(`${CLOUD_ROOT}/unsafe.json`, "unsafe"), { code: "ESTALE" });
        return "analysed";
      });
      await writeFile(`${CLOUD_ROOT}/result.json`, result);
    });
    await entered;
    try {
      const other = h.otherStore();
      await other.withLease(() => other.writeFile(`${CLOUD_ROOT}/other-item.json`, "saved"));
    } finally { release(); await running; }
    assert.equal(await h.store.readFile(`${CLOUD_ROOT}/result.json`, "utf8"), "analysed");
    assert.equal(await h.store.readFile(`${CLOUD_ROOT}/other-item.json`, "utf8"), "saved");
  });
}

test("hosted clothing detection reserves under the request writer, then lets other saves run during the provider call", async t => {
  const h = await harness(t);
  const png = await sharp({ create: { width: 96, height: 128, channels: 3, background: "#777777" } }).png().toBuffer();
  await h.write(async () => {
    for (const directory of ["jobs", "imported"]) await mkdir(`${CLOUD_ROOT}/${directory}`);
    await writeFile(`${CLOUD_ROOT}/library.json`, "[]");
    await writeFile(`${CLOUD_ROOT}/model-reference.png`, png);
  });
  for (const [name, value] of [["OPENAI_API_KEY", "test-key"], ["OPENAI_API_BASE_URL", "https://wardrobe-test.invalid"]]) {
    const previous = process.env[name];
    process.env[name] = value;
    t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
  }
  let usageAtDispatch;
  t.mock.method(globalThis, "fetch", async (url) => {
    assert.equal(url, "https://wardrobe-test.invalid/responses");
    usageAtDispatch = JSON.parse(await h.store.readFile(`${CLOUD_ROOT}/.api-usage.json`, "utf8"));
    const other = h.otherStore();
    await other.withLease(() => other.writeFile(`${CLOUD_ROOT}/other-item.json`, "saved during detection"));
    const items = [{ name: "Grey top", part: "upperbody", color: "#777777", secondaryColor: null, tags: ["plain"], boundingBox: { x: 100, y: 100, width: 800, height: 800 } }];
    return Response.json({ output_text: JSON.stringify({ items, isCleanProductShot: false }) });
  });
  const pathname = "/api/import/jobs";
  let result;
  const res = { statusCode: 200, setHeader() {}, end(value) { result = JSON.parse(value); } };
  await h.write(async () => {
    const plugin = await createPlugin("import", { beforePaidCall: reservePaidCall, outsideLease: (callback, validate) => outsideRequestLease(h.store, pathname, callback, validate) });
    let route;
    plugin.configureServer({ middlewares: { use(value) { route = value; } } });
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify({ imageBase64: png.toString("base64") }))]), { method: "POST", url: pathname, headers: { "content-type": "application/json" } });
    await route(req, res, () => assert.fail("Unexpected middleware fallthrough"));
  });
  assert.equal(res.statusCode, 202, JSON.stringify(result));
  assert.equal(usageAtDispatch.textCalls, 1, "quota is reserved before dispatch");
  assert.equal(await h.store.readFile(`${CLOUD_ROOT}/other-item.json`, "utf8"), "saved during detection");
  const saved = JSON.parse(await h.store.readFile(`${CLOUD_ROOT}/jobs/${result.jobs[0].id}/job.json`, "utf8"));
  assert.equal(saved.stages.crop.status, "review");
});

for (const kind of ["crop", "outfit", "cleanup", "retry"]) {
  const route = id => kind === "outfit" ? `/api/outfits/jobs/${id}/outfits/look-1/check`
    : `/api/import/jobs/${id}/${kind === "crop" ? "preflight" : kind === "retry" ? "detection/retry" : "stages/garment/cleanup-preview"}`;
  const jobFile = id => `${CLOUD_ROOT}/${kind === "outfit" ? "outfit-jobs" : "jobs"}/${id}/job.json`;

  test(`${kind} checks release the hosted lease for unrelated saves and reacquire before writing`, async t => {
    const h = await harness(t), id = randomUUID(), file = jobFile(id);
    await h.write(async () => {
      await mkdir(file.slice(0, file.lastIndexOf("/")), { recursive: true });
      await writeFile(file, "original");
    });
    let release, started;
    const gate = new Promise(resolve => { release = resolve; });
    const entered = new Promise(resolve => { started = resolve; });
    const running = h.write(async () => {
      const result = await outsideRequestLease(h.store, route(id), async () => {
        started();
        await gate;
        await assert.rejects(writeFile(file, "unsafe"), { code: "ESTALE" });
        return "checked";
      });
      await writeFile(`${CLOUD_ROOT}/result.json`, result);
    });
    await entered;
    try {
      const other = h.otherStore();
      await other.withLease(() => other.writeFile(`${CLOUD_ROOT}/other-item.json`, "saved"));
    } finally { release(); await running; }
    assert.equal(await h.store.readFile(file, "utf8"), "original");
    assert.equal(await h.store.readFile(`${CLOUD_ROOT}/result.json`, "utf8"), "checked");
  });

  test(`${kind} checks discard stale results after manual changes or deletion`, async t => {
    const h = await harness(t);
    for (const action of ["accepted", "rejected", "deleted"]) {
      const id = randomUUID(), file = jobFile(id);
      await h.write(async () => {
        await mkdir(file.slice(0, file.lastIndexOf("/")), { recursive: true });
        await writeFile(file, "review");
      });
      await assert.rejects(h.write(async () => {
        try {
          await outsideRequestLease(h.store, route(id), async () => {
            const other = h.otherStore();
            await other.withLease(() => action === "deleted" ? other.rm(file) : other.writeFile(file, action));
            return "late result";
          });
          assert.fail("A stale check must not return its result");
        } catch (error) {
          await assert.rejects(writeFile(file, "stale error write"), { code: "ESTALE" });
          throw error;
        }
      }), { code: "ESTALE", status: 409 });
      if (action === "deleted") await assert.rejects(h.store.readFile(file), { code: "ENOENT" });
      else assert.equal(await h.store.readFile(file, "utf8"), action);
    }
  });
}

test("duplicate hosted image checks release both leases and share one paid request", async t => {
  const h = await harness(t), id = randomUUID();
  const pathname = `/api/outfits/jobs/${id}/outfits/look-1/check`;
  await h.write(async () => {
    await mkdir(`${CLOUD_ROOT}/outfit-jobs/${id}`, { recursive: true });
    await writeFile(`${CLOUD_ROOT}/outfit-jobs/${id}/job.json`, "review");
  });
  let release, started, sharedStarted, calls = 0, reservations = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  const sharedEntered = new Promise(resolve => { sharedStarted = resolve; });
  const run = (store, onDetached = () => {}) => store.withLease(() => withStorage(store, () => decide({
    namespace: id, env: { WARDROBE_DECISIONS_ENABLED: "1", OPENAI_API_KEY: "test-key" },
    input: "fixture", questions: [{ type: "predicate", name: "clear" }],
    beforePaidCall: async () => { await store.assertLease(); reservations++; },
    usageLog: async () => { await store.assertLease(); },
    outsideLease: callback => outsideRequestLease(store, pathname, () => { onDetached(); return callback(); }),
    fetch: async (_, init) => {
      calls++; started(); await gate;
      return Response.json(decisionsResponse(JSON.parse(init.body)));
    },
  })));
  const first = run(h.store);
  await entered;
  const duplicate = run(h.otherStore(), sharedStarted);
  let results;
  try {
    await sharedEntered;
    const other = h.otherStore();
    await other.withLease(() => other.writeFile(`${CLOUD_ROOT}/other-item.json`, "saved"));
  } finally { release(); results = await Promise.all([first, duplicate]); }
  assert.equal(results[0].cached, false);
  assert.equal(results[1].cached, true);
  assert.equal(calls, 1);
  assert.equal(reservations, 1);
});

for (const pathname of ["/api/outfits/discovery/rank", "/api/outfits/discovery/swaps", "/api/shopping/analyze"]) {
  test(`${pathname} can queue parallel decisions behind image checks without holding their writer lease`, async t => {
    const h = await harness(t), id = randomUUID();
    await h.write(async () => {
      await mkdir(`${CLOUD_ROOT}/outfit-jobs/${id}`, { recursive: true });
      await writeFile(`${CLOUD_ROOT}/outfit-jobs/${id}/job.json`, "review");
      await writeFile(`${CLOUD_ROOT}/library.json`, "original");
    });
    let release, started, queued, active = 0, peak = 0, calls = 0, reservations = 0, validations = 0, queueCount = 0;
    const gate = new Promise(resolve => { release = resolve; });
    const entered = new Promise(resolve => { started = resolve; });
    const waiting = new Promise(resolve => { queued = resolve; });
    const logErrors = [];
    const request = (route, index, blocked = false) => withStorage(h.store, () => decide({
      namespace: [id, index], env: { WARDROBE_DECISIONS_ENABLED: "1", OPENAI_API_KEY: "test-key" },
      input: "fixture", questions: [{ type: "predicate", name: "clear" }], timeoutMs: 5000,
      withDecisionLease: callback => h.store.withLease(callback, { waitMs: 5000 }),
      beforePaidCall: async () => { await h.store.assertLease(); reservations++; },
      usageLog: async () => { try { await h.store.assertLease(); } catch (error) { logErrors.push(error); } },
      outsideLease: callback => outsideRequestLease(h.store, route, async () => {
        if (!blocked && ++queueCount === 2) queued();
        return callback();
      }, async () => {
        await h.store.assertLease();
        assert.equal(await readFile(`${CLOUD_ROOT}/library.json`, "utf8"), "original");
        validations++;
      }),
      fetch: async (_, init) => {
        calls++; active++; peak = Math.max(peak, active);
        if (blocked && active === 2) started();
        if (blocked) await gate;
        active--;
        return Response.json(decisionsResponse(JSON.parse(init.body)));
      },
    }));
    assert.equal(independentDecisionLeases(pathname), true);
    const blockers = [0, 1].map(index => request(`/api/outfits/jobs/${id}/outfits/look-${index}/check`, index, true));
    await entered;
    // Both calls share the same warm store and request storage context, as the
    // two candidate workers in one hosted discovery request do.
    const followers = [2, 3].map(index => request(pathname, index));
    let results;
    try {
      await waiting;
    } finally { release(); results = await Promise.all([...blockers, ...followers]); }
    assert.equal(results.length, 4);
    assert.equal(calls, 4);
    assert.equal(reservations, 4);
    assert.equal(peak, 2);
    assert.ok(validations >= 4, "queued work and provider results must each validate after reacquisition");
    assert.deepEqual(logErrors, []);
  });

  test(`${pathname} rejects changed evidence after reacquiring its independent lease`, async t => {
    const h = await harness(t), file = `${CLOUD_ROOT}/library.json`;
    await h.write(() => writeFile(file, "original"));
    await assert.rejects(h.write(() => outsideRequestLease(h.store, pathname, async () => {
      const other = h.otherStore();
      await other.withLease(() => other.writeFile(file, "edited"));
    }, async () => {
      if (await readFile(file, "utf8") !== "original") throw Object.assign(new Error("Evidence changed"), { status: 409 });
    })), { status: 409 });
    assert.equal(await h.store.readFile(file, "utf8"), "edited");
  });
}

test('expired cleanup resumes for free while an expired paid step is never replayed', async t => {
  const h=await harness(t),jobId=randomUUID(),file=`${CLOUD_ROOT}/jobs/${jobId}/job.json`;
  await h.write(async()=>{await mkdir(`${CLOUD_ROOT}/jobs/${jobId}`,{recursive:true});await writeFile(file,JSON.stringify({stages:{garment:{status:'cleaning'}}}));});
  const task=await h.task({kind:'import',jobId,stageName:'garment',taskId:randomUUID()});
  await h.write(()=>saveTask({...task,state:'running',owner:randomUUID(),activeUntil:'2020-01-01T00:00:00Z'}));
  let cleanups=0;
  const options={store:h.store,enabled:()=>true,reserve:()=>assert.fail('Cleanup must not reserve paid calls'),pluginFactory:async()=>({async runTask(){cleanups++;return {skipped:false,job:{stages:{garment:{status:'review'}}}};},async failTask(){assert.fail('Cleanup can resume');}})};
  assert.deepEqual(await executeCloudTask(task.id,0,options),{more:false});
  assert.deepEqual(await executeCloudTask(task.id,0,options),{more:false});assert.equal(cleanups,1);
});
