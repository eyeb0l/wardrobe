import sharp from 'sharp';
import { readFile } from './storage-fs.mjs';
import { mapLimit } from './map-limit.mjs';

// Save a plain contact layout of the exact cutouts, never the original look's
// modelled photo. The immutable PNG also works with existing backups and caches.
export async function outfitCutoutPreview(items) {
  const columns = items.length === 1 ? 1 : items.length > 4 ? 3 : 2;
  const rows = Math.ceil(items.length / columns);
  const gap = 24;
  const width = Math.floor((1024 - gap * (columns + 1)) / columns);
  const height = Math.floor((1024 - gap * (rows + 1)) / rows);
  const layers = await mapLimit(items, 2, async (item, index) => ({
    input: await sharp(await readFile(item.file), { limitInputPixels: 64e6 }).rotate()
      .resize(width, height, { fit: 'contain', background: '#f4f0e8' }).png().toBuffer(),
    left: gap + (index % columns) * (width + gap),
    top: gap + Math.floor(index / columns) * (height + gap),
  }));
  return sharp({ create: { width: 1024, height: 1024, channels: 4, background: '#f4f0e8' } }).composite(layers).png().toBuffer();
}
