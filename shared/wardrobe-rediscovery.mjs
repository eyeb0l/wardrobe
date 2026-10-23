import { garmentWearHistory } from './outfit-shortlist.mjs';
import { inLaundry } from './garment-availability.mjs';

export function wardrobeRediscovery(items, outfits, { today, failedImages = new Set() } = {}) {
  const history = garmentWearHistory(outfits, today);
  return items.filter(item => item.image && !failedImages.has(item.image) && !item.hidden && !item.deleted && !inLaundry(item))
    .map(item => ({ item, ...(history.get(item.id) || { count: 0, lastWorn: '' }) }))
    .sort((a, b) => Number(!a.lastWorn) - Number(!b.lastWorn)
      || a.lastWorn.localeCompare(b.lastWorn) || a.count - b.count
      || (a.item.name || '').localeCompare(b.item.name || '') || a.item.id.localeCompare(b.item.id));
}
