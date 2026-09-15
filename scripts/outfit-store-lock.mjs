import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const unavailable = (message) => Object.assign(new Error(message), { status: 503 });

async function exists(file) {
  try { await lstat(file); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

async function readOwner(file) {
  try {
    if (!(await lstat(file)).isFile()) throw new Error("not a regular file");
    const owner = JSON.parse(await readFile(file, "utf8"));
    if (owner.version !== 1 || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 ||
        typeof owner.hostname !== "string" || typeof owner.token !== "string" ||
        !/^[a-f0-9-]{36}$/.test(owner.token)) throw new Error("invalid ownership record");
    return owner;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw unavailable(`Cannot verify outfit writer ownership at ${file}. Stop all Wardrobe servers and inspect this lock before moving it aside. ${error.message}`);
  }
}

function isDead(owner, file) {
  if (owner.hostname !== os.hostname()) throw unavailable(`Outfit data is locked by another host (${owner.hostname}) at ${file}. Stop its writer before using this data directory.`);
  try { process.kill(owner.pid, 0); return false; }
  catch (error) {
    if (error.code === "ESRCH") return true;
    if (error.code === "EPERM") return false;
    throw unavailable(`Cannot verify outfit writer PID ${owner.pid} at ${file}: ${error.message}`);
  }
}

/** One outfit writer per canonical data directory, including standalone saves. */
export async function acquireOutfitStoreLock(dataDir) {
  await mkdir(dataDir, { recursive: true });
  const directory = await realpath(dataDir);
  const file = path.join(directory, ".outfit-store.lock");
  const recovery = path.join(directory, ".outfit-store.recovery");
  const token = randomUUID();
  const temporary = path.join(directory, `.outfit-store-owner-${token}.tmp`);
  const owner = { version: 1, pid: process.pid, hostname: os.hostname(), token, createdAt: new Date().toISOString() };
  const recoveryError = () => unavailable(`Outfit lock recovery is already in progress at ${recovery}. If it was interrupted, stop all Wardrobe servers and inspect/remove that recovery directory before retrying.`);
  const busy = (current) => unavailable(`Another Wardrobe outfit writer (PID ${current.pid}) owns ${directory}. Stop that server before starting another server or saving a Codex collection.`);
  const publish = () => link(temporary, file);
  let recoveryHeld = false;
  try {
    // Publish a complete record in one operation; a crash never leaves half JSON
    // at the lock path. A leftover uniquely named temporary is harmless.
    await writeFile(temporary, `${JSON.stringify(owner)}\n`, { flag: "wx", mode: 0o600 });
    if (await exists(recovery)) throw recoveryError();
    try { await publish(); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      const current = await readOwner(file);
      if (current && !isDead(current, file)) throw busy(current);
      // Serialize removal of a provably dead owner. Deliberately do not
      // auto-remove this guard: recursively recovering a recovery lock permits
      // competing processes to unlink a newly acquired owner's lock.
      try { await mkdir(recovery); recoveryHeld = true; }
      catch (guardError) { if (guardError.code === "EEXIST") throw recoveryError(); throw guardError; }
      await writeFile(path.join(recovery, "owner.json"), `${JSON.stringify(owner)}\n`, { flag: "wx", mode: 0o600 });
      const latest = await readOwner(file);
      if (latest) {
        if (!isDead(latest, file)) throw busy(latest);
        await rm(file);
      }
      try { await publish(); }
      catch (publishError) {
        if (publishError.code !== "EEXIST") throw publishError;
        const winner = await readOwner(file);
        throw winner ? busy(winner) : unavailable(`Outfit writer ownership changed at ${file}; retry after other writers stop.`);
      }
    }
  } finally {
    await rm(temporary, { force: true });
    if (recoveryHeld) await rm(recovery, { recursive: true });
  }
  let released = false;
  return async function release() {
    if (released) return;
    const current = await readOwner(file);
    if (current?.token === token && current.pid === process.pid) await rm(file);
    released = true;
  };
}
