import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { createCloudStore, CLOUD_ROOT } from "./cloud-store.mjs";

const file = (name, contents) => ({ path: `${CLOUD_ROOT}/${name}`, bytes: Buffer.from(contents) });
const png = Buffer.from([137, 80, 78, 71, 0, 255, 1]);

async function harness(t) {
  const pg = new PGlite();
  t.after(() => pg.close());
  const database = {
    async query(text, values = []) { return (await pg.query(text, values)).rows; },
    async transaction(statements) {
      return pg.transaction(async (tx) => {
        const results = [];
        for (const { text, values = [] } of statements) results.push((await tx.query(text, values)).rows);
        return results;
      });
    },
  };
  const blobs = new Map();
  const reads = [];
  const blob = {
    async put(name, bytes, options) {
      assert.equal(options.access, "private");
      assert.equal(options.addRandomSuffix, true);
      assert.equal(options.allowOverwrite, false);
      const url = `https://private.test/${name}`;
      assert.ok(!blobs.has(url));
      blobs.set(url, Buffer.from(bytes));
      return { url };
    },
    async get(url, options) {
      reads.push({ url, options });
      const bytes = blobs.get(url);
      return bytes ? { statusCode: 200, stream: new Response(bytes).body } : null;
    },
  };
  const store = createCloudStore({ database, blob });
  await store.initialize();
  const expire = () => pg.query("UPDATE wardrobe_storage_lease SET expires_at = clock_timestamp() - interval '1 second' WHERE id = 1");
  return { pg, database, blobs, reads, blob, store, expire };
}

test("backup inventory captures ordered exact metadata and reads only referenced private original bytes", async (t) => {
  const h = await harness(t);
  await assert.rejects(h.store.backupInventory(), { code: "ESTALE" });
  await assert.rejects(h.store.readBackupBlob("https://outside.test/image.png"), { code: "ESTALE" });
  await assert.rejects(h.store.replaceFromBackup([]), { code: "ESTALE" });
  await h.store.withLease(async () => {
    await h.store.mkdir(`${CLOUD_ROOT}/library`);
    await h.store.writeFile(`${CLOUD_ROOT}/library/item.png`, png);
    await h.store.writeFile(`${CLOUD_ROOT}/library.json`, '[{"hidden":true}]\n');
    const rows = await h.store.backupInventory();
    assert.deepEqual(rows.map((row) => [row.path, row.kind]), [
      [CLOUD_ROOT, "dir"], [`${CLOUD_ROOT}/library`, "dir"],
      [`${CLOUD_ROOT}/library.json`, "file"], [`${CLOUD_ROOT}/library/item.png`, "file"],
    ]);
    assert.equal(rows[2].text_content, '[{"hidden":true}]\n');
    assert.equal(Number(rows[2].size), Buffer.byteLength(rows[2].text_content));
    assert.ok(rows.every((row) => Number.isFinite(new Date(row.updated_at).getTime())));
    assert.deepEqual(await h.store.readBackupBlob(rows[3].blob_url), png);
    assert.deepEqual(h.reads[0].options, { access: "private", useCache: false });
    await assert.rejects(h.store.readBackupBlob("https://outside.test/image.png"), { code: "EACCES" });
    assert.equal(h.reads.length, 1, "untrusted and orphan URLs must never be fetched");
    await h.store.rm(`${CLOUD_ROOT}/library/item.png`);
    await assert.rejects(h.store.readBackupBlob(rows[3].blob_url), { code: "EACCES" });
    assert.equal(h.reads.length, 1);
  });
});

test("backup primitives reject expired leases before reading or replacing data", async (t) => {
  const h = await harness(t);
  await assert.rejects(h.store.withLease(async () => {
    await h.store.writeFile(`${CLOUD_ROOT}/original.png`, png);
    const [row] = await h.database.query("SELECT blob_url FROM wardrobe_files WHERE blob_url IS NOT NULL");
    await h.expire();
    await assert.rejects(h.store.backupInventory(), { code: "ESTALE" });
    await assert.rejects(h.store.readBackupBlob(row.blob_url), { code: "ESTALE" });
    await assert.rejects(h.store.replaceFromBackup([file("replacement.png", png)]), { code: "ESTALE" });
  }), { code: "ESTALE" });
  assert.equal(h.reads.length, 0);
  assert.equal(h.blobs.size, 1);
  assert.deepEqual(await h.store.readFile(`${CLOUD_ROOT}/original.png`), png);
});

test("atomic restore rebuilds parents and exact bytes without changing derivative metadata", async (t) => {
  const h = await harness(t);
  await h.store.withLease(async () => {
    await h.store.writeFile(`${CLOUD_ROOT}/old.png`, png);
    const [old] = await h.database.query("SELECT blob_url FROM wardrobe_files WHERE blob_url IS NOT NULL");
    await h.database.query(`INSERT INTO wardrobe_image_variants (cache_key, source_blob_url, recipe, width, blob_url, size)
      VALUES ('retained', $1, 'old-recipe', 320, 'https://private.test/derivative.webp', 7)`, [old.blob_url]);
    const [root] = await h.database.query("SELECT * FROM wardrobe_files WHERE path = $1", [CLOUD_ROOT]);
    const bom = Buffer.from([239, 187, 191, 123, 125]);
    const files = [file("library.json", '[{"hidden":true,"name":"Café"}]\n'), file("images/nested/item.png", png),
      file("bom.json", bom), file("notes/prompt.txt", "Keep all details"), file("manifest", '{"ok":true}\n')];
    assert.deepEqual(await h.store.replaceFromBackup(files), { files: 5, directories: 3, uploadedBlobs: 3 });
    for (const entry of files) assert.deepEqual(await h.store.readFile(entry.path), entry.bytes);
    await assert.rejects(h.store.stat(`${CLOUD_ROOT}/old.png`), { code: "ENOENT" });
    assert.deepEqual((await h.database.query("SELECT * FROM wardrobe_files WHERE path = $1", [CLOUD_ROOT]))[0], root);
    const rows = await h.store.backupInventory();
    assert.equal(rows.filter((row) => row.kind === "dir").length, 4);
    assert.equal(rows.find((row) => row.path.endsWith("/manifest")).text_content, '{"ok":true}\n');
    assert.ok(rows.find((row) => row.path.endsWith("/bom.json")).blob_url);
    const [variant] = await h.database.query("SELECT * FROM wardrobe_image_variants WHERE cache_key = 'retained'");
    assert.equal(variant.source_blob_url, old.blob_url);
    assert.ok(h.blobs.has(old.blob_url), "replaced originals remain available through the GC grace period");
    assert.equal(h.blobs.size, 4);
  });
});

test("restore validates all paths, bytes, duplicates and hierarchy before staging any uploads", async (t) => {
  const h = await harness(t);
  const badInputs = [null, {}, [null], [{ path: `${CLOUD_ROOT}/x`, bytes: "text" }],
    [file("same.png", png), file("same.png", png)],
    [file("a", png), file("a/child", png)], [file("a/child", png), file("a", png)],
    ...["/outside/file", `${CLOUD_ROOT}/../outside`, `${CLOUD_ROOT}/x/../y`, `${CLOUD_ROOT}/a\\b`, `${CLOUD_ROOT}/a\0b`,
      CLOUD_ROOT, `${CLOUD_ROOT}/`, `${CLOUD_ROOT}//x`, `${CLOUD_ROOT}/./x`, `${CLOUD_ROOT}/x/`, "relative"].map((path) => [{ path, bytes: png }])];
  await h.store.withLease(async () => {
    await h.store.writeFile(`${CLOUD_ROOT}/keep.json`, "{}");
    const before = await h.store.backupInventory();
    for (const input of badInputs) await assert.rejects(h.store.replaceFromBackup(input));
    assert.deepEqual(await h.store.backupInventory(), before);
    assert.equal(h.blobs.size, 0);
  });
});

test("an upload failure leaves all previous metadata intact and earlier uploads unpublished", async (t) => {
  const h = await harness(t);
  await h.store.withLease(async () => {
    await h.store.writeFile(`${CLOUD_ROOT}/keep.json`, '{"keep":true}');
    const before = await h.store.backupInventory();
    const put = h.blob.put;
    let attempts = 0;
    h.blob.put = async (...args) => {
      if (++attempts === 2) throw new Error("Upload interrupted");
      return put(...args);
    };
    await assert.rejects(h.store.replaceFromBackup([file("new/first.png", png), file("new/second.png", png)]), /Upload interrupted/);
    assert.deepEqual(await h.store.backupInventory(), before);
    assert.equal(h.blobs.size, 1);
    assert.equal((await h.database.query("SELECT * FROM wardrobe_files WHERE blob_url IS NOT NULL")).length, 0);
  });
});

test("a publication failure rolls back deletion and insertion together", async (t) => {
  const h = await harness(t);
  await h.store.withLease(async () => {
    await h.store.writeFile(`${CLOUD_ROOT}/keep.json`, '{"keep":true}');
    const before = await h.store.backupInventory();
    await h.database.query("ALTER TABLE wardrobe_files ADD CONSTRAINT reject_restore_test CHECK (path <> '/wardrobe-data/rejected.png')");
    await assert.rejects(h.store.replaceFromBackup([file("new/state.json", "{}"), file("rejected.png", png)]), /reject_restore_test/);
    assert.deepEqual(await h.store.backupInventory(), before);
    assert.equal(h.blobs.size, 1, "failed transaction leaves the uploaded orphan for normal garbage collection");
  });
});

test("lease loss during restore upload cannot publish a replacement", async (t) => {
  const h = await harness(t);
  await h.store.withLease(() => h.store.writeFile(`${CLOUD_ROOT}/keep.json`, '{"keep":true}'));
  const put = h.blob.put;
  h.blob.put = async (...args) => {
    const result = await put(...args);
    await h.expire();
    return result;
  };
  await assert.rejects(h.store.withLease(() => h.store.replaceFromBackup([file("restored.png", png)])), { code: "ESTALE" });
  assert.equal(await h.store.readFile(`${CLOUD_ROOT}/keep.json`, "utf8"), '{"keep":true}');
  await assert.rejects(h.store.stat(`${CLOUD_ROOT}/restored.png`), { code: "ENOENT" });
});

test("lease loss during backup download rejects the result and missing images fail closed", async (t) => {
  const h = await harness(t);
  await h.store.withLease(async () => {
    await h.store.writeFile(`${CLOUD_ROOT}/original.png`, png);
    const [row] = await h.database.query("SELECT blob_url FROM wardrobe_files WHERE blob_url IS NOT NULL");
    const saved = h.blobs.get(row.blob_url);
    h.blobs.delete(row.blob_url);
    await assert.rejects(h.store.readBackupBlob(row.blob_url), { code: "ENOENT" });
    h.blobs.set(row.blob_url, saved);
  });
  const get = h.blob.get;
  h.blob.get = async (...args) => {
    const result = await get(...args);
    await h.expire();
    return result;
  };
  await assert.rejects(h.store.withLease(async () => {
    const [row] = await h.database.query("SELECT blob_url FROM wardrobe_files WHERE blob_url IS NOT NULL");
    await h.store.readBackupBlob(row.blob_url);
  }), { code: "ESTALE" });
});

test("expiry inside the replacement transaction rolls back the complete publication", async (t) => {
  const h = await harness(t);
  await h.store.withLease(async () => {
    await h.store.writeFile(`${CLOUD_ROOT}/keep.json`, '{"keep":true}');
    const before = await h.store.backupInventory();
    await h.database.query(`CREATE FUNCTION expire_restore_test() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.path = '/wardrobe-data/expire.json' THEN
          UPDATE wardrobe_storage_lease SET expires_at = clock_timestamp() - interval '1 second' WHERE id = 1;
        END IF;
        RETURN NEW;
      END $$`);
    await h.database.query("CREATE TRIGGER expire_restore_test AFTER INSERT ON wardrobe_files FOR EACH ROW EXECUTE FUNCTION expire_restore_test()");
    await assert.rejects(h.store.replaceFromBackup([file("expire.json", "{}")]), { code: "ESTALE" });
    assert.deepEqual(await h.store.backupInventory(), before, "the failed final fence rolls back the prior DELETE too");
  });
});
