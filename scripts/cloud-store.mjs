import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

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

// This schema is applied by the explicit migration command, never by a request.
// Every mutation locks and checks the lease row inside the same database
// transaction as the metadata change. An expired worker cannot publish writes.
export const CLOUD_SCHEMA_SQL = [
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
  const rowFor = async (file) => {
    const target = canonical(file);
    const rows = await db.query("SELECT * FROM wardrobe_files WHERE path = $1", [target]);
    if (!rows[0]) throw error("ENOENT", target);
    return rows[0];
  };
  store = {
    root: CLOUD_ROOT,
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
      let text = null;
      try {
        const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
        if (!decoded.includes("\0") && !decoded.startsWith("\uFEFF")) {
          if (/\.json(?:\.|$)|\.tmp$/.test(target)) text = decoded;
          else { JSON.parse(decoded); text = decoded; }
        }
      } catch { /* Binary content is stored in private Blob. */ }
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
  // Unlink/overwrite never deletes Blob objects: links and concurrent readers may
  // still reference them. A later maintenance command can collect unreferenced
  // objects after a retention period, under the same global lease.
  return store;
}

export const initialize = (options) => createCloudStore(options).initialize();
