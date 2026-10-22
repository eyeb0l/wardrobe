import { localDate, validWearDate } from './outfit-activity.mjs';
import { inLaundry } from './garment-availability.mjs';

// A garment worn in two logged looks on the same day was still worn on one day.
// Use the event's pieces: an edited outfit must not rewrite what was worn.
export function garmentWearHistory(outfits, today = localDate()) {
  const days = new Map();
  for (const outfit of outfits) {
    if (outfit.status !== 'accepted') continue;
    for (const event of outfit.wearHistory || []) {
      if (!validWearDate(event.date) || event.date > today) continue;
      for (const id of event.garmentIds || []) {
        if (!days.has(id)) days.set(id, new Set());
        days.get(id).add(event.date);
      }
    }
  }
  return new Map([...days].map(([id, dates]) => [id, {
    count: dates.size, lastWorn: [...dates].sort().at(-1),
  }]));
}

function combinationKey(outfit, itemsById) {
  const base = outfit.garmentIds.filter(id => ['upperbody', 'lowerbody', 'dresses'].includes(itemsById.get(id).part));
  return JSON.stringify((base.length ? base : outfit.garmentIds).slice().sort());
}

export function outfitShortlist(outfits, itemsById, { occasion = '', mode = 'recent', today = localDate(), failedImages = new Set() } = {}) {
  // Aggregate before filtering, including wears in other occasions/variations.
  const history = garmentWearHistory(outfits, today);
  const available = outfits.filter(outfit => outfit.status === 'accepted' && outfit.image && !failedImages.has(outfit.image) && outfit.garmentIds?.length
    && !outfit.garmentIds.some(id => inLaundry(itemsById.get(id)))
    && outfit.garmentIds.every(id => { const item = itemsById.get(id); return item?.image && !failedImages.has(item.image) && !item.hidden && !item.deleted; }));
  const eligible = available.filter(outfit => (!occasion || outfit.occasion?.includes(occasion)) && (mode !== 'favourites' || outfit.favourite));
  const ranked = eligible.map(outfit => {
    const pieces = [...new Set(outfit.garmentIds)].map(id => ({ id, name: itemsById.get(id).name, ...(history.get(id) || { count: 0, lastWorn: '' }) }));
    return { outfit, pieces, lastWorn: pieces.reduce((date, piece) => piece.lastWorn > date ? piece.lastWorn : date, ''),
      unknownCount: pieces.filter(piece => !piece.count).length,
      averageWearCount: pieces.reduce((sum, piece) => sum + piece.count, 0) / pieces.length };
  }).sort((a, b) => {
    // Unknown history is not evidence that something is unworn. Show it after
    // looks with dated evidence, and label partial history explicitly in the UI.
    if (!!a.lastWorn !== !!b.lastWorn) return a.lastWorn ? -1 : 1;
    return a.lastWorn.localeCompare(b.lastWorn)
      || a.unknownCount - b.unknownCount
      || a.averageWearCount - b.averageWearCount
      || Number(!!b.outfit.favourite) - Number(!!a.outfit.favourite)
      || a.outfit.name.localeCompare(b.outfit.name) || a.outfit.id.localeCompare(b.outfit.id);
  });
  const combinations = new Set();
  const choices = [];
  for (const row of ranked) {
    const key = combinationKey(row.outfit, itemsById);
    if (combinations.has(key)) continue;
    combinations.add(key);
    if (choices.length < 3) choices.push(row);
  }
  const laundryCount = outfits.filter(outfit => outfit.status === 'accepted'
    && (!occasion || outfit.occasion?.includes(occasion)) && (mode !== 'favourites' || outfit.favourite)
    && outfit.garmentIds?.some(id => inLaundry(itemsById.get(id)))).length;
  return { choices, matchingCount: eligible.length, distinctCount: combinations.size, laundryCount, unavailableCount: outfits.filter(o => o.status === 'accepted').length - available.length };
}
