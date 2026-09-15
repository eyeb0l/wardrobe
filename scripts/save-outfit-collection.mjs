import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import sharp from "sharp";
import { acquireOutfitStoreLock } from "./outfit-store-lock.mjs";
import { acceptedFilename, atomicJson, publishImage, readManifest, validateManifest } from "./outfit-storage.mjs";

const within = (directory, file) => file === directory || file.startsWith(`${directory}${path.sep}`);
const conflict = (id) => Object.assign(new Error(`Outfit ID ${id} already exists with different metadata or image contents. Choose a new outfit ID; existing outfits were preserved.`), { status: 409 });

/** Add a reviewed, staged collection without overwriting existing records. */
export async function saveOutfitCollection({ dataDir, stagedManifestPath }) {
  const stagedFile = await realpath(stagedManifestPath);
  const stageDir = path.dirname(stagedFile);
  const staged = validateManifest(JSON.parse(await readFile(stagedFile, "utf8")), stagedFile);
  if (!staged.outfits.length || staged.outfits.some((outfit) => outfit.status !== "accepted")) throw new Error("The staged collection must contain reviewed, accepted outfits only.");
  const release = await acquireOutfitStoreLock(dataDir);
  try {
    const directory = await realpath(dataDir);
    if (within(directory, stageDir)) throw new Error("Keep the staged manifest and images outside the configured data directory.");
    const manifestPath = path.join(directory, "outfits.json");
    const manifest = await readManifest(directory);
    const imageDir = path.join(directory, "outfit-images");
    const existing = new Map(manifest.outfits.map((outfit) => [outfit.id, outfit]));
    const additions = [];
    const saved = [];
    // Validate the whole batch and every ID before publishing any images.
    for (const outfit of staged.outfits) {
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
        if (!previousFile || !(await lstat(previousFile)).isFile() || !bytes.equals(await readFile(previousFile))) throw conflict(outfit.id);
        saved.push(previous);
      } else {
        const filename = `${outfit.id}-${createHash("sha256").update(bytes).digest("hex")}.png`;
        const record = { ...outfit, image: `/api/outfits/images/${filename}` };
        additions.push({ record, bytes, filename });
        saved.push(record);
      }
    }
    if (additions.length) {
      // On a brand-new store, establish the empty manifest first. If a later
      // save fails, its immutable image orphan cannot masquerade as a lost
      // manifest and prevent a safe retry.
      try { await lstat(manifestPath); }
      catch (error) { if (error.code !== "ENOENT") throw error; await atomicJson(manifestPath, manifest); }
      await mkdir(imageDir, { recursive: true });
      for (const { filename, bytes } of additions) await publishImage(path.join(imageDir, filename), bytes);
      await atomicJson(manifestPath, { ...staged, ...manifest, outfits: [...manifest.outfits, ...additions.map(({ record }) => record)] });
    }
    return { added: additions.length, existing: saved.length - additions.length, total: manifest.outfits.length + additions.length, manifestPath, outfits: saved };
  } finally { await release(); }
}

async function main() {
  const args = process.argv.slice(2);
  const usage = "Usage: node scripts/save-outfit-collection.mjs /path/to/stage/outfits.json [--data-dir PATH]";
  if (args.length !== 1 && !(args.length === 3 && args[1] === "--data-dir")) throw new Error(usage);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const { loadEnv } = await import("vite");
  const env = loadEnv("development", root, "WARDROBE_");
  const dataDir = path.resolve(root, args[2] || process.env.WARDROBE_DATA_DIR || env.WARDROBE_DATA_DIR || "data");
  const result = await saveOutfitCollection({ dataDir, stagedManifestPath: path.resolve(args[0]) });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
