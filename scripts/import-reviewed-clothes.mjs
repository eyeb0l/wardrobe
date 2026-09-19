import { createHash } from 'node:crypto';
import { normalizeModeledSetting } from './modeled-photo-prompts.mjs';
import * as local from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { acquireOutfitStoreLock } from './outfit-store-lock.mjs';
import { atomicJson, publishImage } from './outfit-storage.mjs';
import { withStorage } from './storage-fs.mjs';
import { skillStorage, parseSkillArgs } from './skill-storage.mjs';

const PARTS = new Set(["upperbody", "dresses", "wholebody_up", "lowerbody", "accessories_up", "shoes"]);
const HEX = /^#[0-9a-f]{6}$/i;

function safeSlug(value) {
  if (typeof value !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) throw new Error(`Invalid slug: ${value}`);
  return value;
}

function stableUuid(hash) {
  const raw = hash.slice(0, 32).split("");
  raw[12] = "4";
  raw[16] = ((Number.parseInt(raw[16], 16) & 0x3) | 0x8).toString(16);
  const value = raw.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function normalizeItem(item) {
  const slug = safeSlug(item.slug);
  if (item.status !== "accepted") return null;
  if (!PARTS.has(item.part)) throw new Error(`${slug}: invalid part ${item.part}`);
  if (!HEX.test(item.color)) throw new Error(`${slug}: color must be a six-digit hex value`);
  if (item.secondaryColor !== null && item.secondaryColor !== undefined && !HEX.test(item.secondaryColor)) throw new Error(`${slug}: secondaryColor must be null or a six-digit hex value`);
  const tags = Array.isArray(item.tags)
    ? item.tags.filter((tag) => typeof tag === "string").map((tag) => tag.trim().toLowerCase()).filter(Boolean).slice(0, 12)
    : [];
  return {
    slug,
    file: item.file || `${slug}.png`,
    modelReferenceId: item.modelReferenceId || null,
    modeledFile: typeof item.modeledFile === "string" && item.modeledFile ? item.modeledFile : null,
    modeledSetting: item.modeledSetting == null ? null : normalizeModeledSetting(item.modeledSetting),
    name: typeof item.name === "string" && item.name.trim() ? item.name.trim().slice(0, 120) : slug.split("-").map((word) => word[0].toUpperCase() + word.slice(1)).join(" "),
    part: item.part,
    color: item.color.toLowerCase(),
    secondaryColor: item.secondaryColor?.toLowerCase() || null,
    tags,
  };
}

async function validatePng(file, slug) {
  const bytes = await readFile(file);
  const image = sharp(bytes, { limitInputPixels: 64e6 });
  const metadata = await image.metadata();
  if (metadata.format !== "png") throw new Error(`${slug}: ${path.basename(file)} is not a PNG`);
  if (!metadata.hasAlpha) throw new Error(`${slug}: PNG has no alpha channel`);
  const stats = await image.stats();
  const alpha = stats.channels[3];
  if (!alpha || alpha.min !== 0 || alpha.max === 0) throw new Error(`${slug}: PNG must contain transparent and visible pixels`);
  return { bytes, hash: createHash("sha256").update(bytes).digest("hex") };
}

async function validateModeledPng(file, slug) {
  const bytes = await readFile(file);
  const image = sharp(bytes, { limitInputPixels: 64e6 });
  const metadata = await image.metadata();
  if (metadata.format !== "png") throw new Error(`${slug}: ${path.basename(file)} is not a PNG`);
  if (!metadata.width || !metadata.height) throw new Error(`${slug}: modeled PNG has invalid dimensions`);
  await image.stats();
  return bytes;
}

async function stagedFile(directory, filename) {
  const root = await local.realpath(directory);
  if (typeof filename !== 'string' || path.basename(filename) !== filename) throw new Error('Staged image names must be plain filenames.');
  const source = await local.realpath(path.join(root, filename));
  if (path.dirname(source) !== root || !(await local.stat(source)).isFile()) throw new Error('Staged image must remain inside its input directory.');
  return source;
}

export async function importReviewedClothes({ items, modeled, manifest, selected, dryRun = false }) {
  if (!items || !manifest) throw new Error('--items and --manifest are required');
  const input = JSON.parse(await readFile(path.resolve(manifest), 'utf8'));
  if (!Array.isArray(input?.items)) throw new Error('Manifest must contain an items array');
  const accepted = input.items.map(normalizeItem).filter(Boolean);
  if (!accepted.length) throw new Error('Manifest contains no accepted items');
  const prepared = [];
  for (const item of accepted) {
    const { bytes, hash } = await validatePng(await stagedFile(items, item.file), item.slug);
    const uuid = stableUuid(hash), id = `import-${uuid}`;
    let modeledBytes, modeledAssetName;
    if (item.modeledFile) {
      if (!modeled) throw new Error(`${item.slug}: --modeled is required`);
      modeledBytes = await validateModeledPng(await stagedFile(modeled, item.modeledFile), item.slug);
      modeledAssetName = `${id}-modeled-${createHash('sha256').update(modeledBytes).digest('hex')}.png`;
    }
    if (item.modelReferenceId && !/^(default|model-reference-(?:[2-9]|[1-9]\d+))$/.test(item.modelReferenceId)) throw new Error(`${item.slug}: invalid modelReferenceId`);
    prepared.push({ ...item, bytes, uuid, id, assetName: `${id}-garment.png`, modeledBytes, modeledAssetName });
  }
  if (new Set(prepared.map(item => item.id)).size !== prepared.length) throw new Error('The batch contains duplicate cutouts; reconcile the manifest first.');
  const { target, dataDir, store } = selected;
  const library = path.join(dataDir, 'library.json'), imported = path.join(dataDir, 'imported');
  const publish = async (file, bytes) => {
    let existing;
    try { existing = await store.readFile(file); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing) {
      if (!Buffer.from(existing).equals(bytes)) throw new Error(`Stored image conflicts with ${path.basename(file)}; originals were preserved.`);
      return;
    }
    await publishImage(file, bytes);
  };
  const save = () => withStorage(store, async () => {
    let records;
    try { records = JSON.parse(await store.readFile(library, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT' && target === 'local') records = []; else throw error; }
    if (!Array.isArray(records)) throw new Error('The saved library must be an array; preserve and repair it before importing.');
    const next = [...records];
    // Re-read the latest library under the target's writer lock. Never publish
    // the snapshot used for curation over changes made during generation.
    for (const item of prepared) {
      const index = next.findIndex(record => record.id === item.id);
      const existing = index >= 0 ? next[index] : {};
      const referenceId = item.modelReferenceId || existing.modelReferenceId || 'default';
      if (target === 'cloud' && item.modeledBytes) await store.stat(path.join(dataDir, referenceId === 'default' ? 'model-reference.png' : `${referenceId}.png`));
      const image = `/api/import/library/${item.assetName}`;
      const record = { ...existing, id: item.id, name: item.name, part: item.part, color: item.color,
        secondaryColor: item.secondaryColor, palette: [item.color, item.secondaryColor].filter(Boolean), tags: item.tags,
        image, thumbnail: image, modeledImage: item.modeledAssetName ? `/api/import/library/${item.modeledAssetName}` : existing.modeledImage || null,
        importJobId: existing.importJobId || item.uuid,
        ...(item.modeledBytes ? { modelReferenceId: referenceId, modeledSetting: item.modeledSetting || null } : {}) };
      if (index < 0) next.push(record); else next[index] = record;
    }
    if (!dryRun) {
      await store.mkdir(imported, { recursive: true });
      for (const item of prepared) {
        await publish(path.join(imported, item.assetName), item.bytes);
        if (item.modeledBytes) await publish(path.join(imported, item.modeledAssetName), item.modeledBytes);
      }
      await atomicJson(library, next);
    }
    return { target, dryRun, imported: prepared.length, total: next.length, library,
      items: prepared.map(({ id, name, part, assetName, modeledAssetName }) => ({ id, name, part, assetName, modeledAssetName })) };
  });
  if (dryRun) return save();
  if (target === 'cloud') return store.withLease(save);
  const release = await acquireOutfitStoreLock(dataDir);
  try { return await save(); } finally { await release(); }
}

export async function importClothesMain(args = process.argv.slice(2)) {
  const options = parseSkillArgs(args);
  const selected = await skillStorage(options);
  console.log(JSON.stringify(await importReviewedClothes({ ...options, selected }), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  importClothesMain().catch(error => { console.error(error.message); process.exitCode = 1; });
}
