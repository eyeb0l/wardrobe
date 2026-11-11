// Care label instructions follow the ISO 3758 symbol groups. Each field holds
// one option id; anything a label shows that has no option goes in notes.
export const CARE_FIELDS = [
  { key: 'wash', label: 'Washing', options: [
    ['machine-95', 'Wash at 95°C', 'wash tub with 95 or six dots'],
    ['machine-60', 'Wash at 60°C', 'wash tub with 60 or four dots'],
    ['machine-40', 'Wash at 40°C', 'wash tub with 40 or three dots, no bar'],
    ['machine-40-gentle', 'Wash at 40°C, gentle', 'wash tub with 40 or three dots and one or two bars beneath'],
    ['machine-30', 'Wash at 30°C', 'wash tub with 30 or two dots, no bar'],
    ['machine-30-gentle', 'Wash at 30°C, gentle', 'wash tub with 30 or two dots and one or two bars beneath'],
    ['hand', 'Hand wash only', 'wash tub with a hand'],
    ['no', 'Do not wash', 'crossed-out wash tub'],
  ] },
  { key: 'bleach', label: 'Bleaching', options: [
    ['any', 'Any bleach', 'plain triangle'],
    ['non-chlorine', 'Non-chlorine bleach', 'triangle with two diagonal lines'],
    ['no', 'Do not bleach', 'crossed-out triangle'],
  ] },
  { key: 'tumble', label: 'Tumble drying', options: [
    ['normal', 'Tumble dry, normal', 'square with a circle and two dots'],
    ['low', 'Tumble dry, low heat', 'square with a circle and one dot'],
    ['no', 'Do not tumble dry', 'crossed-out square with a circle'],
  ] },
  { key: 'dry', label: 'Natural drying', options: [
    ['line', 'Line dry', 'square with a curve at the top or one vertical line inside'],
    ['drip', 'Drip dry', 'square with two or three vertical lines inside'],
    ['flat', 'Dry flat', 'square with one horizontal line inside'],
  ] },
  { key: 'iron', label: 'Ironing', options: [
    ['high', 'Iron hot (200°C)', 'iron with three dots'],
    ['medium', 'Iron warm (150°C)', 'iron with two dots'],
    ['low', 'Iron cool, no steam', 'iron with one dot'],
    ['no', 'Do not iron', 'crossed-out iron'],
  ] },
  { key: 'professional', label: 'Professional cleaning', options: [
    ['dry-clean', 'Dry clean', 'circle with P or F'],
    ['wet-clean', 'Professional wet clean', 'circle with W'],
    ['no', 'Do not dry clean', 'crossed-out circle'],
  ] },
];

export const CARE_NOTES_LIMIT = 500;
const fail = message => Object.assign(new Error(message), { status: 400 });
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const fields = new Map(CARE_FIELDS.map(field => [field.key, field]));

// Returns a stored care record, or null when nothing is recorded. Older
// records have no care field; empty selections never create one.
export function normalizeCare(value) {
  if (value === null || value === undefined) return null;
  if (!object(value) || Object.keys(value).some(key => key !== 'notes' && !fields.has(key))) throw fail('Invalid care label details.');
  const care = {};
  for (const { key, label, options } of CARE_FIELDS) {
    const choice = value[key];
    if (choice === undefined || choice === null || choice === '') continue;
    if (!options.some(([id]) => id === choice)) throw fail(`Choose a listed ${label.toLowerCase()} instruction.`);
    care[key] = choice;
  }
  if (value.notes !== undefined && value.notes !== null) {
    if (typeof value.notes !== 'string' || value.notes.length > CARE_NOTES_LIMIT) throw fail(`Care notes must be at most ${CARE_NOTES_LIMIT} characters.`);
    const notes = value.notes.trim();
    if (notes) care.notes = notes;
  }
  return Object.keys(care).length ? care : null;
}

export function careLabel(key, choice) {
  return fields.get(key)?.options.find(([id]) => id === choice)?.[1] || null;
}

// One short line per recorded instruction, in label order.
export function careSummary(care) {
  if (!object(care)) return [];
  return CARE_FIELDS.map(({ key }) => careLabel(key, care[key])).filter(Boolean);
}

export const sameCare = (a, b) => JSON.stringify(normalizeCareSafe(a)) === JSON.stringify(normalizeCareSafe(b));
function normalizeCareSafe(value) {
  try { return normalizeCare(value); } catch { return value ?? null; }
}
