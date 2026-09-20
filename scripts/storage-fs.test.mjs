import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { containedFiles, withStorage } from "./storage-fs.mjs";

test("contained files retain realpath, regular-file and symlink containment checks locally", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wardrobe-contained-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "images");
  await fs.mkdir(directory);
  await fs.mkdir(path.join(directory, "nested"));
  await fs.writeFile(path.join(directory, "one.png"), "one");
  await fs.writeFile(path.join(root, "outside.png"), "outside");
  await fs.symlink(path.join(directory, "one.png"), path.join(directory, "inside.png"));
  await fs.symlink(path.join(root, "outside.png"), path.join(directory, "escaped.png"));
  await fs.symlink(path.join(directory, "missing.png"), path.join(directory, "broken.png"));
  await fs.symlink(path.join(directory, "loop.png"), path.join(directory, "loop.png"));
  const names = ["one.png", "inside.png", "escaped.png", "broken.png", "loop.png", "missing.png", "nested",
    "", ".", "..", "../outside.png", "/outside.png", "nested/one.png", "bad\\name.png", "bad\0.png", null, 7];
  const canonical = await fs.realpath(path.join(directory, "one.png"));
  const expected = [["one.png", canonical], ["inside.png", canonical]];
  assert.deepEqual([...await containedFiles(directory, names)], expected);
  assert.deepEqual([...await withStorage(fs, () => containedFiles(directory, names))], expected,
    "adapters without the optional bulk operation retain the safe filesystem fallback");
  await fs.rm(path.join(directory, "one.png"));
  assert.equal((await containedFiles(directory, names)).size, 0, "no stale lookup survives deletion");
  assert.equal((await containedFiles(path.join(root, "missing"), names)).size, 0);
  assert.equal((await containedFiles(path.join(root, "outside.png"), names)).size, 0);
});

test("contained files do not swallow storage failures as absent files", async () => {
  const storage = { realpath: async () => { throw Object.assign(new Error("storage unavailable"), { code: "EIO" }); } };
  await assert.rejects(withStorage(storage, () => containedFiles("/images", ["one.png"])), { code: "EIO" });
});

test("contained files omit inaccessible candidates without omitting healthy siblings", async () => {
  const storage = {
    realpath: async (file) => {
      if (file.endsWith("private.png")) throw Object.assign(new Error("not permitted"), { code: "EACCES" });
      return file;
    },
    stat: async (file) => ({ isDirectory: () => file === "/images", isFile: () => file === "/images/available.png" }),
  };
  assert.deepEqual([...await withStorage(storage, () => containedFiles("/images", ["private.png", "available.png"]))],
    [["available.png", "/images/available.png"]]);
});
