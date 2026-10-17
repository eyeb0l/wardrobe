import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { createCloudStore, CLOUD_ROOT } from "./cloud-store.mjs";
import { upgradeCloudSchema } from "./upgrade-cloud-schema.mjs";

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
  const blob = { async put(name) { return { url: `https://private.test/${name}` }; }, async get() { return null; } };
  const store = createCloudStore({ database, blob });
  await store.initialize();
  return { pg, store };
}

const plan = async (pg, sql, values = []) => {
  await pg.exec("SET enable_seqscan = off");
  try { return (await pg.query(`EXPLAIN ${sql}`, values)).rows.map(row => row["QUERY PLAN"]).join("\n"); }
  finally { await pg.exec("RESET enable_seqscan"); }
};

test("prefix operations match exactly one subtree, including LIKE metacharacters and sibling names", async (t) => {
  const { store } = await harness(t);
  const dirs = ["jobs", "jobs/a", "jobs-old", "jobs0", "jobs.x", "a_b", "aXb", "a%b", "a%bc", "é", "é/x"];
  await store.withLease(async () => {
    for (const dir of dirs) await store.mkdir(`${CLOUD_ROOT}/${dir}`, { recursive: true });
    for (const dir of dirs) await store.writeFile(`${CLOUD_ROOT}/${dir}/f.json`, "{}");
  });
  assert.deepEqual(await store.readdir(`${CLOUD_ROOT}/jobs`), ["a", "f.json"]);
  assert.deepEqual(await store.readdir(`${CLOUD_ROOT}/a_b`), ["f.json"]);
  assert.deepEqual(await store.readdir(`${CLOUD_ROOT}/a%b`), ["f.json"]);
  assert.deepEqual(await store.readdir(`${CLOUD_ROOT}/é`), ["f.json", "x"]);
  await store.withLease(async () => {
    await store.rm(`${CLOUD_ROOT}/a_b`, { recursive: true });
    await store.rm(`${CLOUD_ROOT}/a%b`, { recursive: true });
    await store.rename(`${CLOUD_ROOT}/jobs`, `${CLOUD_ROOT}/moved`);
  });
  assert.deepEqual(await store.readdir(CLOUD_ROOT), ["a%bc", "aXb", "jobs-old", "jobs.x", "jobs0", "moved", "é"]);
  assert.deepEqual(await store.readdir(`${CLOUD_ROOT}/moved`), ["a", "f.json"]);
  assert.deepEqual(await store.readdir(`${CLOUD_ROOT}/moved/a`), ["f.json"]);
  for (const dir of ["aXb", "a%bc", "jobs-old", "jobs0", "jobs.x"]) assert.deepEqual(await store.readdir(`${CLOUD_ROOT}/${dir}`), ["f.json"]);
  await store.withLease(() => store.mkdir(`${CLOUD_ROOT}/empty`));
  await assert.rejects(store.withLease(() => store.rename(`${CLOUD_ROOT}/aXb`, `${CLOUD_ROOT}/moved`)), { code: "ENOTEMPTY" });
  await store.withLease(() => store.rename(`${CLOUD_ROOT}/aXb`, `${CLOUD_ROOT}/empty`));
  assert.deepEqual(await store.readdir(`${CLOUD_ROOT}/empty`), ["f.json"]);
});

test("descendant and Blob reference lookups can use indexes", async (t) => {
  const { pg } = await harness(t);
  const prefix = `${CLOUD_ROOT}/jobs`;
  const descendants = await plan(pg, `SELECT path FROM wardrobe_files WHERE path COLLATE "C" >= $1 || '/' AND path COLLATE "C" < $1 || '0'
    AND left(path, length($1) + 1) = $1 || '/'`, [prefix]);
  assert.match(descendants, /Index (Only )?Scan using wardrobe_files_path_c|Bitmap Index Scan on wardrobe_files_path_c/);
  // plpgsql reuses generic plans, where a parameterized LIKE prefix could not use an index.
  await pg.exec(`SET plan_cache_mode = force_generic_plan; SET enable_seqscan = off;
    PREPARE descendants(text) AS DELETE FROM wardrobe_files WHERE path = $1 OR (path COLLATE "C" >= $1 || '/' AND path COLLATE "C" < $1 || '0'
      AND left(path, length($1) + 1) = $1 || '/')`);
  const generic = (await pg.query(`EXPLAIN EXECUTE descendants('${prefix}')`)).rows.map(row => row["QUERY PLAN"]).join("\n");
  await pg.exec("DEALLOCATE descendants; RESET plan_cache_mode; RESET enable_seqscan");
  assert.match(generic, /wardrobe_files_path_c/);
  assert.doesNotMatch(generic, /Seq Scan/);
  assert.match(await plan(pg, "SELECT 1 FROM wardrobe_files WHERE blob_url = $1", ["https://private.test/x"]), /wardrobe_files_blob_url/);
  assert.match(await plan(pg, "SELECT 1 FROM wardrobe_image_variants WHERE source_blob_url = $1", ["https://private.test/x"]), /wardrobe_image_variants_source/);
  assert.match(await plan(pg, "SELECT 1 FROM wardrobe_image_variants WHERE blob_url = $1", ["https://private.test/x"]), /wardrobe_image_variants_blob_url/);
});

test("schema upgrade is a dry run by default and idempotently restores missing indexes", async (t) => {
  const { pg, store } = await harness(t);
  const indexes = async () => (await pg.query("SELECT indexname FROM pg_indexes WHERE indexname LIKE 'wardrobe\\_%' ORDER BY indexname")).rows.map(row => row.indexname);
  const expected = ["wardrobe_files_blob_url", "wardrobe_files_path_c", "wardrobe_image_variants_blob_url", "wardrobe_image_variants_source"];
  for (const name of expected) assert.ok((await indexes()).includes(name), name);
  for (const name of expected) await pg.exec(`DROP INDEX ${name}`);
  await store.withLease(() => store.writeFile(`${CLOUD_ROOT}/library.json`, "[]"));
  const log = [];
  assert.deepEqual((await upgradeCloudSchema({ store, log: message => log.push(message) })).applied, false);
  for (const name of expected) assert.ok(!(await indexes()).includes(name));
  await upgradeCloudSchema({ store, apply: true, log: () => {} });
  await upgradeCloudSchema({ store, apply: true, log: () => {} });
  for (const name of expected) assert.ok((await indexes()).includes(name), name);
  assert.equal(await store.readFile(`${CLOUD_ROOT}/library.json`, "utf8"), "[]");
  assert.match(log[0], /dry run/);
});
