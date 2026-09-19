import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import sharp from "sharp";
import { wardrobeImportApi } from "./import-job-api.mjs";

async function harness(t, overrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wardrobe-serverless-import-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = await sharp({ create: { width: 64, height: 80, channels: 3, background: "#777777" } }).png().toBuffer();
  await writeFile(path.join(root, "identity.png"), source);
  const requests = [];
  const tasks = [];
  let blockedEndpoint;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.ok(url.startsWith("https://serverless-import-test.invalid/"), "tests never contact a paid API");
    assert.equal(options.headers.Authorization, "Bearer test-key");
    assert.ok(options.signal instanceof AbortSignal, "cloud provider calls have a timeout signal");
    requests.push(url);
    if (url.endsWith(blockedEndpoint || "-not-blocked")) {
      options.signal.throwIfAborted();
      return new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      });
    }
    if (url.endsWith("/responses")) {
      return Response.json({ output_text: JSON.stringify({ isCleanProductShot: false, items: [{ name: "Grey top", part: "upperbody", color: "#777777", secondaryColor: null, tags: [], boundingBox: { x: 0, y: 0, width: 1000, height: 1000 } }] }) });
    }
    assert.ok(url.endsWith("/images/edits"));
    let output = source;
    if (options.body.getAll("image[]").length === 1) {
      const key = options.body.get("prompt").match(/uniform solid (#[0-9a-f]{6})/)[1];
      const item = await sharp({ create: { width: 32, height: 40, channels: 3, background: "#777777" } }).png().toBuffer();
      output = await sharp({ create: { width: 64, height: 64, channels: 3, background: key } }).composite([{ input: item, left: 16, top: 12 }]).png().toBuffer();
    }
    return Response.json({ data: [{ b64_json: output.toString("base64") }] });
  });
  const options = {
    serverless: true,
    env: { OPENAI_API_KEY: "test-key", OPENAI_API_BASE_URL: "https://serverless-import-test.invalid", WARDROBE_DATA_DIR: path.join(root, "data"), WARDROBE_MODEL_REFERENCE: "identity.png" },
    scheduleTask: async (task) => { tasks.push(structuredClone(task)); },
    ...overrides,
  };
  let plugin;
  let handler;
  async function restart(extra = {}) {
    plugin = wardrobeImportApi({ ...options, ...extra });
    await plugin.configResolved({ root });
    plugin.configureServer({ middlewares: { use(value) { handler = value; } } });
  }
  await restart();
  async function request(method, url, payload, extraHeaders = {}) {
    const req = Readable.from(payload === undefined ? [] : [Buffer.from(JSON.stringify(payload))]);
    Object.assign(req, { method, url, headers: { host: "wardrobe.example", "x-forwarded-proto": "https", origin: "https://wardrobe.example", "sec-fetch-site": "same-origin", ...(payload === undefined ? {} : { "content-type": "application/json" }), ...extraHeaders } });
    let result;
    const headers = {};
    const res = { statusCode: 200, setHeader(key, value) { headers[key.toLowerCase()] = value; }, end(value) { result = Buffer.isBuffer(value) ? value : JSON.parse(value); } };
    await handler(req, res, () => assert.fail("Unexpected middleware fallthrough"));
    return { status: res.statusCode, body: result, headers };
  }
  async function createJob() {
    const response = await request("POST", "/api/import/jobs", { imageBase64: source.toString("base64") });
    assert.equal(response.status, 202, JSON.stringify(response.body));
    return response.body.jobs[0];
  }
  const jobPath = (id) => path.join(root, "data", "jobs", id, "job.json");
  return {
    root, source, requests, tasks, request, restart, createJob,
    jobPath, loadJob: async (id) => JSON.parse(await readFile(jobPath(id), "utf8")),
    get plugin() { return plugin; },
    blockEndpoint(endpoint) { blockedEndpoint = endpoint; },
  };
}

test("cloud approvals enqueue durable tasks and startup never starts paid image work", async (t) => {
  const h = await harness(t);
  const job = await h.createJob();
  const approved = await h.request("POST", `/api/import/jobs/${job.id}/stages/crop/approve`);
  assert.equal(approved.status, 200);
  assert.equal(approved.body.stages.garment.status, "queued");
  assert.equal(h.tasks.length, 1);
  assert.equal(h.tasks[0].attempt, 1);
  assert.equal(h.tasks[0].taskId, approved.body.stages.garment.taskId);
  await h.restart();
  assert.equal(h.requests.length, 1, "fresh invocations do not restart queued tasks");
  assert.equal((await h.loadJob(job.id)).stages.garment.status, "queued");
  assert.deepEqual(await h.plugin.runTask({ ...h.tasks[0], taskId: "old-task" }), { skipped: true });
  assert.deepEqual(await h.plugin.runTask({ ...h.tasks[0], attempt: 2 }), { skipped: true });
  assert.deepEqual(await h.plugin.runTask({ ...h.tasks[0], generationId: "old-generation" }), { skipped: true });
  const first = await h.plugin.runTask(h.tasks[0]);
  assert.equal(first.job.stages.garment.status, "review");
  assert.equal(first.job.stages.garment.attempts, 1);
  assert.equal(first.job.stages.modeled.status, "pending");
  assert.deepEqual(await h.plugin.runTask(h.tasks[0]), { skipped: true });
  assert.equal(h.requests.length, 2, "a delivered task calls the image API exactly once");
  const garmentApproved = await h.request("POST", `/api/import/jobs/${job.id}/stages/garment/approve`);
  assert.equal(garmentApproved.status, 200);
  assert.equal(h.tasks.length, 2);
  assert.equal(h.tasks[1].stageName, "modeled");
  assert.equal(h.requests.length, 2, "approving garment schedules modeling without starting it inline");
  assert.equal((await h.plugin.runTask(h.tasks[1])).job.stages.modeled.status, "review");
  assert.deepEqual(await h.plugin.runTask(h.tasks[1]), { skipped: true });
  const image = await h.request("GET", garmentApproved.body.libraryItem.image);
  assert.equal(image.headers["cache-control"], "private, no-store");
});

test("HTTP success waits for durable scheduling and failed scheduling remains manually retryable", async (t) => {
  let markScheduled;
  const scheduled = new Promise((resolve) => { markScheduled = resolve; });
  let release;
  const durableWrite = new Promise((resolve) => { release = resolve; });
  const h = await harness(t, { scheduleTask: async () => { markScheduled(); await durableWrite; } });
  const job = await h.createJob();
  let responded = false;
  const pending = h.request("POST", `/api/import/jobs/${job.id}/stages/crop/approve`).then((response) => { responded = true; return response; });
  await scheduled;
  assert.equal(responded, false, "success cannot precede durable task storage");
  assert.equal((await h.loadJob(job.id)).stages.garment.status, "queued");
  release();
  assert.equal((await pending).status, 200);

  let failedTask;
  await h.restart({ scheduleTask: async (task) => { failedTask = structuredClone(task); throw new Error("queue unavailable"); } });
  const second = await h.createJob();
  assert.equal((await h.request("POST", `/api/import/jobs/${second.id}/stages/crop/approve`)).status, 503);
  assert.equal((await h.loadJob(second.id)).stages.garment.status, "failed");
  assert.deepEqual(await h.plugin.runTask(failedTask), { skipped: true }, "uncertain delivery cannot start a failed scheduling attempt");
  await h.restart({ scheduleTask: async (task) => { h.tasks.push(task); } });
  const retry = await h.request("POST", `/api/import/jobs/${second.id}/stages/garment/regenerate`, {});
  assert.equal(retry.status, 202);
  assert.notEqual(h.tasks[0].taskId, failedTask.taskId);
  assert.deepEqual(await h.plugin.runTask(failedTask), { skipped: true });
  assert.equal((await h.plugin.runTask(h.tasks[0])).job.stages.garment.status, "review");
});

test("crash recovery fails only the matching attempt and permits a new explicit task", async (t) => {
  const h = await harness(t);
  const job = await h.createJob();
  await h.request("POST", `/api/import/jobs/${job.id}/stages/crop/approve`);
  const current = await h.loadJob(job.id);
  current.stages.garment.status = "processing";
  current.stages.garment.attempts = 1;
  await writeFile(h.jobPath(job.id), JSON.stringify(current));
  await h.restart();
  assert.equal(h.requests.length, 1);
  assert.deepEqual(await h.plugin.runTask(h.tasks[0]), { skipped: true });
  assert.deepEqual(await h.plugin.failTask({ ...h.tasks[0], taskId: "obsolete" }), { skipped: true });
  assert.equal((await h.plugin.failTask(h.tasks[0])).job.stages.garment.status, "failed");
  assert.equal((await h.request("POST", `/api/import/jobs/${job.id}/stages/garment/regenerate`, {})).status, 202);
  assert.equal(h.tasks[1].attempt, 2);
  assert.equal((await h.request("POST", `/api/import/jobs/${job.id}/stages/garment/regenerate`, {})).status, 409);
  assert.deepEqual(await h.plugin.failTask(h.tasks[0]), { skipped: true }, "old failures cannot overwrite a new task");
  assert.deepEqual(await h.plugin.runTask(h.tasks[0]), { skipped: true });
  assert.equal((await h.plugin.runTask(h.tasks[1])).job.stages.garment.status, "review");
  assert.equal(h.requests.length, 2);
});

test("cloud mutation checks preserve empty fetches and reject cross-origin or non-JSON submissions", async (t) => {
  const h = await harness(t);
  const payload = { imageBase64: h.source.toString("base64") };
  for (const headers of [
    { origin: "https://attacker.example" },
    { origin: "null" },
    { "sec-fetch-site": "cross-site" },
    { "sec-fetch-site": "same-site" },
  ]) {
    assert.equal((await h.request("POST", "/api/import/jobs", payload, headers)).status, 403);
  }
  for (const headers of [{ "content-type": "text/plain" }, { "content-type": undefined }]) {
    assert.equal((await h.request("POST", "/api/import/jobs", payload, headers)).status, 415);
  }
  assert.equal(h.requests.length, 0);
  const job = await h.createJob();
  assert.equal((await h.request("DELETE", `/api/import/jobs/${job.id}`, undefined, { origin: undefined, "sec-fetch-site": undefined })).status, 200);
});

test("provider deadlines abort analysis and image calls without retrying", async (t) => {
  const h = await harness(t, { requestTimeoutMs: 25 });
  // AbortSignal.timeout uses an unref timer; this timer only keeps the test's
  // process alive until the mocked network requests receive their aborts.
  const keepAlive = setInterval(() => {}, 1_000);
  t.after(() => clearInterval(keepAlive));
  const job = await h.createJob();
  await h.request("POST", `/api/import/jobs/${job.id}/stages/crop/approve`);
  h.blockEndpoint("/images/edits");
  const result = await h.plugin.runTask(h.tasks[0]);
  assert.equal(result.job.stages.garment.status, "failed");
  assert.match(result.job.stages.garment.error, /timeout/i);
  assert.deepEqual(await h.plugin.runTask(h.tasks[0]), { skipped: true });
  h.blockEndpoint("/responses");
  assert.equal((await h.request("POST", "/api/import/jobs", { imageBase64: h.source.toString("base64") })).status, 500);
  assert.equal(h.requests.length, 3, "neither timeout automatically repeats the paid call");
});

test("cloud reads neither initialize storage nor clean up hidden jobs", async (t) => {
  const h = await harness(t, { readOnly: true });
  await assert.rejects(access(path.join(h.root, "data")), { code: "ENOENT" });
  assert.deepEqual((await h.request("GET", "/api/import/jobs")).body, []);
  await h.restart({ readOnly: false });
  const job = await h.createJob();
  job.stages.crop.status = "rejected";
  await writeFile(h.jobPath(job.id), JSON.stringify(job));
  await h.restart({ readOnly: true });
  assert.deepEqual((await h.request("GET", "/api/import/jobs")).body, []);
  await access(h.jobPath(job.id));
});

test("hosted manual uploads reject active work and invalidate old task delivery without paid calls", async (t) => {
  const h = await harness(t);
  const job = await h.createJob();
  const base = `/api/import/jobs/${job.id}/stages`;
  await h.request("POST", `${base}/crop/approve`);
  await h.plugin.runTask(h.tasks[0]);
  await h.request("POST", `${base}/garment/approve`);
  const oldTask = h.tasks[1];
  const bytes = await sharp({ create: { width: 900, height: 600, channels: 3, background: "#888888" } }).png().toBuffer();
  const input = { imageDataUrl: `data:image/png;base64,${bytes.toString("base64")}` };
  assert.equal((await h.request("POST", `${base}/modeled/upload`, input)).status, 409);
  await h.plugin.failTask(oldTask, "Refused");
  const calls = h.requests.length;
  assert.equal((await h.request("POST", `${base}/modeled/upload`, input, { origin: "https://evil.invalid" })).status, 403);
  const uploaded = await h.request("POST", `${base}/modeled/upload`, input);
  assert.equal(uploaded.status, 200);
  assert.equal(uploaded.body.stages.modeled.status, "review");
  assert.deepEqual(await h.plugin.runTask(oldTask), { skipped: true });
  await h.restart();
  assert.equal((await h.loadJob(job.id)).stages.modeled.source, "uploaded");
  assert.equal((await h.request("POST", `${base}/modeled/approve`)).status, 200);
  assert.equal(h.requests.length, calls);
  assert.equal(h.tasks.length, 2, "uploading never queues generation");
});
