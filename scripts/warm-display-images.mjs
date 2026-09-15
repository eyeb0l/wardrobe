import { createCloudStore } from './cloud-store.mjs';
import { DISPLAY_WIDTHS } from '../shared/image-variants.mjs';
const apply = process.argv.includes('--apply');
if (process.argv.slice(2).some(arg => arg !== '--apply')) throw new Error('Usage: node scripts/warm-display-images.mjs [--apply]');
const store = createCloudStore();
const sources = await store.listDisplayImageSources();
console.log(`${sources.length} originals; WebP widths ${DISPLAY_WIDTHS.join(', ')}. Originals remain unchanged.`);
if (apply) {
  await store.initializeDisplayImages();
  let count = 0, originalBytes = 0, displayBytes = 0;
  // Small parallel batches keep the database/Blob and encoder load bounded.
  for (let offset = 0; offset < sources.length; offset += 3) {
    for (const result of await Promise.all(sources.slice(offset, offset + 3).map(source => store.warmDisplayImages(source.path)))) {
      count++;
      originalBytes += result.originalBytes;
      displayBytes += result.variants.find(v => v.width === 640).bytes;
    }
    console.log(`Prepared ${count}/${sources.length} originals.`);
  }
  console.log(JSON.stringify({ originals: count, originalBytes, displayBytesAt640: displayBytes, reductionPercent: Math.round(100 * (1 - displayBytes / originalBytes)) }));
}
