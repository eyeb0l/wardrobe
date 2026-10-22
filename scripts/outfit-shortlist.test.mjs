import test from 'node:test';
import assert from 'node:assert/strict';
import { garmentWearHistory, outfitShortlist } from '../shared/outfit-shortlist.mjs';

const today = '2026-10-22';
const items = new Map([
  ...Array.from({ length: 5 }, (_, i) => [`top-${i}`, { id: `top-${i}`, name: `Top ${i}`, part: 'upperbody', image: '/top.png' }]),
  ...Array.from({ length: 5 }, (_, i) => [`bottom-${i}`, { id: `bottom-${i}`, name: `Bottom ${i}`, part: 'lowerbody', image: '/bottom.png' }]),
  ['shoe', { id: 'shoe', name: 'Shoes', part: 'shoes', image: '/shoes.png' }],
  ['dress', { id: 'dress', name: 'Dress', part: 'dresses', image: '/dress.png' }],
]);
const look = (n, extra = {}) => ({ id: `look-${n}`, name: `Look ${n}`, status: 'accepted', image: '/look.png', occasion: ['casual'], garmentIds: [`top-${n}`, `bottom-${n}`], ...extra });
const wear = (date, garmentIds) => ({ date, garmentIds });
const shortlist = (outfits, options = {}, inventory = items) => outfitShortlist(outfits, inventory, { today, ...options });
const ids = result => result.choices.map(row => row.outfit.id);

test('garment history spans looks, counts distinct local days and respects the logged piece subset', () => {
  const outfits = [look(0, { wearHistory: [wear('2026-10-01', ['top-0']), wear('2026-10-02', ['top-0', 'bottom-0'])] }),
    look(1, { wearHistory: [wear('2026-10-02', ['top-0']), wear('2026-10-03', ['old-garment'])] })];
  const history = garmentWearHistory(outfits, today);
  assert.deepEqual(history.get('top-0'), { count: 2, lastWorn: '2026-10-02' });
  assert.deepEqual(history.get('bottom-0'), { count: 1, lastWorn: '2026-10-02' });
  assert.deepEqual(history.get('old-garment'), { count: 1, lastWorn: '2026-10-03' });
  assert.equal(history.has('top-1'), false, 'do not infer pieces from the current outfit');
  assert.equal(history.has('bottom-1'), false);
});

test('a recently worn shared piece moves an otherwise old favourite behind less recent combinations', () => {
  const outfits = [look(0, { favourite: true, wearHistory: [wear('2026-08-01', ['top-0', 'bottom-0'])] }),
    look(1, { favourite: true, wearHistory: [wear('2026-09-01', ['top-1', 'bottom-1'])] }),
    look(2, { occasion: ['work'], wearHistory: [wear(today, ['top-0'])] })];
  const result = shortlist(outfits, { mode: 'favourites', occasion: 'casual' });
  assert.deepEqual(ids(result), ['look-1', 'look-0']);
  assert.equal(result.choices[1].lastWorn, today);
  assert.equal(result.choices[1].pieces.find(piece => piece.id === 'top-0').count, 2);
});

test('recent ordering uses the latest wear of any piece, not outfit age, favourite status or new variation status', () => {
  const outfits = [look(0, { favourite: true, wearHistory: [wear(today, ['bottom-0'])] }),
    look(1, { imageKind: 'cutouts', variationOf: 'original', wearHistory: [wear('2026-09-01', ['top-1', 'bottom-1'])] }),
    look(2, { wearHistory: [wear('2026-10-01', ['top-2', 'bottom-2'])] }),
    look(3, { wearHistory: [wear('2026-10-02', ['top-3', 'bottom-3'])] })];
  assert.deepEqual(ids(shortlist(outfits)), ['look-1', 'look-2', 'look-3']);
  assert.deepEqual(ids(shortlist(outfits, { mode: 'favourites' })), ['look-0']);
});

test('missing and partial history remain explicit; unknown history does not pretend to be never worn', () => {
  const result = shortlist([look(0), look(1, { wearHistory: [wear('2026-10-01', ['top-1'])] }), look(2, { wearHistory: [wear(today, ['top-2', 'bottom-2'])] })]);
  assert.deepEqual(ids(result), ['look-1', 'look-2', 'look-0']);
  assert.equal(result.choices[0].unknownCount, 1);
  assert.equal(result.choices[2].unknownCount, 2);
  assert.equal(result.choices[2].lastWorn, '');
});

test('variations sharing the same main pieces do not occupy multiple choices', () => {
  const original = look(0, { favourite: true });
  const variation = { ...original, id: 'variation', name: 'Variation', garmentIds: ['bottom-0', 'top-0', 'shoe'], imageKind: 'cutouts' };
  const result = shortlist([original, variation, look(1), look(2)]);
  assert.equal(result.matchingCount, 4); assert.equal(result.distinctCount, 3);
  assert.equal(result.choices.length, 3);
  assert.ok(ids(result).includes('look-1')); assert.ok(ids(result).includes('look-2'));
  assert.equal(shortlist([original, variation]).choices.length, 1);
});

test('only eligible saved looks match occasion and favourites; no favourites does not fall back silently', () => {
  assert.equal(shortlist([look(0)], { mode: 'favourites' }).choices.length, 0);
  assert.equal(shortlist([look(0)], { occasion: 'work' }).choices.length, 0);
  assert.deepEqual(ids(shortlist([look(0), look(1, { occasion: ['work'], favourite: true })], { mode: 'favourites', occasion: 'work' })), ['look-1']);
  assert.equal(shortlist([]).choices.length, 0);
});

test('hidden, deleted, missing garments and missing images are excluded without throwing away their history', () => {
  const inventory = new Map(items);
  inventory.set('top-0', { ...items.get('top-0'), hidden: true });
  inventory.set('top-1', { ...items.get('top-1'), deleted: true });
  inventory.delete('top-2');
  inventory.set('top-3', { ...items.get('top-3'), image: '' });
  const result = shortlist([look(0, { wearHistory: [wear(today, ['shoe'])] }), look(1), look(2), look(3), look(4, { garmentIds: ['top-4', 'bottom-4', 'shoe'] }), look(4, { id: 'no-image', image: '' })], {}, inventory);
  assert.deepEqual(ids(result), ['look-4']); assert.equal(result.unavailableCount, 5);
  assert.equal(result.choices[0].lastWorn, today);
});

test('future, malformed and unaccepted wear records cannot distort the shortlist', () => {
  const history = garmentWearHistory([look(0, { wearHistory: [wear('2026-10-23', ['top-0']), wear('2026-02-30', ['top-0']), wear('invalid', ['top-0'])] }), look(1, { status: 'review', wearHistory: [wear(today, ['top-0'])] })], today);
  assert.equal(history.size, 0);
});

test('ordering is deterministic, supports saved dresses, and does not mutate source data', () => {
  const outfits = [look(0), look(1), look(2), look(3), look(4, { garmentIds: ['dress'] })];
  const before = structuredClone(outfits);
  assert.deepEqual(ids(shortlist(outfits)), ids(shortlist([...outfits].reverse())));
  assert.deepEqual(outfits, before);
  assert.equal(shortlist([outfits[4]]).choices.length, 1);
});

test('wear additions, undo and favourite changes immediately recompute the selection', () => {
  const outfits = [look(0, { favourite: true, wearHistory: [wear('2026-09-01', ['top-0', 'bottom-0'])] }), look(1, { favourite: true, wearHistory: [wear('2026-10-01', ['top-1', 'bottom-1'])] })];
  assert.equal(ids(shortlist(outfits))[0], 'look-0');
  outfits[0].wearHistory.push(wear(today, ['top-0']));
  assert.equal(ids(shortlist(outfits))[0], 'look-1');
  outfits[0].wearHistory.pop();
  assert.equal(ids(shortlist(outfits))[0], 'look-0');
  outfits[0].favourite = false;
  assert.deepEqual(ids(shortlist(outfits, { mode: 'favourites' })), ['look-1']);
});

test('failed images exclude affected looks while preserving history and permit retry', () => {
  const outfits = [look(0, { image: '/broken-look.png', wearHistory: [wear(today, ['top-2'])] }), look(1), look(2)];
  const inventory = new Map(items);
  inventory.set('top-1', { ...items.get('top-1'), image: '/broken-piece.png' });
  const failedImages = new Set(['/broken-look.png', '/broken-piece.png']);
  const result = shortlist(outfits, { failedImages }, inventory);
  assert.deepEqual(ids(result), ['look-2']);
  assert.equal(result.choices[0].lastWorn, today, 'failed preview does not erase logged wear');
  assert.equal(result.unavailableCount, 2);
  assert.equal(shortlist(outfits, {}, inventory).choices.length, 3, 'retry can consider all choices again');
  assert.equal(failedImages.size, 2, 'ranking does not mutate availability state');
});
