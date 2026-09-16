import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import sharp from "sharp";
import { acquireOutfitStoreLock } from "./outfit-store-lock.mjs";
import { acceptedFilename, atomicJson, publishImage, readManifest, validateManifest } from "./outfit-storage.mjs";
import * as storage from "./storage-fs.mjs";
import { skillStorage, parseSkillArgs } from "./skill-storage.mjs";

const within = (directory, file) => file === directory || file.startsWith(`${directory}${path.sep}`);
const conflict = (id) => Object.assign(new Error(`Outfit ID ${id} already exists with different metadata or image contents. Choose a new outfit ID; existing outfits were preserved.`), { status: 409 });

/** Add a reviewed, staged collection without overwriting existing records. */
export async function saveOutfitCollection({ dataDir, stagedManifestPath, store, dryRun = false }) {
  const stagedFile = await realpath(stagedManifestPath);
  const stageDir = path.dirname(stagedFile);
  const staged = validateManifest(JSON.parse(await readFile(stagedFile, "utf8")), stagedFile);
  if (!staged.outfits.length || staged.outfits.some((outfit) => outfit.status !== "accepted")) throw new Error("The staged collection must contain reviewed, accepted outfits only.");
  const save = async () => {
    const directory = await storage.realpath(dataDir);
    if (within(directory, stageDir)) throw new Error("Keep the staged manifest and images outside the configured data directory.");
    const manifestPath = path.join(directory, "outfits.json");
    const manifest = await readManifest(directory);
    const imageDir = path.join(directory, "outfit-images");
    const existing = new Map(manifest.outfits.map((outfit) => [outfit.id, outfit]));
    const currentIds = store ? new Set(JSON.parse(await storage.readFile(path.join(directory, 'library.json'), 'utf8')).filter(item => !item.hidden).map(item => item.id)) : null;
    const additions = [];
    const saved = [];
    // Validate the whole batch and every ID before publishing any images.
    for (const outfit of staged.outfits) {
      if (currentIds && outfit.garmentIds.some(id => !currentIds.has(id))) throw new Error(`Outfit ${outfit.id} refers to a garment no longer in the live wardrobe. Refresh the snapshot before saving.`);
      if (!/^outfit-images\/[a-z0-9][a-z0-9._-]*\.png$/i.test(outfit.image)) throw new Error(`Staged outfit ${outfit.id} must refer to outfit-images/FILENAME.png inside its staging directory.`);
      const source = await realpath(path.join(stageDir, outfit.image));
      if (!within(stageDir, source) || within(directory, source) || !(await lstat(source)).isFile()) throw new Error(`Staged image for ${outfit.id} is outside its staging directory or unavailable.`);
      const bytes = await readFile(source);
      const input = sharp(bytes, { limitInputPixels: 64e6 });
      if ((await input.metadata()).format !== "png") throw new Error(`Staged image for ${outfit.id} must be a PNG.`);
      await input.stats(); // Decode the complete image before it can be accepted.
      const previous = existing.get(outfit.id);
      if (previous) {
        if (Object.entries(outfit).some(([key, value]) => key !== "image" && !isDeepStrictEqual(previous[key], value))) throw conflict(outfit.id);
        const filename = acceptedFilename(previous.image);
        const previousFile = filename && path.join(imageDir, filename);
        if (!previousFile || !(await storage.lstat(previousFile)).isFile() || !bytes.equals(await storage.readFile(previousFile))) throw conflict(outfit.id);
        saved.push(previous);
      } else {
        const filename = `${outfit.id}-${createHash("sha256").update(bytes).digest("hex")}.png`;
        const record = { ...outfit, image: `/api/outfits/images/${filename}` };
        additions.push({ record, bytes, filename });
        saved.push(record);
      }
    }
    if (additions.length && !dryRun) {
      // On a brand-new store, establish the empty manifest first. If a later
      // save fails, its immutable image orphan cannot masquerade as a lost
      // manifest and prevent a safe retry.
      try { await storage.lstat(manifestPath); }
      catch (error) { if (error.code !== "ENOENT") throw error; await atomicJson(manifestPath, manifest); }
      await storage.mkdir(imageDir, { recursive: true });
      for (const { filename, bytes } of additions) await publishImage(path.join(imageDir, filename), bytes);
      await atomicJson(manifestPath, { ...staged, ...manifest, outfits: [...manifest.outfits, ...additions.map(({ record }) => record)] });
    }
    return { dryRun, added: additions.length, existing: saved.length - additions.length, total: manifest.outfits.length + additions.length, manifestPath, outfits: saved };
  };
  if (store) return storage.withStorage(store, () => dryRun ? save() : store.withLease(save));
  if (dryRun) return save();
  const release = await acquireOutfitStoreLock(dataDir);
  try { return await save(); } finally { await release(); }
}

async function main() {
  const options = parseSkillArgs(process.argv.slice(2), { positional: true });
  if (!options.stagedManifestPath) throw new Error('Usage: node scripts/save-outfit-collection.mjs STAGED_MANIFEST --target cloud|local [--data-dir PATH] [--dry-run]');
  // Preserve the existing CLI's local default; project skills always pass target.
  const selected = await skillStorage({ ...options, target: options.target || 'local' });
  const result = await saveOutfitCollection({ ...options, dataDir: selected.dataDir, store: selected.target === 'cloud' ? selected.store : undefined });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
