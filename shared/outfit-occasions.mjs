// Saved looks keep whatever occasion tags they were given. Those tags are free
// text from curation and hand-typed looks, so filters group them when read and
// never rewrite stored records. Rules run in order, so "smart-casual" is smart
// casual, "casual-dinner" is an evening and "office-lunch" is work.
const OCCASION_GROUPS = [
  { value: 'work', label: 'Work', words: ['work', 'workday', 'workwear', 'office', 'business', 'meeting', 'interview', 'commute', 'professional'] },
  { value: 'evening', label: 'Evening out', words: ['evening', 'night', 'date', 'dinner', 'dressy', 'party', 'cocktail', 'drinks', 'formal', 'theatre'] },
  { value: 'smart-casual', label: 'Smart casual', words: ['smart', 'polished', 'nicer', 'elevated', 'lunch', 'brunch'] },
  { value: 'casual', label: 'Casual', words: ['casual', 'everyday', 'daily', 'relaxed', 'weekend', 'city', 'errands', 'coffee', 'stroll'] },
];
const DISPLAY_ORDER = ['casual', 'smart-casual', 'work', 'evening'];

// Season, weather and styling notes describe a look but are not somewhere to
// wear it. Weather has its own control. "Day" alone says nothing about formality.
const DESCRIPTOR_WORDS = new Set(['spring', 'summer', 'autumn', 'fall', 'winter', 'season', 'seasonal', 'transitional', 'cool', 'cold', 'warm', 'hot', 'mild', 'rain', 'rainy', 'weather', 'day', 'daytime', 'dark', 'light', 'tonal', 'monochrome', 'neutral', 'layered', 'layers', 'layering', 'statement', 'and']);

const words = tag => String(tag ?? '').toLowerCase().match(/[a-z0-9]+/g) || [];
const labelOf = value => {
  const group = OCCASION_GROUPS.find(candidate => candidate.value === value);
  if (group) return group.label;
  const text = value.replaceAll('-', ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
};

// The filter value for one tag: a group, the tidied tag when it is a specific
// occasion we do not group (such as "travel"), or '' when it is only a descriptor.
export function occasionValue(tag) {
  const parts = words(tag);
  const group = OCCASION_GROUPS.find(candidate => candidate.words.some(word => parts.includes(word)));
  if (group) return group.value;
  return parts.every(part => DESCRIPTOR_WORDS.has(part)) ? '' : parts.join('-');
}

export function matchesOccasion(outfit, value) {
  return !value || (outfit.occasion || []).some(tag => occasionValue(tag) === value);
}

// Groups in a fixed order, then any specific occasions alphabetically. A current
// selection stays listed after its last matching look is removed.
export function occasionOptions(outfits, selected = '') {
  const values = new Set(outfits.flatMap(outfit => (outfit.occasion || []).map(occasionValue)).filter(Boolean));
  if (selected) values.add(selected);
  const specific = [...values].filter(value => !DISPLAY_ORDER.includes(value)).sort((a, b) => a.localeCompare(b));
  return [...DISPLAY_ORDER.filter(value => values.has(value)), ...specific].map(value => ({ value, label: labelOf(value) }));
}

// Suggestions when saving a look: the standard tags plus specific occasions
// already in use, so new looks do not add further spellings of the same thing.
export function occasionSuggestions(outfits) {
  const specific = occasionOptions(outfits).map(option => option.value).filter(value => !DISPLAY_ORDER.includes(value));
  return [...new Set(['casual', 'dinner', 'smart-casual', 'work', ...specific])].sort((a, b) => a.localeCompare(b));
}
