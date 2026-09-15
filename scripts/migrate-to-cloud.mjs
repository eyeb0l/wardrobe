import { readFile, readdir, lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createCloudStore, CLOUD_ROOT } from "./cloud-store.mjs";

const ROOT_FILES = new Set(["library.json", "outfits.json", "outfit-accessories.json", "outfit-prompts.json"]);
const DIRECTORIES = new Set(["imported", "jobs", "outfit-images", "outfit-jobs"]);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function snapshotWardrobe(source) {
  const files = [];
  async function walk(directory, relative = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (!relative && !ROOT_FILES.has(name) && !DIRECTORIES.has(name) && !/^model-reference(?:-[1-9]\d*)?\.png$/.test(name)) continue;
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Refusing symbolic link: ${name}`);
      if (entry.isDirectory()) await walk(file, name);
      else if (entry.isFile()) {
        const bytes = await readFile(file);
        files.push({ name, file, bytes, sha256: digest(bytes) });
      }
    }
  }
  await walk(source);
  for (const file of files) {
    if (!(await lstat(file.file)).isFile() || digest(await readFile(file.file)) !== file.sha256) throw new Error(`Local data changed during the snapshot: ${file.name}. Retry once generation is idle.`);
  }
  if (!files.some((file) => file.name === "library.json")) throw new Error("Missing local library.json; refusing to publish an empty wardrobe.");
  // Copy existing jobs only when settled. Migration never restarts paid work.
  for (const file of files.filter((file) => /^(?:jobs|outfit-jobs)\/.+\/job\.json$/.test(file.name))) {
    const job = JSON.parse(file.bytes);
    if (["planning", "generating"].includes(job.status) || Object.values(job.stages || {}).some((stage) => ["processing", "queued"].includes(stage.status))) {
      throw new Error(`Generation is active in ${file.name}. Finish or cancel it before copying the wardrobe.`);
    }
  }
  return files;
}

export async function migrate(source, { store = createCloudStore(), apply = false, log = console.log } = {}) {
  const files = await snapshotWardrobe(path.resolve(source));
  const summary = { files: files.length, bytes: files.reduce((sum, file) => sum + file.bytes.length, 0) };
  log(`${summary.files} files, ${(summary.bytes / 1024 / 1024).toFixed(1)} MiB. Originals remain unchanged.`);
  if (!apply) return summary;
  await store.initialize();
  return store.withLease(async () => {
    for (const directory of DIRECTORIES) await store.mkdir(`${CLOUD_ROOT}/${directory}`, { recursive: true });
    await store.mkdir(`${CLOUD_ROOT}/.tasks`, { recursive: true });
    let uploaded = 0;
    let skipped = 0;
    for (const file of files) {
      const target = `${CLOUD_ROOT}/${file.name}`;
      let existing;
      try { existing = await store.readFile(target); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (existing) {
        if (digest(existing) !== file.sha256) throw new Error(`Cloud file differs: ${file.name}. Nothing will overwrite it automatically.`);
        skipped += 1;
        continue;
      }
      await store.mkdir(path.posix.dirname(target), { recursive: true });
      await store.writeFile(target, file.bytes, { flag: "wx" });
      if (digest(await store.readFile(target)) !== file.sha256) throw new Error(`Verification failed: ${file.name}`);
      uploaded += 1;
      if (uploaded % 10 === 0) log(`Copied and verified ${uploaded} files.`);
    }
    log(`Finished: ${uploaded} copied, ${skipped} already identical. Every file verified.`);
    return { ...summary, uploaded, skipped };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg.startsWith("--") && arg !== "--apply")) throw new Error("Usage: node scripts/migrate-to-cloud.mjs [data-directory] [--apply]");
  await migrate(args.find((arg) => !arg.startsWith("--")) || "data", { apply: args.includes("--apply") });
}
