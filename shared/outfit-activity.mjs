// Calendar dates stay in the wearer's local day, independent of UTC timestamps.
export function localDate(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function validWearDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1900-01-01') return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function wearSummary(outfit) {
  const history = outfit.wearHistory || [];
  return { count: history.length, lastWorn: history.reduce((latest, event) => event.date > latest ? event.date : latest, '') };
}

export function formatWearDate(value) {
  return new Date(`${value}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
