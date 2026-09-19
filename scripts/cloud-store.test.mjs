import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm as localRm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { PGlite } from "@electric-sql/pglite";
import { createCloudStore, CLOUD_ROOT } from "./cloud-store.mjs";
import { withStorage, currentStorage, mkdir, readFile, writeFile } from "./storage-fs.mjs";

async function harness(t) {
  const pg = new PGlite();
  t.after(() => pg.close());
  const database = {
    async query(text, values = []) { return (await pg.query(text, values)).rows; },
    async transaction(statements) { return pg.transaction(async (tx) => {
      const results = [];
      for (const { text, values = [] } of statements) results.push((await tx.query(text, values)).rows);
      return results;
    }); },
  };
  const blobs = new Map();
  const reads = [];
  const blob = {
    async put(name, bytes, options) {
      assert.equal(options.access, "private");
      assert.equal(options.allowOverwrite, false);
      const url = `https://private.test/${name}`;
      assert.ok(!blobs.has(url));
      blobs.set(url, Buffer.from(bytes));
      return { url };
    },
    async get(url, options) {
      reads.push({ url, options });
      const value = blobs.get(url);
      return value ? { statusCode: 200, stream: new Response(value).body } : null;
    },
  };
  const store = createCloudStore({ database, blob });
  await store.initialize();
  return { pg, database, blob, blobs, reads, store, other: () => createCloudStore({ database, blob }) };
}

test("storage context stays isolated between concurrent requests and defaults to local disk", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wardrobe-fs-"));
  t.after(() => localRm(root, { recursive: true, force: true }));
  const file = path.join(root, "local.json");
  await writeFile(file, "local");
  const a = { readFile: async () => { await new Promise((resolve) => setImmediate(resolve)); return "a"; } };
  const b = { readFile: async () => "b" };
  const result = await Promise.all([
    withStorage(a, async () => { await new Promise((resolve) => setImmediate(resolve)); return readFile(file); }),
    withStorage(b, () => readFile(file)),
    readFile(file, "utf8"),
  ]);
  assert.deepEqual(result, ["a", "b", "local"]);
  assert.equal(currentStorage(), undefined);
});

test("cloud directories, exact bytes, atomic publication and immutable links", async (t) => {
  const h = await harness(t);
  const { store } = h;
  await store.withLease(() => withStorage(store, async () => {
    await mkdir(`${CLOUD_ROOT}/jobs/nested`, { recursive: true });
    const bytes = Buffer.from([137, 80, 78, 71, 0, 255, 1]);
    await writeFile(`${CLOUD_ROOT}/jobs/image.png.tmp`, bytes, { flag: "wx" });
    await store.link(`${CLOUD_ROOT}/jobs/image.png.tmp`, `${CLOUD_ROOT}/jobs/image.png`);
    await store.rm(`${CLOUD_ROOT}/jobs/image.png.tmp`);
    assert.deepEqual(await readFile(`${CLOUD_ROOT}/jobs/image.png`), bytes);
    assert.equal(h.blobs.size, 1, "links share immutable Blob contents");
    await writeFile(`${CLOUD_ROOT}/jobs/state.json.abc.tmp`, '{"count":1}\n', { flag: "wx" });
    await store.rename(`${CLOUD_ROOT}/jobs/state.json.abc.tmp`, `${CLOUD_ROOT}/jobs/state.json`);
    assert.equal(await readFile(`${CLOUD_ROOT}/jobs/state.json`, "utf8"), '{"count":1}\n');
    assert.equal(h.blobs.size, 1, "JSON publication uses database only");
    await assert.rejects(store.stat(`${CLOUD_ROOT}/jobs/state.json.abc.tmp`), { code: "ENOENT" });
    await store.copyFile(`${CLOUD_ROOT}/jobs/image.png`, `${CLOUD_ROOT}/jobs/nested/image.png`);
    await store.rename(`${CLOUD_ROOT}/jobs/nested`, `${CLOUD_ROOT}/renamed`);
    assert.deepEqual(await store.readFile(`${CLOUD_ROOT}/renamed/image.png`), bytes);
    const entries = await store.readdir(CLOUD_ROOT, { withFileTypes: true });
    assert.deepEqual(entries.map((entry) => [entry.name, entry.isDirectory()]), [["jobs", true], ["renamed", true]]);
    await store.rm(`${CLOUD_ROOT}/jobs`, { recursive: true });
    assert.deepEqual(await store.readFile(`${CLOUD_ROOT}/renamed/image.png`), bytes);
    assert.equal(h.blobs.size, 1, "unlink does not race with surviving links or readers");
  }));
  assert.equal((await store.stat(`${CLOUD_ROOT}/renamed/image.png`)).size, 7);
  assert.ok(h.reads.every(({ options }) => options.access === "private" && options.useCache === true));
});

test("cloud fs rejects path escape, missing parents, type collisions, and exclusive overwrites", async (t) => {
  const { store } = await harness(t);
  for (const value of ["relative.json", "/etc/passwd", "/wardrobe-data-other/a", `${CLOUD_ROOT}/../secret`, `${CLOUD_ROOT}/a/../../wardrobe-data/x`, `${CLOUD_ROOT}/a\0b`]) {
    await assert.rejects(store.readFile(value), { code: "EACCES" });
  }
  await assert.rejects(store.writeFile(`${CLOUD_ROOT}/no-lease.json`, "{}"), { code: "ESTALE" });
  await store.withLease(async () => {
    await assert.rejects(store.writeFile(`${CLOUD_ROOT}/missing/child.json`, "{}"), { code: "ENOENT" });
    await store.mkdir(`${CLOUD_ROOT}/a`);
    await assert.rejects(store.mkdir(`${CLOUD_ROOT}/a`), { code: "EEXIST" });
    await store.writeFile(`${CLOUD_ROOT}/a/state.json`, "{}");
    await assert.rejects(store.writeFile(`${CLOUD_ROOT}/a/state.json`, "changed", { flag: "wx" }), { code: "EEXIST" });
    assert.equal(await store.readFile(`${CLOUD_ROOT}/a/state.json`, "utf8"), "{}");
    await assert.rejects(store.link(`${CLOUD_ROOT}/a/state.json`, `${CLOUD_ROOT}/a/state.json`), { code: "EEXIST" });
    await assert.rejects(store.copyFile(`${CLOUD_ROOT}/a/state.json`, `${CLOUD_ROOT}/a/state.json`, 1), { code: "EEXIST" });
    await assert.rejects(store.mkdir(`${CLOUD_ROOT}/a/state.json/child`, { recursive: true }), { code: "ENOTDIR" });
    await assert.rejects(store.rm(`${CLOUD_ROOT}/a`), { code: "EISDIR" });
    await assert.rejects(store.rename(`${CLOUD_ROOT}/a`, `${CLOUD_ROOT}/a/nested`), { code: "EINVAL" });
    await assert.rejects(store.rename(`${CLOUD_ROOT}/a/state.json`, "/escape"), { code: "EACCES" });
    await assert.rejects(store.rm(CLOUD_ROOT, { recursive: true }), { code: "EPERM" });
    await store.rm(`${CLOUD_ROOT}/missing`, { force: true });
    await assert.rejects(store.readFile(`${CLOUD_ROOT}/a`), { code: "EISDIR" });
  });
});

test("the database lease excludes other stores and expired owners cannot overwrite a new owner", async (t) => {
  const h = await harness(t);
  const second = h.other();
  await assert.rejects(h.store.withLease(async () => {
    await h.store.writeFile(`${CLOUD_ROOT}/state.json`, '"first"');
    await assert.rejects(second.withLease(() => second.writeFile(`${CLOUD_ROOT}/state.json`, '"competing"')), { code: "EBUSY" });
    await h.pg.query("UPDATE wardrobe_storage_lease SET expires_at = clock_timestamp() - interval '1 second' WHERE id = 1");
    await second.withLease(async () => {
      await second.writeFile(`${CLOUD_ROOT}/state.json`, '"second"');
      // The old owner's continuation carries its own AsyncLocalStorage lease.
      await assert.rejects(h.store.writeFile(`${CLOUD_ROOT}/state.json`, '"stale"'), { code: "ESTALE" });
    });
    await assert.rejects(h.store.writeFile(`${CLOUD_ROOT}/state.json`, '"stale"'), { code: "ESTALE" });
  }), { code: "ESTALE" });
  assert.equal(await h.store.readFile(`${CLOUD_ROOT}/state.json`, "utf8"), '"second"');
  await second.withLease(() => second.writeFile(`${CLOUD_ROOT}/after.json`, "{}"));
});

test("an expired lease during Blob upload cannot publish stale image metadata", async (t) => {
  const h = await harness(t);
  const second = h.other();
  const originalPut = h.blob.put;
  h.blob.put = async (...args) => {
    const uploaded = await originalPut(...args);
    await h.pg.query("UPDATE wardrobe_storage_lease SET expires_at = clock_timestamp() - interval '1 second' WHERE id = 1");
    await second.withLease(() => second.writeFile(`${CLOUD_ROOT}/result.json`, '"winner"'));
    return uploaded;
  };
  await assert.rejects(h.store.withLease(() => h.store.writeFile(`${CLOUD_ROOT}/stale.png`, Buffer.from([0, 255, 137]))), { code: "ESTALE" });
  await assert.rejects(h.store.stat(`${CLOUD_ROOT}/stale.png`), { code: "ENOENT" });
  assert.equal(await second.readFile(`${CLOUD_ROOT}/result.json`, "utf8"), '"winner"');
  assert.equal(h.blobs.size, 1, "unpublished upload is retained for later safe garbage collection");
});

test("concurrent exclusive publications produce one winner and preserve its bytes", async (t) => {
  const { store } = await harness(t);
  await store.withLease(async () => {
    const results = await Promise.allSettled([
      store.writeFile(`${CLOUD_ROOT}/unique.json`, '"one"', { flag: "wx" }),
      store.writeFile(`${CLOUD_ROOT}/unique.json`, '"two"', { flag: "wx" }),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.find((result) => result.status === "rejected").reason.code, "EEXIST");
    assert.ok(['"one"', '"two"'].includes(await store.readFile(`${CLOUD_ROOT}/unique.json`, "utf8")));
  });
});


test("literal prefix paths and dot directories cannot delete neighboring data", async (t) => {
  const { store } = await harness(t);
  await store.withLease(async () => {
    await store.mkdir(`${CLOUD_ROOT}/.tasks`);
    await store.writeFile(`${CLOUD_ROOT}/.tasks/queued.json`, "{}");
    await store.mkdir(`${CLOUD_ROOT}/a_%`);
    await store.mkdir(`${CLOUD_ROOT}/a_%-sibling`);
    await store.writeFile(`${CLOUD_ROOT}/a_%/state.json`, "{}");
    await store.writeFile(`${CLOUD_ROOT}/a_%-sibling/keep.json`, "{}");
    assert.deepEqual(await store.readdir(`${CLOUD_ROOT}/a_%`), ["state.json"]);
    await store.rm(`${CLOUD_ROOT}/a_%`, { recursive: true });
    assert.equal(await store.readFile(`${CLOUD_ROOT}/a_%-sibling/keep.json`, "utf8"), "{}");
    assert.ok((await store.readdir(CLOUD_ROOT)).includes(".tasks"));
    const original = Buffer.from([239, 187, 191, 123, 125]);
    await store.writeFile(`${CLOUD_ROOT}/bom.json`, original);
    assert.deepEqual(await store.readFile(`${CLOUD_ROOT}/bom.json`), original, "binary storage preserves a UTF8 BOM exactly");
  });
});

test("failed directory rename leaves both trees intact", async (t) => {
  const { store } = await harness(t);
  await store.withLease(async () => {
    for (const dir of ["source", "destination"]) {
      await store.mkdir(`${CLOUD_ROOT}/${dir}`);
      await store.writeFile(`${CLOUD_ROOT}/${dir}/state.json`, JSON.stringify(dir));
    }
    await assert.rejects(store.rename(`${CLOUD_ROOT}/source`, `${CLOUD_ROOT}/destination`), { code: "ENOTEMPTY" });
    assert.equal(await store.readFile(`${CLOUD_ROOT}/source/state.json`, "utf8"), '"source"');
    assert.equal(await store.readFile(`${CLOUD_ROOT}/destination/state.json`, "utf8"), '"destination"');
  });
});

test("interactive acquisition waits for finalization and runs its mutation exactly once", async (t) => {
  const h = await harness(t);
  let published, release;
  const visible = new Promise((resolve) => { published = resolve; });
  const finalize = new Promise((resolve) => { release = resolve; });
  const worker = h.store.withLease(async () => {
    await h.store.writeFile(`${CLOUD_ROOT}/stage.json`, '"review"');
    published();
    await finalize;
  });
  await visible;
  const next = h.other();
  let callbacks = 0;
  const action = next.withLease(async () => {
    callbacks++;
    assert.equal(await next.readFile(`${CLOUD_ROOT}/stage.json`, "utf8"), '"review"');
    await next.writeFile(`${CLOUD_ROOT}/stage.json`, '"modeled-queued"');
  }, { waitMs: 2_000 });
  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(callbacks, 0, "visible result does not bypass the finishing worker's lease");
  } finally { release(); }
  await Promise.all([worker, action]);
  assert.equal(callbacks, 1);
  assert.equal(await h.store.readFile(`${CLOUD_ROOT}/stage.json`, "utf8"), '"modeled-queued"');
});

test("busy acquisition has a bounded wait and never starts the action", async (t) => {
  const h = await harness(t);
  await h.store.withLease(async () => {
    let callbacks = 0;
    const start = performance.now();
    await assert.rejects(h.other().withLease(() => { callbacks++; }, { waitMs: 40 }), { code: "EBUSY", status: 409 });
    assert.ok(performance.now() - start < 1_000);
    assert.equal(callbacks, 0);
    await h.store.assertLease();
  });
});

test("abandoned waiting actions are cancelled without modifying or stealing ownership", async (t) => {
  const h = await harness(t);
  let callbacks = 0;
  const controller = new AbortController();
  await h.store.withLease(async () => {
    const waiting = h.other().withLease(() => { callbacks++; }, { waitMs: 2_000, signal: controller.signal });
    const rejected = assert.rejects(waiting, { name: "AbortError" });
    controller.abort();
    await rejected;
    await h.store.assertLease();
  });
  assert.equal(callbacks, 0);
  await assert.rejects(h.other().withLease(() => { callbacks++; }, { signal: controller.signal }), { name: "AbortError" });
  assert.equal(callbacks, 0);
});

test("cancellation during acquisition releases the newly acquired lease before any action", async (t) => {
  const h = await harness(t);
  const controller = new AbortController();
  const store = createCloudStore({ blob: h.blob, database: { ...h.database,
    async query(sql, values) {
      const rows = await h.database.query(sql, values);
      if (sql.includes("RETURNING token") && rows.length) controller.abort();
      return rows;
    },
  } });
  await assert.rejects(store.withLease(() => assert.fail("An abandoned action must not run"), { waitMs: 2_000, signal: controller.signal }), { name: "AbortError" });
  await h.other().withLease(async () => {});
});

test("a callback failure after acquiring ownership never replays the action", async (t) => {
  const h = await harness(t);
  let callbacks = 0;
  await assert.rejects(h.store.withLease(async () => {
    callbacks++;
    await h.store.writeFile(`${CLOUD_ROOT}/committed.json`, "true");
    throw Object.assign(new Error("failure after side effect"), { code: "EBUSY" });
  }, { waitMs: 2_000 }), /failure after side effect/);
  assert.equal(callbacks, 1);
  assert.equal(await h.store.readFile(`${CLOUD_ROOT}/committed.json`, "utf8"), "true");
  await h.other().withLease(async () => {});
});

test("warm original reads deduplicate by immutable URL while replacement, deletion and backup verification stay fresh", async t => {
  const h = await harness(t), file = `${CLOUD_ROOT}/image.png`, alias = `${CLOUD_ROOT}/alias.png`;
  const original = Buffer.from([0,1,2,3]);
  await h.store.withLease(async()=>{await h.store.writeFile(file,original);await h.store.link(file,alias)});
  const [a,b] = await Promise.all([h.store.readFile(file),h.store.readFile(alias)]);
  assert.equal(h.reads.length,1);assert.equal(h.reads[0].options.useCache,true);
  a.fill(9);assert.deepEqual(b,original);assert.deepEqual(await h.store.readFile(file),original);
  const url = h.reads[0].url;
  await h.store.withLease(()=>h.store.readBackupBlob(url));
  assert.equal(h.reads.length,2);assert.equal(h.reads[1].options.useCache,false,'verification must bypass all caches');
  const replacement=Buffer.from([0,5,6,7]);
  await h.store.withLease(()=>h.store.writeFile(file,replacement));
  assert.deepEqual(await h.store.readFile(file),replacement);
  assert.deepEqual(await h.store.readFile(alias),original,'a surviving link retains its own immutable identity');
  await h.store.withLease(()=>h.store.rm(file));await assert.rejects(h.store.readFile(file),{code:'ENOENT'});
});
