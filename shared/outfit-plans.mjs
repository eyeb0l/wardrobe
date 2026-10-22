import { localDate } from './outfit-activity.mjs';
import { inLaundry } from './garment-availability.mjs';

export function planningDays(now = new Date()) {
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return [localDate(now), localDate(tomorrow)];
}

export function planAvailability(outfit, itemsById) {
  if (!outfit) return { missing: ['Saved look no longer available'], laundry: [] };
  const missing = [], laundry = [];
  for (const id of outfit.garmentIds) {
    const item = itemsById.get(id);
    if (!item || item.hidden || item.deleted || !item.image) missing.push(item?.name || 'Piece no longer available');
    else if (inLaundry(item)) laundry.push(item.name);
  }
  return { missing, laundry };
}
