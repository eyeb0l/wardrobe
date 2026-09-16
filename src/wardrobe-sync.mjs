export const EDITS_KEY = 'open-wardrobe-edits-v1';
export const DELETED_KEY = 'open-wardrobe-deleted-v1';
const BACKUP_KEY = 'open-wardrobe-legacy-backup-v1';

export async function wardrobeRequest(url, options) {
  const response = await fetch(url, { cache: 'no-store', ...options });
  let value;
  try { value = await response.json(); } catch { throw new Error('Could not reach the wardrobe. Check your connection and sign-in.'); }
  if (!response.ok) throw Object.assign(new Error(value.error || 'Could not update the wardrobe.'), { status: response.status });
  return value;
}

export async function migrateBrowserEdits(storage, request = wardrobeRequest) {
  let editsRaw, deletedRaw;
  try { editsRaw = storage.getItem(EDITS_KEY); deletedRaw = storage.getItem(DELETED_KEY); }
  catch { return ''; } // Browsers may disable storage; shared edits still work.
  if (!editsRaw && !deletedRaw) return '';
  let edits, deleted;
  try { edits = JSON.parse(editsRaw || '{}'); deleted = JSON.parse(deletedRaw || '[]'); }
  catch { throw new Error('Older browser edits could not be read. They have been kept in this browser.'); }
  const result = await request('/api/import/wardrobe/migrate-edits', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ edits, deleted }),
  });
  // Clear only the exact snapshot acknowledged by the server. Keep a local
  // backup; another old tab may still be writing these legacy keys.
  try {
    storage.setItem(BACKUP_KEY, JSON.stringify({ edits, deleted }));
    if (storage.getItem(EDITS_KEY) === editsRaw) storage.removeItem(EDITS_KEY);
    if (storage.getItem(DELETED_KEY) === deletedRaw) storage.removeItem(DELETED_KEY);
  } catch { /* Retrying is safe: migrated records cannot overwrite server edits. */ }
  return result.skipped?.length ? 'Older edits from this browser were kept as a backup. Newer shared edits were retained.' : '';
}
