import { randomUUID } from "node:crypto";
import { link, lstat, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const ID = /^[a-z0-9][a-z0-9-]{0,159}$/;
const FILE = /^[a-z0-9][a-z0-9._-]*\.png$/i;
const OUTFIT_STATUSES = ["planned", "generating", "generated", "review", "accepted", "rejected", "failed"];
const JOB_STATUSES = ["planning", "generating", "review", "complete", "failed"];
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value) => typeof value === "string";
const nullableText = (value) => value === null || text(value);
const timestamp = (value) => text(value) && Number.isFinite(Date.parse(value));
const strings = (value) => Array.isArray(value) && value.every(text);
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const storageError = (file, detail) => Object.assign(new Error(`${file}: ${detail} Preserve the file and restore a valid backup or repair it before continuing.`), { status: 503 });
// Keep the sibling name short even when an immutable image name approaches
// the filesystem's per-component length limit.
const temporarySibling = (file) => path.join(path.dirname(file), `.outfit-write-${randomUUID()}.tmp`);

export async function atomicJson(file, value) {
  const temporary = temporarySibling(file);
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}

// A complete image becomes visible in one no-clobber operation. If a prior
// attempt already published it, success requires the exact same file bytes.
export async function publishImage(file, bytes) {
  const temporary = temporarySibling(file);
  try {
    await writeFile(temporary, bytes, { flag: "wx" });
    try { await link(temporary, file); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (!(await lstat(file)).isFile() || !Buffer.from(bytes).equals(await readFile(file))) throw Object.assign(new Error(`The outfit image ${path.basename(file)} already exists with different contents. Preserve it and use a new image filename.`), { status: 409 });
    }
  } finally { await rm(temporary, { force: true }); }
}

export function acceptedFilename(image) {
  if (!text(image)) return null;
  return image.match(/^(?:outfit-images\/|\/api\/outfits\/images\/|\/api\/import\/outfits\/)([a-z0-9][a-z0-9._-]*\.png)$/i)?.[1] || null;
}

function requireValue(condition, file, field) {
  if (!condition) throw storageError(file, `Invalid ${field}.`);
}

function optional(record, key, check, file, prefix) {
  if (record[key] !== undefined) requireValue(check(record[key]), file, `${prefix}.${key}`);
}

function validateOutfit(record, file, prefix, job = false) {
  requireValue(object(record), file, prefix);
  requireValue(text(record.id) && ID.test(record.id), file, `${prefix}.id`);
  requireValue(text(record.name) && Boolean(record.name.trim()), file, `${prefix}.name`);
  requireValue(strings(record.occasion), file, `${prefix}.occasion`);
  requireValue(strings(record.garmentIds) && record.garmentIds.length > 0 && record.garmentIds.every((id) => ID.test(id)) && new Set(record.garmentIds).size === record.garmentIds.length, file, `${prefix}.garmentIds`);
  requireValue(OUTFIT_STATUSES.includes(record.status) && (!job || record.status !== "generated"), file, `${prefix}.status`);
  for (const key of ["reason", "setting", "modelReferenceId"]) optional(record, key, text, file, prefix);
  for (const key of ["prompt", "error"]) optional(record, key, nullableText, file, prefix);
  for (const key of ["createdAt", "updatedAt"]) optional(record, key, timestamp, file, prefix);
  if (record.status === "accepted") requireValue(Boolean(acceptedFilename(record.image)), file, `${prefix}.image`);
  else if (record.image !== undefined && record.image !== null) {
    const candidate = job && text(record.image) && record.image.match(/^\/api\/outfits\/jobs\/([a-f0-9-]+)\/assets\/([^/]+)$/i);
    requireValue(Boolean(acceptedFilename(record.image) || (candidate && UUID.test(candidate[1]) && FILE.test(candidate[2]))), file, `${prefix}.image`);
  }
}

function uniqueOutfits(outfits, file) {
  requireValue(new Set(outfits.map((item) => item.id)).size === outfits.length, file, "duplicate outfit IDs");
}

async function hasEntries(directory) {
  try { return (await readdir(directory)).length > 0; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

// Read-only: unknown fields survive subsequent spread-based writes, and neither
// corruption nor a future schema is silently turned into an empty collection.
export async function readManifest(dataDir) {
  const file = path.join(dataDir, "outfits.json");
  let value;
  try { value = JSON.parse(await readFile(file, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") {
      let existing;
      try { existing = (await Promise.all(["outfit-images", "outfit-jobs"].map((name) => hasEntries(path.join(dataDir, name))))).some(Boolean); }
      catch { throw storageError(file, "Could not inspect the existing outfit data. Check local disk access."); }
      if (!existing) return { version: 1, outfits: [] };
      throw storageError(file, "The collection manifest is missing but outfit photos or jobs still exist.");
    }
    throw storageError(file, error instanceof SyntaxError ? "The JSON could not be parsed." : "The collection could not be read. Check local disk access.");
  }
  return validateManifest(value, file);
}

export function validateManifest(value, file = "outfits.json") {
  requireValue(object(value), file, "collection object");
  if (value.version !== 1) throw storageError(file, `Unsupported collection version ${JSON.stringify(value.version) ?? "(missing)"}. Open it with a compatible app version; do not reset it.`);
  requireValue(Array.isArray(value.outfits), file, "outfits array");
  value.outfits.forEach((record, index) => validateOutfit(record, file, `outfits[${index}]`));
  uniqueOutfits(value.outfits, file);
  return value;
}

// Legacy jobs were unversioned. Normalize only after all known fields validate;
// callers decide whether a real recovery transition needs to be persisted.
export function validateJob(value, expectedId) {
  const file = `outfit-jobs/${expectedId}/job.json`;
  requireValue(object(value), file, "job object");
  if (value.version !== undefined && value.version !== 1) throw storageError(file, `Unsupported job version ${JSON.stringify(value.version)}. Open it with a compatible app version; do not reset it.`);
  requireValue(text(value.id) && UUID.test(value.id) && value.id === expectedId, file, "job ID");
  requireValue(Number.isInteger(value.count) && value.count >= 1 && value.count <= 12, file, "count");
  requireValue(JOB_STATUSES.includes(value.status), file, "status");
  requireValue(text(value.direction), file, "direction");
  requireValue(text(value.modelReferenceId) && Boolean(value.modelReferenceId.trim()), file, "modelReferenceId");
  for (const key of ["createdAt", "updatedAt"]) requireValue(timestamp(value[key]), file, key);
  optional(value, "error", nullableText, file, "job");
  requireValue(Array.isArray(value.outfits) && value.outfits.length <= value.count, file, "outfits array/count");
  optional(value, "internal", object, file, "job");
  if (value.internal) optional(value.internal, "planningPrompt", text, file, "job.internal");
  for (const [index, outfit] of value.outfits.entries()) {
    const prefix = `outfits[${index}]`;
    validateOutfit(outfit, file, prefix, true);
    requireValue(integer(outfit.attempts), file, `${prefix}.attempts`);
    optional(outfit, "internal", object, file, prefix);
    if (!outfit.internal) continue;
    const internal = outfit.internal;
    for (const key of ["candidateFile", "previousImage"]) optional(internal, key, (name) => name === null || (text(name) && FILE.test(name)), file, `${prefix}.internal`);
    optional(internal, "outerLayerConstruction", (type) => ["none", "full-front-opening", "pullover", "closed-uncertain"].includes(type), file, `${prefix}.internal`);
    optional(internal, "outerLayerNote", text, file, `${prefix}.internal`);
    if (internal.history === undefined) continue;
    requireValue(Array.isArray(internal.history), file, `${prefix}.internal.history`);
    for (const [historyIndex, entry] of internal.history.entries()) {
      const historyPrefix = `${prefix}.internal.history[${historyIndex}]`;
      requireValue(object(entry), file, historyPrefix);
      requireValue(integer(entry.attempt) && entry.attempt > 0 && entry.attempt <= outfit.attempts, file, `${historyPrefix}.attempt`);
      requireValue(timestamp(entry.at), file, `${historyPrefix}.at`);
      for (const key of ["model", "prompt"]) requireValue(text(entry[key]), file, `${historyPrefix}.${key}`);
      optional(entry, "correction", nullableText, file, historyPrefix);
      requireValue(strings(entry.references) && entry.references.every((name) => FILE.test(name)), file, `${historyPrefix}.references`);
    }
  }
  uniqueOutfits(value.outfits, file);
  const result = structuredClone(value);
  result.version = 1;
  result.internal ||= {};
  for (const outfit of result.outfits) {
    outfit.internal ||= {};
    outfit.internal.history ||= [];
  }
  return result;
}
