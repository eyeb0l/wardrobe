import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesOccasion, occasionOptions, occasionSuggestions, occasionValue } from '../shared/outfit-occasions.mjs';

const look = (...occasion) => ({ occasion });

test('saved tags group into a short list regardless of spelling', () => {
  const groups = {
    casual: ['casual', 'everyday', 'relaxed', 'weekend', 'city-day', 'city-daytime', 'city day', 'Casual'],
    'smart-casual': ['smart-casual', 'Smart Casual', 'smart casual', 'nicer', 'lunch'],
    work: ['work', 'office', 'office-lunch'],
    evening: ['dinner', 'date-night', 'evening', 'evening-outing', 'dressy', 'casual-dinner', 'winter-dinner'],
  };
  for (const [value, tags] of Object.entries(groups)) for (const tag of tags) assert.equal(occasionValue(tag), value, tag);
});

test('every tag in the saved collection lands in the four groups or is left out', () => {
  const tags = ['autumn winter', 'autumn winter daytime', 'casual', 'city day', 'city daytime', 'cool weather', 'dark tonal', 'date night', 'dinner', 'dressy', 'evening', 'evening outing', 'everyday', 'layered', 'lunch', 'nicer', 'office', 'relaxed', 'smart casual', 'statement', 'warm weather', 'weekend', 'winter', 'workday'];
  assert.deepEqual(occasionOptions(tags.map(tag => look(tag))).map(option => option.label), ['Casual', 'Smart casual', 'Work', 'Evening out']);
  assert.equal(occasionValue('workday'), 'work');
  assert.equal(occasionValue('winter'), '');
});

test('season, weather and styling notes are not offered as occasions', () => {
  for (const tag of ['autumn-winter', 'autumn-winter-daytime', 'cool-weather', 'warm-weather', 'dark-tonal', 'layered', 'statement', '', '  ']) assert.equal(occasionValue(tag), '', tag);
});

test('specific occasions stay selectable, in one spelling, after the standard groups', () => {
  const outfits = [look('Beach Trip', 'dark-tonal'), look('beach-trip'), look('travel'), look('office'), look('dinner'), look('nicer'), look('everyday')];
  assert.deepEqual(occasionOptions(outfits), [
    { value: 'casual', label: 'Casual' }, { value: 'smart-casual', label: 'Smart casual' }, { value: 'work', label: 'Work' }, { value: 'evening', label: 'Evening out' },
    { value: 'beach-trip', label: 'Beach trip' }, { value: 'travel', label: 'Travel' },
  ]);
  assert.ok(matchesOccasion(outfits[0], 'beach-trip'));
  assert.ok(matchesOccasion(outfits[1], 'beach-trip'));
});

test('only groups in use are listed, and the current selection is kept', () => {
  assert.deepEqual(occasionOptions([look('layered'), look('office')]).map(option => option.value), ['work']);
  assert.deepEqual(occasionOptions([look('office')], 'evening').map(option => option.value), ['work', 'evening']);
  assert.deepEqual(occasionOptions([look('office')], 'travel').map(option => option.value), ['work', 'travel']);
  assert.deepEqual(occasionOptions([{}]), []);
});

test('filtering matches any tag in the group and never changes the saved tags', () => {
  const outfit = look('dressy', 'autumn-winter');
  assert.ok(matchesOccasion(outfit, 'evening'));
  assert.ok(matchesOccasion(outfit, ''));
  assert.ok(!matchesOccasion(outfit, 'casual'));
  assert.ok(!matchesOccasion(outfit, 'autumn-winter'));
  assert.ok(!matchesOccasion({}, 'casual'));
  assert.ok(matchesOccasion({}, ''));
  assert.deepEqual(outfit.occasion, ['dressy', 'autumn-winter']);
});

test('save suggestions offer standard tags and specific occasions, not every old spelling', () => {
  assert.deepEqual(occasionSuggestions([look('autumn-winter', 'city-daytime', 'evening-outing', 'nicer'), look('Beach Trip')]), ['beach-trip', 'casual', 'dinner', 'smart-casual', 'work']);
});
