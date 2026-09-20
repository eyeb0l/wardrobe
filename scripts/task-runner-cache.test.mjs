import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { CLOUD_ROOT, createCloudStore } from "./cloud-store.mjs";
import { currentStorage, readFile, withStorage } from "./storage-fs.mjs";
import { createTask } from "../server/task-store.mjs";

test("default task workers reuse bounded image bytes while paths, leases and injected clients stay fresh", async (t) => {
  t.mock.method(globalThis, "fetch", async () => assert.fail("Worker cache tests must never contact external services"));
  const pg = new PGlite();
  t.after(() => pg.close());
  const tokens = [];
  const database = {
    async query(sql, values = []) {
      if (sql.startsWith("UPDATE wardrobe_storage_lease SET token = $1::uuid")) tokens.push(values[0]);
      return (await pg.query(sql, values)).rows;
    },
    transaction(statements) {
      return pg.transaction(async (transaction) => {
        const results = [];
        for (const { text, values = [] } of statements) results.push((await transaction.query(text, values)).rows);
        return results;
      });
    },
  };
  const blobs = new Map();
  let downloads = 0;
  const blob = {
    async put(name, bytes) {
      const url = `https://worker-cache.invalid/${name}`;
      assert.ok(!blobs.has(url));
      blobs.set(url, Buffer.from(bytes));
      return { url };
    },
    async get(url, options) {
      assert.equal(options.access, "private");
      assert.equal(options.useCache, true);
      downloads += 1;
      return { statusCode: 200, stream: new Response(blobs.get(url)).body };
    },
  };
  const makeStore = () => createCloudStore({ database, blob });
  const writer = makeStore();
  await writer.initialize();
  const write = (operation) => writer.withLease(() => withStorage(writer, operation));
  const image = `${CLOUD_ROOT}/image.png`;
  await write(() => writer.writeFile(image, Buffer.from("original")));
  const task = await write(() => createTask({ kind: "outfit", taskId: randomUUID() }));

  // Replace only the runner's default factory, retaining the real cloud store,
  // database, lease fencing, task records and image cache under test.
  const key = `wardrobe-task-store-test-${randomUUID()}`;
  let clients = 0;
  globalThis[key] = () => { clients += 1; return makeStore(); };
  t.after(() => { delete globalThis[key]; });
  const runnerUrl = new URL(`../server/task-runner.mjs?cache-test=${randomUUID()}`, import.meta.url).href;
  const stub = `data:text/javascript,${encodeURIComponent(`export const createCloudStore = () => globalThis[${JSON.stringify(key)}]();`)}`;
  const hooks = registerHooks({ resolve(specifier, context, next) {
    return next(context.parentURL === runnerUrl && specifier === "../scripts/cloud-store.mjs" ? stub : specifier, context);
  } });
  let executeCloudTask;
  try { ({ executeCloudTask } = await import(runnerUrl)); } finally { hooks.deregister(); }

  let reservations = 0;
  let expected = "original";
  let expectedStore;
  const options = {
    enabled: () => true,
    reserve: async () => { reservations += 1; },
    pluginFactory: async (_kind, { beforePaidCall }) => ({
      async runTask() {
        await beforePaidCall("image");
        if (expectedStore) assert.equal(currentStorage(), expectedStore);
        if (expected === null) { await assert.rejects(readFile(image), { code: "ENOENT" }); return false; }
        assert.equal((await readFile(image)).toString(), expected);
        return true;
      },
      async failTask() {},
    }),
  };
  await executeCloudTask(task.id, 0, options);
  await executeCloudTask(task.id, 1, options);
  assert.equal(clients, 1, "a warm worker keeps one default client");
  assert.equal(downloads, 1, "unchanged image bytes are reused across durable steps");

  expected = "replacement";
  await write(() => writer.writeFile(image, Buffer.from(expected)));
  await executeCloudTask(task.id, 2, options);
  assert.equal(downloads, 2, "replacement paths resolve their new immutable blob");
  await write(() => writer.rm(image));
  expected = null;
  await executeCloudTask(task.id, 3, options);
  await executeCloudTask(task.id, 3, options);
  assert.equal(downloads, 2, "deleted paths cannot expose cached bytes");
  assert.equal(reservations, 4, "duplicate delivery does not reserve or run paid work again");

  expected = "injected";
  await write(() => writer.writeFile(image, Buffer.from(expected)));
  const injectedTask = await write(() => createTask({ kind: "outfit", taskId: randomUUID() }));
  for (let step = 0; step < 2; step += 1) {
    expectedStore = makeStore();
    await executeCloudTask(injectedTask.id, step, { ...options, store: expectedStore });
  }
  assert.equal(downloads, 4, "separate injected clients do not share their byte caches");
  assert.equal(clients, 1, "injected stores never replace or create the default client");
  assert.equal(new Set(tokens).size, tokens.length, "every operation acquires a fresh lease token");
});
