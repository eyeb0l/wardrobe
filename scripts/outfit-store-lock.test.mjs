import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { acquireOutfitStoreLock } from "./outfit-store-lock.mjs";

const moduleUrl = new URL("./outfit-store-lock.mjs", import.meta.url).href;
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wardrobe-outfit-lock-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function startWriter(t, directory) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { acquireOutfitStoreLock } from ${JSON.stringify(moduleUrl)};
    try {
      const release = await acquireOutfitStoreLock(process.argv[1]);
      process.send({ acquired: true, pid: process.pid });
      process.once("message", async () => { await release(); process.disconnect(); });
    } catch (error) { process.send({ acquired: false, error: error.message, status: error.status }); process.disconnect(); }
  `, directory], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const result = once(child, "message").then(([message]) => message);
  const exited = once(child, "exit");
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited; });
  return { child, result, exited };
}

test("separate processes cannot own the same canonical outfit store", async (t) => {
  const directory = await fixture(t);
  const alias = `${directory}-alias`;
  await symlink(directory, alias);
  t.after(() => rm(alias, { force: true }));
  const first = startWriter(t, directory);
  assert.equal((await first.result).acquired, true);
  const second = startWriter(t, alias);
  const rejected = await second.result;
  assert.equal(rejected.acquired, false);
  assert.equal(rejected.status, 503);
  assert.match(rejected.error, /Stop that server/);
  first.child.send("release");
  await first.exited;
  const release = await acquireOutfitStoreLock(alias);
  await release();
});

test("only one process wins recovery of a killed writer", async (t) => {
  const directory = await fixture(t);
  const stale = startWriter(t, directory);
  assert.equal((await stale.result).acquired, true);
  stale.child.kill("SIGKILL");
  await stale.exited;
  const contenders = [startWriter(t, directory), startWriter(t, directory)];
  const results = await Promise.all(contenders.map((writer) => writer.result));
  assert.equal(results.filter((result) => result.acquired).length, 1);
  assert.equal(results.find((result) => !result.acquired).status, 503);
  const winner = contenders[results.findIndex((result) => result.acquired)];
  assert.equal(JSON.parse(await readFile(path.join(directory, ".outfit-store.lock"), "utf8")).pid, results.find((result) => result.acquired).pid);
  winner.child.send("release");
  await winner.exited;
  const release = await acquireOutfitStoreLock(directory);
  await release();
});

test("an old release cannot unlink a replacement owner's lock", async (t) => {
  const directory = await fixture(t);
  const releaseFirst = await acquireOutfitStoreLock(directory);
  await releaseFirst();
  const second = startWriter(t, directory);
  const owner = await second.result;
  assert.equal(owner.acquired, true);
  await releaseFirst();
  assert.equal(JSON.parse(await readFile(path.join(directory, ".outfit-store.lock"), "utf8")).pid, owner.pid);
  second.child.send("release");
  await second.exited;
});

test("release checks its token before removing an ownership record", async (t) => {
  const directory = await fixture(t);
  const release = await acquireOutfitStoreLock(directory);
  const file = path.join(directory, ".outfit-store.lock");
  const replacement = { ...JSON.parse(await readFile(file, "utf8")), token: "00000000-0000-0000-0000-000000000000" };
  await writeFile(file, JSON.stringify(replacement));
  await release();
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), replacement);
});

test("damaged, foreign, and ambiguous recovery locks fail closed", async (t) => {
  const directory = await fixture(t);
  const file = path.join(directory, ".outfit-store.lock");
  await writeFile(file, "{");
  await assert.rejects(acquireOutfitStoreLock(directory), { status: 503 });
  assert.equal(await readFile(file, "utf8"), "{");
  await writeFile(file, JSON.stringify({ version: 1, pid: process.pid, hostname: "another-host", token: "00000000-0000-0000-0000-000000000000" }));
  await assert.rejects(acquireOutfitStoreLock(directory), /another host/);
  await rm(file);
  await mkdir(path.join(directory, ".outfit-store.recovery"));
  await assert.rejects(acquireOutfitStoreLock(directory), /inspect\/remove/);
});
