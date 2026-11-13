// The wardrobe and outfit lists name the current version of each image they
// mention. Remembering them by address lets every view ask for an image the
// browser can keep, without passing versions through each component.
const versions = new Map();

// A listed record is the server's word on its own images: an address it holds
// but no longer names has no current image, so its kept copy is not asked for.
// Records returned by a write carry no versions and change nothing here.
export function rememberImageVersions(records) {
  for (const record of records || []) {
    const listed = record?.imageVersions;
    if (!listed || typeof listed !== 'object') continue;
    const named = new Set();
    for (const [field, version] of Object.entries(listed)) {
      if (typeof record[field] !== 'string' || typeof version !== 'string' || !version) continue;
      versions.set(record[field], version);
      named.add(record[field]);
    }
    for (const value of Object.values(record)) {
      if (typeof value === 'string' && !named.has(value)) versions.delete(value);
    }
  }
}

export const imageVersion = (src) => versions.get(src);
