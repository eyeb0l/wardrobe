import { localDate, validWearDate } from './outfit-activity.mjs';
import { inLaundry } from './garment-availability.mjs';
import { weatherFit } from './outfit-weather.mjs';
import { matchesOccasion } from './outfit-occasions.mjs';

// With a forecast, suitable looks come first and clearly unsuitable ones are
// left out (and counted). Looks without weather details follow known fits.
const WEATHER_TIERS = { good: 0, fair: 1, unknown: 2 };

// A garment worn in two logged looks on the same day was still worn on one day.
// Use the event's pieces: an edited outfit must not rewrite what was worn.
export function garmentWearDates(outfits, today = localDate(), garmentWears = []) {
  const days = new Map();
  const events = [...garmentWears, ...outfits.filter(outfit => outfit.status === 'accepted').flatMap(outfit => outfit.wearHistory || [])];
  for (const event of events) {
    if (!validWearDate(event.date) || event.date > today) continue;
    for (const id of event.garmentIds || []) {
      if (!days.has(id)) days.set(id, new Set());
      days.get(id).add(event.date);
    }
  }
  return new Map([...days].map(([id, dates]) => [id, [...dates].sort().reverse()]));
}

export function garmentWearHistory(outfits, today = localDate(), garmentWears = []) {
  return new Map([...garmentWearDates(outfits, today, garmentWears)].map(([id, dates]) => [id, { count: dates.length, lastWorn: dates[0] }]));
}

function combinationKey(outfit, itemsById) {
  const base = outfit.garmentIds.filter(id => ['upperbody', 'lowerbody', 'dresses'].includes(itemsById.get(id).part));
  return JSON.stringify((base.length ? base : outfit.garmentIds).slice().sort());
}

export function readySavedLooks(outfits, itemsById, { garmentId = '', occasion = '', failedImages = new Set() } = {}) {
  return outfits.filter(outfit => outfit.status === 'accepted' && outfit.image && !failedImages.has(outfit.image) && outfit.garmentIds?.length
    && (!garmentId || outfit.garmentIds.includes(garmentId)) && matchesOccasion(outfit, occasion)
    && !outfit.garmentIds.some(id => inLaundry(itemsById.get(id)))
    && outfit.garmentIds.every(id => { const item = itemsById.get(id); return item?.image && !failedImages.has(item.image) && !item.hidden && !item.deleted; }));
}

export function outfitShortlist(outfits, itemsById, { occasion = '', mode = 'recent', today = localDate(), garmentWears = [], failedImages = new Set(), weatherDay = null } = {}) {
  // Aggregate before filtering, including wears in other occasions/variations.
  const history = garmentWearHistory(outfits, today, garmentWears);
  const available = readySavedLooks(outfits, itemsById, { failedImages });
  const matching = available.filter(outfit => matchesOccasion(outfit, occasion) && (mode !== 'favourites' || outfit.favourite));
  const fits = new Map(weatherDay ? matching.map(outfit => [outfit.id, weatherFit(outfit.weather, weatherDay)]) : []);
  const eligible = matching.filter(outfit => fits.get(outfit.id)?.level !== 'poor');
  const ranked = eligible.map(outfit => {
    const pieces = [...new Set(outfit.garmentIds)].map(id => ({ id, name: itemsById.get(id).name, ...(history.get(id) || { count: 0, lastWorn: '' }) }));
    return { outfit, pieces, weatherFit: fits.get(outfit.id) || null, lastWorn: pieces.reduce((date, piece) => piece.lastWorn > date ? piece.lastWorn : date, ''),
      unknownCount: pieces.filter(piece => !piece.count).length,
      averageWearCount: pieces.reduce((sum, piece) => sum + piece.count, 0) / pieces.length };
  }).sort((a, b) => {
    // Unknown history is not evidence that something is unworn. Show it after
    // looks with dated evidence, and label partial history explicitly in the UI.
    const weather = (WEATHER_TIERS[a.weatherFit?.level] ?? 0) - (WEATHER_TIERS[b.weatherFit?.level] ?? 0);
    if (weather) return weather;
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
    && matchesOccasion(outfit, occasion) && (mode !== 'favourites' || outfit.favourite)
    && outfit.garmentIds?.some(id => inLaundry(itemsById.get(id)))).length;
  const weatherCounts = { unsuitable: matching.length - eligible.length, unknown: [...fits.values()].filter(fit => fit.level === 'unknown').length };
  return { choices, weatherCounts, matchingCount: eligible.length, distinctCount: combinations.size, laundryCount, unavailableCount: outfits.filter(o => o.status === 'accepted').length - available.length };
}
