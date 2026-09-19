import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { DISPLAY_WIDTHS, DISPLAY_RECIPE } from "../shared/image-variants.mjs";
import { displayKey, displayETag, encodeDisplayImage, matchesETag } from "./display-image.mjs";
import { GC_SCHEMA_SQL, collectBlobs } from "./blob-gc.mjs";

export const CLOUD_ROOT = "/wardrobe-data";
const LEASE_SECONDS = 270;
const leaseContext = new AsyncLocalStorage();
const error = (code, file, message = code) => Object.assign(new Error(`${message}: ${file}`), { code, path: file, status: code === "EBUSY" ? 409 : code === "ESTALE" ? 503 : undefined });
const canonical = (value) => {
  if (typeof value !== "string" || !path.posix.isAbsolute(value) || value.includes("\0") || value.includes("\\") || value.split("/").includes("..")) throw error("EACCES", String(value), "Cloud path is outside the wardrobe store");
  const normalized = path.posix.normalize(value).replace(/\/$/, "");
  if (normalized !== CLOUD_ROOT && !normalized.startsWith(`${CLOUD_ROOT}/`)) throw error("EACCES", value, "Cloud path is outside the wardrobe store");
  return normalized;
};

export const DISPLAY_CACHE_SCHEMA = `CREATE TABLE IF NOT EXISTS wardrobe_image_variants (
  cache_key text PRIMARY KEY,
  source_blob_url text NOT NULL,
  recipe text NOT NULL,
  width integer NOT NULL CHECK (width IN (320, 640, 1280)),
  blob_url text NOT NULL,
  size bigint NOT NULL CHECK (size > 0)
)`;

// This schema is applied by the explicit migration command, never by a request.
// Every mutation locks and checks the lease row inside the same database
// transaction as the metadata change. An expired worker cannot publish writes.
export const CLOUD_SCHEMA_SQL = [
  DISPLAY_CACHE_SCHEMA,
  `CREATE TABLE IF NOT EXISTS wardrobe_files (
    path text PRIMARY KEY,
    kind text NOT NULL CHECK (kind IN ('file', 'dir')),
    text_content text,
    blob_url text,
    size bigint NOT NULL DEFAULT 0 CHECK (size >= 0),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (path = '/wardrobe-data' OR left(path, 15) = '/wardrobe-data/'),
    CHECK ((kind = 'dir' AND text_content IS NULL AND blob_url IS NULL) OR
           (kind = 'file' AND ((text_content IS NULL) <> (blob_url IS NULL))))
  )`,
  `CREATE TABLE IF NOT EXISTS wardrobe_storage_lease (
    id integer PRIMARY KEY CHECK (id = 1),
    token uuid,
    expires_at timestamptz NOT NULL DEFAULT '-infinity'
  )`,
  `INSERT INTO wardrobe_storage_lease (id) VALUES (1) ON CONFLICT DO NOTHING`,
  `INSERT INTO wardrobe_files (path, kind) VALUES ('/wardrobe-data', 'dir') ON CONFLICT DO NOTHING`,
  `CREATE OR REPLACE FUNCTION wardrobe_fs_mutate(owner uuid, operation text, args jsonb)
  RETURNS void LANGUAGE plpgsql AS $$
  DECLARE
    lease wardrobe_storage_lease%ROWTYPE;
    source wardrobe_files%ROWTYPE;
    destination wardrobe_files%ROWTYPE;
    target text := args->>'path';
    dest text := args->>'dest';
    parent text;
    component text;
    existing text;
  BEGIN
    SELECT * INTO lease FROM wardrobe_storage_lease WHERE id = 1 FOR UPDATE;
    IF lease.token IS DISTINCT FROM owner OR owner IS NULL OR lease.expires_at <= clock_timestamp() THEN
      RAISE EXCEPTION 'ESTALE' USING ERRCODE = 'P0001';
    END IF;
    IF operation = 'assert' THEN RETURN; END IF;
    IF target IS NULL OR (target <> '/wardrobe-data' AND left(target, 15) <> '/wardrobe-data/') OR target ~ '(^|/)\\.\\.(/|$)' THEN
      RAISE EXCEPTION 'EACCES' USING ERRCODE = 'P0001';
    END IF;
    IF dest IS NOT NULL AND (left(dest, 15) <> '/wardrobe-data/' OR dest ~ '(^|/)\\.\\.(/|$)') THEN
      RAISE EXCEPTION 'EACCES' USING ERRCODE = 'P0001';
    END IF;
    SELECT * INTO source FROM wardrobe_files WHERE path = target;
    IF operation = 'mkdir' THEN
      IF source.path IS NOT NULL AND (source.kind <> 'dir' OR NOT (args->>'recursive')::boolean) THEN
        RAISE EXCEPTION 'EEXIST' USING ERRCODE = 'P0001';
      END IF;
      FOR component IN SELECT jsonb_array_elements_text(args->'ancestors') LOOP
        SELECT kind INTO existing FROM wardrobe_files WHERE path = component;
        IF existing = 'file' THEN RAISE EXCEPTION 'ENOTDIR' USING ERRCODE = 'P0001'; END IF;
        IF existing IS NULL THEN
          IF component <> target AND NOT (args->>'recursive')::boolean THEN RAISE EXCEPTION 'ENOENT' USING ERRCODE = 'P0001'; END IF;
          INSERT INTO wardrobe_files (path, kind) VALUES (component, 'dir');
        END IF;
      END LOOP;
      RETURN;
    END IF;
    IF target = '/wardrobe-data' THEN RAISE EXCEPTION 'EPERM' USING ERRCODE = 'P0001'; END IF;
    IF operation = 'write' THEN
      parent := regexp_replace(target, '/[^/]+$', '');
      SELECT kind INTO existing FROM wardrobe_files WHERE path = parent;
      IF existing IS NULL THEN RAISE EXCEPTION 'ENOENT' USING ERRCODE = 'P0001'; END IF;
      IF existing <> 'dir' THEN RAISE EXCEPTION 'ENOTDIR' USING ERRCODE = 'P0001'; END IF;
      IF source.path IS NOT NULL AND (args->>'exclusive')::boolean THEN RAISE EXCEPTION 'EEXIST' USING ERRCODE = 'P0001'; END IF;
      IF source.kind = 'dir' THEN RAISE EXCEPTION 'EISDIR' USING ERRCODE = 'P0001'; END IF;
      INSERT INTO wardrobe_files (path, kind, text_content, blob_url, size)
        VALUES (target, 'file', args->>'text', args->>'blob', (args->>'size')::bigint)
      ON CONFLICT (path) DO UPDATE SET text_content = EXCLUDED.text_content,
        blob_url = EXCLUDED.blob_url, size = EXCLUDED.size, updated_at = clock_timestamp();
      RETURN;
    END IF;
    IF source.path IS NULL THEN
      IF operation = 'rm' AND (args->>'force')::boolean THEN RETURN; END IF;
      RAISE EXCEPTION 'ENOENT' USING ERRCODE = 'P0001';
    END IF;
    IF operation = 'rm' THEN
      IF source.kind = 'dir' AND NOT (args->>'recursive')::boolean THEN RAISE EXCEPTION 'EISDIR' USING ERRCODE = 'P0001'; END IF;
      DELETE FROM wardrobe_files WHERE path = target OR left(path, length(target) + 1) = target || '/';
      RETURN;
    END IF;
    IF operation NOT IN ('rename', 'copy', 'link') THEN RAISE EXCEPTION 'EINVAL' USING ERRCODE = 'P0001'; END IF;
    IF target = dest THEN
      IF operation = 'link' OR (args->>'exclusive')::boolean THEN RAISE EXCEPTION 'EEXIST' USING ERRCODE = 'P0001'; END IF;
      RETURN;
    END IF;
    parent := regexp_replace(dest, '/[^/]+$', '');
    SELECT kind INTO existing FROM wardrobe_files WHERE path = parent;
    IF existing IS NULL THEN RAISE EXCEPTION 'ENOENT' USING ERRCODE = 'P0001'; END IF;
    IF existing <> 'dir' THEN RAISE EXCEPTION 'ENOTDIR' USING ERRCODE = 'P0001'; END IF;
    SELECT * INTO destination FROM wardrobe_files WHERE path = dest;
    IF operation IN ('link', 'copy') THEN
      IF source.kind <> 'file' THEN RAISE EXCEPTION 'EPERM' USING ERRCODE = 'P0001'; END IF;
      IF destination.path IS NOT NULL AND (operation = 'link' OR (args->>'exclusive')::boolean) THEN RAISE EXCEPTION 'EEXIST' USING ERRCODE = 'P0001'; END IF;
      IF destination.kind = 'dir' THEN RAISE EXCEPTION 'EISDIR' USING ERRCODE = 'P0001'; END IF;
      INSERT INTO wardrobe_files (path, kind, text_content, blob_url, size)
        VALUES (dest, source.kind, source.text_content, source.blob_url, source.size)
      ON CONFLICT (path) DO UPDATE SET text_content = EXCLUDED.text_content,
        blob_url = EXCLUDED.blob_url, size = EXCLUDED.size, updated_at = clock_timestamp();
      RETURN;
    END IF;
    IF source.kind = 'dir' AND left(dest, length(target) + 1) = target || '/' THEN RAISE EXCEPTION 'EINVAL' USING ERRCODE = 'P0001'; END IF;
    IF source.kind = 'dir' AND destination.kind = 'file' THEN RAISE EXCEPTION 'ENOTDIR' USING ERRCODE = 'P0001'; END IF;
    IF source.kind = 'file' AND destination.kind = 'dir' THEN RAISE EXCEPTION 'EISDIR' USING ERRCODE = 'P0001'; END IF;
    IF destination.kind = 'dir' AND EXISTS (SELECT 1 FROM wardrobe_files WHERE left(path, length(dest) + 1) = dest || '/') THEN RAISE EXCEPTION 'ENOTEMPTY' USING ERRCODE = 'P0001'; END IF;
    DELETE FROM wardrobe_files WHERE path = dest;
    UPDATE wardrobe_files SET path = dest || substring(path FROM length(target) + 1), updated_at = clock_timestamp()
      WHERE path = target OR left(path, length(target) + 1) = target || '/';
  END $$`,
  ...GC_SCHEMA_SQL,
];

function neonDatabase(databaseUrl) {
  let client;
  const get = async () => {
    if (!client) {
      if (!databaseUrl) throw new Error("DATABASE_URL is required for hosted wardrobe storage.");
      const { neon } = await import("@neondatabase/serverless");
      client = neon(databaseUrl);
    }
    return client;
  };
  return {
    async query(text, values = []) { return (await get()).query(text, values); },
    async transaction(statements) {
      const sql = await get();
      return sql.transaction(statements.map(({ text, values = [] }) => sql.query(text, values)));
    },
  };
}

// Keep byte classification identical for ordinary writes and full restore. A
// UTF-8 BOM and non-JSON text outside the existing text suffixes stay in Blob.
function storedText(target, bytes) {
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (!decoded.includes("\0") && !decoded.startsWith("\uFEFF")) {
      if (/\.json(?:\.|$)|\.tmp$/.test(target)) return decoded;
      JSON.parse(decoded);
      return decoded;
    }
  } catch { /* Binary content is stored in private Blob. */ }
  return null;
}

function fileStat(row) {
  return {
    size: Number(row.size), mtime: new Date(row.updated_at), mtimeMs: new Date(row.updated_at).getTime(),
    isFile: () => row.kind === "file", isDirectory: () => row.kind === "dir", isSymbolicLink: () => false,
  };
}

export function createCloudStore({ database, databaseUrl = process.env.DATABASE_URL, blob, heartbeatMs = 60_000 } = {}) {
  const db = database ?? neonDatabase(databaseUrl);
  const getBlob = async () => blob ?? import("@vercel/blob");
  let store;
  const owned = () => {
    const owner = leaseContext.getStore();
    if (owner?.store !== store || owner.closed || owner.lost) throw error("ESTALE", CLOUD_ROOT, "An active cloud storage lease is required");
    return owner;
  };
  const mutate = async (operation, args) => {
    const owner = owned();
    try { await db.query("SELECT wardrobe_fs_mutate($1::uuid, $2::text, $3::jsonb)", [owner.token, operation, JSON.stringify(args)]); }
    catch (failure) {
      if (/^(EACCES|EEXIST|ENOENT|ENOTDIR|EISDIR|EPERM|EINVAL|ENOTEMPTY|ESTALE)$/.test(failure.message)) throw error(failure.message, args.path ?? CLOUD_ROOT);
      throw failure;
    }
  };
  const fencedTransaction = async (statements) => {
    const owner = owned();
    const assertion = { text: "SELECT wardrobe_fs_mutate($1::uuid, 'assert', '{}'::jsonb)", values: [owner.token] };
    try {
      // The assertion locks the lease row until commit, so another owner and
      // garbage collection cannot cross this publication boundary.
      const results = await db.transaction([assertion, ...statements, assertion]);
      return results.slice(1, -1);
    } catch (failure) {
      if (failure.message === "ESTALE") throw error("ESTALE", CLOUD_ROOT);
      throw failure;
    }
  };
  const rowFor = async (file) => {
    const target = canonical(file);
    const rows = await db.query("SELECT * FROM wardrobe_files WHERE path = $1", [target]);
    if (!rows[0]) throw error("ENOENT", target);
    return rows[0];
  };
  const readBlob = async (url, file, useCache = true) => {
    const result = await (await getBlob()).get(url, { access: "private", useCache });
    if (!result || result.statusCode !== 200 || !result.stream) throw error("ENOENT", file, "Stored image is unavailable");
    return Buffer.from(await new Response(result.stream).arrayBuffer());
  };
  const imageRow = async (file, width) => {
    if (width !== undefined && !DISPLAY_WIDTHS.includes(width)) throw Object.assign(new Error("Unsupported display image size"), { status: 400 });
    const row = await rowFor(file);
    if (row.kind !== "file" || !row.blob_url) throw Object.assign(new Error("Image not found"), { status: 404 });
    return row;
  };
  const pendingVariants = new Map();
  const variantFor = async (source, width, readSource = () => readBlob(source.blob_url, source.path)) => {
    const key = displayKey(source.blob_url, width);
    if (pendingVariants.has(key)) return pendingVariants.get(key);
    const work = (async () => {
      const [cached] = await db.query("SELECT * FROM wardrobe_image_variants WHERE cache_key = $1", [key]);
      if (cached) return cached;
      // The source URL is immutable. Never re-resolve its path after the lookup:
      // a simultaneous replacement must not cache new bytes under the old key.
      const bytes = await encodeDisplayImage(await readSource(), width);
      const uploaded = await (await getBlob()).put(`wardrobe/display/${key}.webp`, bytes,
        { access: "private", contentType: "image/webp", addRandomSuffix: true, allowOverwrite: false });
      await db.query(`INSERT INTO wardrobe_image_variants (cache_key, source_blob_url, recipe, width, blob_url, size)
        VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (cache_key) DO NOTHING`,
        [key, source.blob_url, DISPLAY_RECIPE, width, uploaded.url, bytes.length]);
      const [saved] = await db.query("SELECT * FROM wardrobe_image_variants WHERE cache_key = $1", [key]);
      return saved;
    })();
    pendingVariants.set(key, work);
    try { return await work; } finally { pendingVariants.delete(key); }
  };
  store = {
    root: CLOUD_ROOT,
    async initializeGarbageCollection() { await db.transaction(GC_SCHEMA_SQL.map(text => ({ text }))); },
    async collectGarbage(options = {}) {
      return store.withLease(async () => collectBlobs({ ...options, store, db, blob: await getBlob(),
        ownerToken: () => owned().token }));
    },
    // Derivatives are immutable, independently reproducible cache entries. Their
    // insert-only writes do not take the wardrobe writer lease or change originals.
    async initializeDisplayImages() { await db.query(DISPLAY_CACHE_SCHEMA); },
    async displayImage(file, width, condition) {
      const source = await imageRow(file, width);
      const etag = displayETag(displayKey(source.blob_url, width));
      if (matchesETag(condition, etag)) return { etag, notModified: true };
      const variant = await variantFor(source, width);
      return { etag, bytes: await readBlob(variant.blob_url, file) };
    },
    async listDisplayImageSources() {
      return db.query("SELECT path, size FROM wardrobe_files WHERE kind = 'file' AND blob_url IS NOT NULL AND path ~* $1 ORDER BY path", ["\\.(png|jpe?g|webp)$"]);
    },
    async warmDisplayImages(file) {
      const source = await imageRow(file);
      let original;
      const readSource = () => original ??= readBlob(source.blob_url, file);
      const variants = [];
      for (const width of DISPLAY_WIDTHS) {
        const variant = await variantFor(source, width, readSource);
        variants.push({ width, bytes: Number(variant.size) });
      }
      return { path: file, originalBytes: Number(source.size), variants };
    },
    // These internal backup primitives intentionally require a caller-owned
    // lease. The backup CLI supplies destination checks and recovery safeguards.
    async backupInventory() {
      const [rows] = await fencedTransaction([{
        text: "SELECT path, kind, text_content, blob_url, size, updated_at FROM wardrobe_files ORDER BY path",
      }]);
      return rows;
    },
    async readBackupBlob(url) {
      const [rows] = await fencedTransaction([{
        text: "SELECT path FROM wardrobe_files WHERE kind = 'file' AND blob_url = $1 ORDER BY path LIMIT 1",
        values: [url],
      }]);
      if (!rows.length) throw error("EACCES", CLOUD_ROOT, "Backup images must be referenced by the cloud store");
      const bytes = await readBlob(url, rows[0].path, false);
      await store.assertLease();
      return bytes;
    },
    async replaceFromBackup(files) {
      owned();
      if (!Array.isArray(files)) throw error("EINVAL", CLOUD_ROOT, "Restore files must be an array");
      const paths = new Set();
      const directories = new Set();
      const staged = files.map((file) => {
        if (!file || typeof file !== "object") throw error("EINVAL", CLOUD_ROOT, "Invalid restore file");
        const target = canonical(file.path);
        if (target !== file.path || target === CLOUD_ROOT || paths.has(target)) throw error("EINVAL", target, "Restore paths must be unique canonical file paths");
        if (!(file.bytes instanceof Uint8Array)) throw error("EINVAL", target, "Restore file bytes are required");
        paths.add(target);
        for (let parent = path.posix.dirname(target); parent !== CLOUD_ROOT; parent = path.posix.dirname(parent)) directories.add(parent);
        // Own the bytes before any await so callers cannot change a staged file.
        const bytes = Buffer.from(file.bytes);
        return { path: target, bytes, text: storedText(target, bytes) };
      });
      for (const directory of directories) {
        if (paths.has(directory)) throw error("ENOTDIR", directory, "A restore file is also a parent directory");
      }
      await store.assertLease();
      const rows = [...directories].sort().map((directory) => ({ path: directory, kind: "dir", text_content: null, blob_url: null, size: 0 }));
      let uploadedBlobs = 0;
      for (const file of staged) {
        let blobUrl = null;
        if (file.text === null) {
          await store.assertLease();
          const uploaded = await (await getBlob()).put(`wardrobe/${randomUUID()}${path.posix.extname(file.path)}`, file.bytes,
            { access: "private", addRandomSuffix: true, allowOverwrite: false });
          blobUrl = uploaded.url;
          await store.assertLease();
          const verified = await readBlob(blobUrl, file.path, false);
          if (!verified.equals(file.bytes)) throw error("EIO", file.path, "Restored image verification failed");
          await store.assertLease();
          uploadedBlobs += 1;
        }
        rows.push({ path: file.path, kind: "file", text_content: file.text, blob_url: blobUrl, size: file.bytes.length });
      }
      // Upload failures and transaction rollbacks leave existing metadata intact.
      // Unpublished immutable objects are eligible for the normal GC grace period.
      await fencedTransaction([
        { text: "DELETE FROM wardrobe_files WHERE path <> $1", values: [CLOUD_ROOT] },
        {
          text: `INSERT INTO wardrobe_files (path, kind, text_content, blob_url, size)
            SELECT path, kind, text_content, blob_url, size FROM jsonb_to_recordset($1::jsonb)
              AS restored(path text, kind text, text_content text, blob_url text, size bigint)`,
          values: [JSON.stringify(rows)],
        },
      ]);
      return { files: staged.length, directories: directories.size, uploadedBlobs };
    },
    async initialize() { await db.transaction(CLOUD_SCHEMA_SQL.map((text) => ({ text }))); },
    async assertLease() { await mutate("assert", {}); },
    async withLease(callback) {
      const inherited = leaseContext.getStore();
      if (inherited?.store === store) { await store.assertLease(); return callback(); }
      const token = randomUUID();
      const acquired = await db.query(`UPDATE wardrobe_storage_lease SET token = $1::uuid,
        expires_at = clock_timestamp() + interval '${LEASE_SECONDS} seconds'
        WHERE id = 1 AND expires_at <= clock_timestamp() RETURNING token`, [token]);
      if (!acquired.length) throw error("EBUSY", CLOUD_ROOT, "Another wardrobe operation is still running");
      const owner = { store, token, lost: false, closed: false };
      let heartbeat;
      let renewing;
      const renew = () => {
        if (renewing || owner.closed) return;
        renewing = db.query(`UPDATE wardrobe_storage_lease SET expires_at = clock_timestamp() + interval '${LEASE_SECONDS} seconds'
          WHERE id = 1 AND token = $1::uuid AND expires_at > clock_timestamp() RETURNING token`, [token])
          .then((rows) => { if (!rows.length) owner.lost = true; })
          .catch(() => { owner.lost = true; })
          .finally(() => { renewing = undefined; });
      };
      try {
        heartbeat = setInterval(renew, heartbeatMs);
        heartbeat.unref?.();
        return await leaseContext.run(owner, async () => {
          const result = await callback();
          await store.assertLease();
          return result;
        });
      } finally {
        owner.closed = true;
        clearInterval(heartbeat);
        if (renewing) await renewing;
        await db.query("UPDATE wardrobe_storage_lease SET token = NULL, expires_at = '-infinity' WHERE id = 1 AND token = $1::uuid", [token]);
      }
    },
    async readFile(file, options) {
      const row = await rowFor(file);
      if (row.kind !== "file") throw error("EISDIR", file);
      let bytes;
      if (row.text_content !== null) bytes = Buffer.from(row.text_content, "utf8");
      else {
        // Only persisted SDK-returned URLs are ever read. No caller-supplied URL
        // is fetched, and every Blob operation explicitly requires private access.
        const result = await (await getBlob()).get(row.blob_url, { access: "private", useCache: false });
        if (!result || result.statusCode !== 200 || !result.stream) throw error("ENOENT", file, "Stored image is unavailable");
        bytes = Buffer.from(await new Response(result.stream).arrayBuffer());
      }
      const encoding = typeof options === "string" ? options : options?.encoding;
      return encoding ? bytes.toString(encoding) : bytes;
    },
    async writeFile(file, contents, options = {}) {
      const target = canonical(file);
      const settings = typeof options === "string" ? { encoding: options } : options;
      const flag = settings.flag ?? "w";
      if (flag !== "w" && flag !== "wx") throw error("ENOTSUP", target, "Only w and wx writes are supported");
      const bytes = typeof contents === "string" ? Buffer.from(contents, settings.encoding ?? "utf8") : Buffer.from(contents);
      const text = storedText(target, bytes);
      let blobUrl = null;
      if (text === null) {
        await store.assertLease();
        const uploaded = await (await getBlob()).put(`wardrobe/${randomUUID()}${path.posix.extname(target)}`, bytes, { access: "private", addRandomSuffix: true, allowOverwrite: false });
        blobUrl = uploaded.url;
      }
      await mutate("write", { path: target, text, blob: blobUrl, size: bytes.length, exclusive: flag === "wx" });
    },
    async mkdir(file, options = {}) {
      const target = canonical(file);
      const ancestors = [];
      let current = CLOUD_ROOT;
      for (const part of target.slice(CLOUD_ROOT.length + 1).split("/").filter(Boolean)) { current += `/${part}`; ancestors.push(current); }
      await mutate("mkdir", { path: target, ancestors, recursive: Boolean(options.recursive) });
    },
    async readdir(file, options = {}) {
      const target = canonical(file);
      if ((await rowFor(target)).kind !== "dir") throw error("ENOTDIR", target);
      const rows = await db.query(`SELECT * FROM wardrobe_files WHERE left(path, length($1) + 1) = $1 || '/'
        AND strpos(substring(path FROM length($1) + 2), '/') = 0 ORDER BY path`, [target]);
      return rows.map((row) => options.withFileTypes ? { name: path.posix.basename(row.path), ...fileStat(row) } : path.posix.basename(row.path));
    },
    async stat(file) { return fileStat(await rowFor(file)); },
    async lstat(file) { return store.stat(file); },
    async realpath(file) { await rowFor(file); return canonical(file); },
    async rename(source, destination) { await mutate("rename", { path: canonical(source), dest: canonical(destination) }); },
    async link(source, destination) { await mutate("link", { path: canonical(source), dest: canonical(destination), exclusive: true }); },
    async copyFile(source, destination, flags = 0) {
      if (flags !== 0 && flags !== 1) throw error("ENOTSUP", source);
      await mutate("copy", { path: canonical(source), dest: canonical(destination), exclusive: flags === 1 });
    },
    async rm(file, options = {}) { await mutate("rm", { path: canonical(file), recursive: Boolean(options.recursive), force: Boolean(options.force) }); },
  };
  // Unlink/overwrite only removes file references. The daily collector checks
  // every remaining reference and observes a seven-day grace period before deletion.
  return store;
}

export const initialize = (options) => createCloudStore(options).initialize();
