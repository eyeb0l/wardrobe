import { createHash, randomUUID } from 'node:crypto';
import { readFile } from './storage-fs.mjs';
import { atomicJson } from './outfit-storage.mjs';

const locks = new Map();
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const parts = new Set(['upperbody', 'dresses', 'wholebody_up', 'lowerbody', 'accessories_up', 'shoes']);
export const editableFields = ['name', 'part', 'color', 'secondaryColor', 'tags'];
const object = value => value && typeof value === 'object' && !Array.isArray(value);

export async function readLibrary(file) {
  let records;
  try { records = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  if (!Array.isArray(records) || records.some(item => !object(item) || typeof item.id !== 'string')
    || new Set(records.map(item => item.id)).size !== records.length) throw fail('The wardrobe library is invalid. Restore it before editing.', 503);
  return records;
}

// Cloud callers also hold the fenced storage lease. This queue prevents local
// import approvals and edits from replacing one another's library snapshots.
export async function withLibraryLock(file, callback) {
  const prior = locks.get(file) || Promise.resolve();
  const work = prior.catch(() => {}).then(callback);
  locks.set(file, work);
  try { return await work; } finally { if (locks.get(file) === work) locks.delete(file); }
}

export function publicLibraryItem(item) {
  const { _editVersion, hidden, ...record } = item;
  const state = editableFields.map(field => item[field] ?? null);
  record.revision = createHash('sha256').update(JSON.stringify([_editVersion ?? null, hidden === true, ...state])).digest('hex');
  return record;
}

export function validateEdit(input) {
  if (!object(input) || Object.keys(input).some(key => !editableFields.includes(key))) throw fail('Invalid wardrobe edit.');
  const edit = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === 'name') { if (typeof value !== 'string' || value.length > 200) throw fail('Name must be at most 200 characters.'); edit.name = value.trim(); }
    else if (key === 'part') { if (!parts.has(value)) throw fail('Unknown wardrobe category.'); edit.part = value; }
    else if (key === 'tags') {
      if (!Array.isArray(value) || value.length > 40 || value.some(tag => typeof tag !== 'string' || tag.length > 100)) throw fail('Invalid detail tags.');
      edit.tags = [...new Set(value.map(tag => tag.trim()).filter(Boolean))];
    } else {
      if (value !== null && (typeof value !== 'string' || !/^#[a-f0-9]{6}$/i.test(value))) throw fail('Colours must be six-digit hex values.');
      edit[key] = value;
    }
  }
  return edit;
}

function checkedItem(records, id, revision) {
  const item = records.find(item => item.id === id && !item.hidden);
  if (!item) throw fail('Wardrobe item no longer exists.', 404);
  if (typeof revision !== 'string' || revision !== publicLibraryItem(item).revision) throw fail('This item changed on another device. Close and reopen it before saving again.', 409);
  return item;
}

export function saveLibraryEdit(file, id, payload) {
  if (!object(payload)) throw fail('Invalid wardrobe edit.');
  const { revision, changes } = payload;
  const edit = validateEdit(changes);
  return withLibraryLock(file, async () => {
    const records = await readLibrary(file);
    const item = checkedItem(records, id, revision);
    const updated = { ...item, ...edit, _editVersion: randomUUID() };
    await atomicJson(file, records.map(value => value === item ? updated : value));
    return publicLibraryItem(updated);
  });
}

export function deleteLibraryItem(file, id, revision) {
  return withLibraryLock(file, async () => {
    const records = await readLibrary(file);
    const item = checkedItem(records, id, revision);
    // Items managed outside the importer remain in the manifest, but their
    // hidden state now follows the user across devices and generation inputs.
    const imported = /^import-[a-f0-9-]{36}$/i.test(id);
    // Keep a tombstone even for imports, so a delayed approval or an old
    // browser migration cannot recreate an item the user deleted.
    const next = records.map(value => value === item ? { ...item, hidden: true, _editVersion: randomUUID() } : value);
    await atomicJson(file, next);
    return { deleted: true, id, imported };
  });
}

export function migrateLibraryEdits(file, payload) {
  if (!object(payload)) throw fail('Invalid browser edits.');
  const { edits = {}, deleted = [] } = payload;
  if (!object(edits) || Object.keys(edits).length > 2000 || !Array.isArray(deleted) || deleted.length > 2000 || deleted.some(id => typeof id !== 'string')) throw fail('Invalid browser edits.');
  const validated = new Map(Object.entries(edits).map(([id, value]) => [id, validateEdit(value)]));
  const hidden = new Set(deleted);
  return withLibraryLock(file, async () => {
    const records = await readLibrary(file);
    const migrated = [], skipped = [];
    const next = records.map(item => {
      if (!validated.has(item.id) && !hidden.has(item.id)) return item;
      // Server edits always win over stale edits from another browser. Missing
      // records are never recreated, making migration safe to retry.
      if (item._editVersion) { skipped.push(item.id); return item; }
      migrated.push(item.id);
      return { ...item, ...(validated.get(item.id) || {}), hidden: hidden.has(item.id) || item.hidden === true, _editVersion: randomUUID() };
    });
    if (migrated.length) await atomicJson(file, next);
    return { migrated, skipped };
  });
}
