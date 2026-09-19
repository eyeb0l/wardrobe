// One process-local cache per storage client. Keys are immutable Blob URLs, never
// mutable wardrobe paths. Callers must authorize and resolve the path first.
export function immutableByteCache({ maxBytes = 64 * 1024 * 1024, maxEntryBytes = 8 * 1024 * 1024, maxEntries = 256 } = {}) {
  const entries = new Map(), pending = new Map();
  let usedBytes = 0;
  return async function read(key, load) {
    let bytes = entries.get(key);
    if (bytes) {
      entries.delete(key); entries.set(key, bytes);
    } else {
      let work = pending.get(key);
      if (!work) {
        work = Promise.resolve().then(load).then(value => {
          const saved = Buffer.from(value);
          if (saved.length <= maxEntryBytes && saved.length <= maxBytes && maxEntries > 0) {
            entries.set(key, saved); usedBytes += saved.length;
            while (usedBytes > maxBytes || entries.size > maxEntries) {
              const oldest = entries.keys().next().value;
              usedBytes -= entries.get(oldest).length; entries.delete(oldest);
            }
          }
          return saved;
        }).finally(() => pending.delete(key));
        pending.set(key, work);
      }
      bytes = await work;
    }
    // Image-processing callers may mutate their input. Never expose cached bytes.
    return Buffer.from(bytes);
  };
}
