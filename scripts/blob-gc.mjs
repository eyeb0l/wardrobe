export const GC_RETENTION_DAYS = 7;

export const GC_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS wardrobe_blob_gc (
    blob_url text PRIMARY KEY,
    size bigint NOT NULL CHECK (size >= 0),
    first_unreferenced_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'deleting', 'deleted')),
    deleted_at timestamptz
  )`,
  // Publish and collect use the same row lock even for derivative writes, which
  // normally do not acquire the logical writer lease. Durable deletion markers
  // fence delayed writers after the collector has lost or released its lease.
  `CREATE OR REPLACE FUNCTION wardrobe_blob_publish_guard() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    PERFORM id FROM wardrobe_storage_lease WHERE id = 1 FOR SHARE;
    IF EXISTS (SELECT 1 FROM wardrobe_blob_gc WHERE blob_url = NEW.blob_url AND state <> 'pending') THEN
      RAISE EXCEPTION 'Cannot publish a retired Blob';
    END IF;
    IF TG_TABLE_NAME = 'wardrobe_image_variants' THEN
      IF EXISTS (SELECT 1 FROM wardrobe_blob_gc WHERE blob_url = NEW.source_blob_url AND state <> 'pending') THEN
        RAISE EXCEPTION 'Cannot publish a variant of a retired Blob';
      END IF;
      IF EXISTS (SELECT 1 FROM wardrobe_files WHERE blob_url = NEW.source_blob_url) THEN
        DELETE FROM wardrobe_blob_gc WHERE blob_url = NEW.blob_url AND state = 'pending';
      END IF;
    ELSE
      DELETE FROM wardrobe_blob_gc g WHERE state = 'pending' AND (g.blob_url = NEW.blob_url OR
        g.blob_url IN (SELECT v.blob_url FROM wardrobe_image_variants v WHERE v.source_blob_url = NEW.blob_url));
    END IF;
    RETURN NEW;
  END $$`,
  `DROP TRIGGER IF EXISTS wardrobe_file_blob_guard ON wardrobe_files`,
  `CREATE TRIGGER wardrobe_file_blob_guard BEFORE INSERT OR UPDATE OF blob_url ON wardrobe_files
    FOR EACH ROW WHEN (NEW.blob_url IS NOT NULL) EXECUTE FUNCTION wardrobe_blob_publish_guard()`,
  `DROP TRIGGER IF EXISTS wardrobe_variant_blob_guard ON wardrobe_image_variants`,
  `CREATE TRIGGER wardrobe_variant_blob_guard BEFORE INSERT OR UPDATE ON wardrobe_image_variants
    FOR EACH ROW EXECUTE FUNCTION wardrobe_blob_publish_guard()`,
  `CREATE OR REPLACE FUNCTION wardrobe_gc_candidate(owner uuid, target text, bytes bigint, action text)
    RETURNS boolean LANGUAGE plpgsql AS $$
  DECLARE lease wardrobe_storage_lease%ROWTYPE; live boolean; claimed text;
  BEGIN
    SELECT * INTO lease FROM wardrobe_storage_lease WHERE id = 1 FOR UPDATE;
    IF owner IS NULL OR lease.token IS DISTINCT FROM owner OR lease.expires_at <= clock_timestamp() THEN
      RAISE EXCEPTION 'ESTALE';
    END IF;
    SELECT EXISTS (SELECT 1 FROM wardrobe_files WHERE blob_url = target)
      OR EXISTS (SELECT 1 FROM wardrobe_image_variants v JOIN wardrobe_files f ON f.blob_url = v.source_blob_url WHERE v.blob_url = target)
      INTO live;
    IF live THEN
      DELETE FROM wardrobe_blob_gc WHERE blob_url = target AND state = 'pending';
      RETURN false;
    END IF;
    IF action = 'observe' THEN
      INSERT INTO wardrobe_blob_gc (blob_url, size) VALUES (target, bytes) ON CONFLICT DO NOTHING;
      RETURN false;
    ELSIF action = 'claim' THEN
      UPDATE wardrobe_blob_gc SET state = 'deleting' WHERE blob_url = target
        AND (state = 'deleting' OR (state = 'pending' AND first_unreferenced_at <= clock_timestamp() - interval '7 days'))
        RETURNING blob_url INTO claimed;
      IF claimed IS NULL THEN RETURN false; END IF;
      DELETE FROM wardrobe_image_variants WHERE blob_url = target;
      RETURN true;
    ELSIF action = 'finish' THEN
      UPDATE wardrobe_blob_gc SET state = 'deleted', deleted_at = clock_timestamp() WHERE blob_url = target AND state = 'deleting';
      RETURN true;
    END IF;
    RAISE EXCEPTION 'Unknown collection action';
  END $$`,
];

// Only our own immutable uploads are eligible. Never collect arbitrary objects
// from a shared store or act on a URL supplied by a request.
export function managedBlob(blob) {
  return typeof blob?.url === 'string' && typeof blob.pathname === 'string'
    && /^wardrobe\/(?:[a-f0-9-]{36}[^/]*|display\/[a-f0-9]{64}[^/]*\.webp)$/i.test(blob.pathname)
    && Number.isSafeInteger(blob.size) && blob.size >= 0;
}

export async function collectBlobs({ store, db, blob, ownerToken, dryRun = false, maxDurationMs = 120_000 }) {
  const started = Date.now();
  const statePath = `${store.root}/.blob-gc-state.json`;
  let previous = {};
  try { previous = JSON.parse(await store.readFile(statePath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  let cursor = previous.cursor || undefined;
  const result = { dryRun, retentionDays: GC_RETENTION_DAYS, scanned: 0, unreferenced: 0, deleted: 0, deletedBytes: 0, errors: 0 };
  // Persist the cursor after every page; larger stores make progress across days.
  for (let page = 0; page < 10 && Date.now() - started < maxDurationMs / 2; page++) {
    await store.assertLease();
    const listed = await blob.list({ prefix: 'wardrobe/', limit: 500, ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(listed.blobs) || (listed.hasMore && (!listed.cursor || listed.cursor === cursor))) throw new Error('Invalid Blob listing; collection stopped.');
    const objects = listed.blobs.filter(managedBlob);
    result.scanned += objects.length;
    if (dryRun) {
      const orphaned = await db.query(`SELECT x.url FROM jsonb_to_recordset($1::jsonb) AS x(url text)
        WHERE NOT EXISTS (SELECT 1 FROM wardrobe_files f WHERE f.blob_url = x.url)
        AND NOT EXISTS (SELECT 1 FROM wardrobe_image_variants v JOIN wardrobe_files f ON f.blob_url = v.source_blob_url WHERE v.blob_url = x.url)`, [JSON.stringify(objects)]);
      result.unreferenced += orphaned.length;
    } else {
      await db.query(`SELECT wardrobe_gc_candidate($1::uuid, x.url, x.size, 'observe') FROM jsonb_to_recordset($2::jsonb) AS x(url text, size bigint)`, [ownerToken(), JSON.stringify(objects)]);
    }
    cursor = listed.hasMore ? listed.cursor : undefined;
    if (!dryRun) await store.writeFile(statePath, JSON.stringify({ cursor: cursor || null, lastStartedAt: new Date(started).toISOString() }));
    if (!cursor) break;
  }
  if (!dryRun) {
    const candidates = await db.query(`SELECT blob_url, size FROM wardrobe_blob_gc WHERE state = 'deleting'
      OR (state = 'pending' AND first_unreferenced_at <= clock_timestamp() - interval '7 days') ORDER BY first_unreferenced_at LIMIT 100`);
    for (const candidate of candidates) {
      if (Date.now() - started >= maxDurationMs) break;
      const [claimed] = await db.query("SELECT wardrobe_gc_candidate($1::uuid, $2, $3, 'claim') AS claimed", [ownerToken(), candidate.blob_url, candidate.size]);
      if (!claimed?.claimed) continue;
      await store.assertLease();
      try { await blob.del(candidate.blob_url); }
      catch { result.errors++; continue; } // Keep the deletion marker for retry.
      await db.query("SELECT wardrobe_gc_candidate($1::uuid, $2, $3, 'finish')", [ownerToken(), candidate.blob_url, candidate.size]);
      result.deleted++; result.deletedBytes += Number(candidate.size);
    }
    const [counts] = await db.query("SELECT count(*)::int AS pending FROM wardrobe_blob_gc WHERE state <> 'deleted'");
    result.pending = counts.pending;
    await store.writeFile(statePath, JSON.stringify({ cursor: cursor || null, lastCompletedAt: new Date().toISOString(), result }));
  }
  return result;
}
