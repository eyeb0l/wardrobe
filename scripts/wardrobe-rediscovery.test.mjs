import test from 'node:test';
import assert from 'node:assert/strict';
import { wardrobeRediscovery } from '../shared/wardrobe-rediscovery.mjs';
import { garmentWearDates, readySavedLooks } from '../shared/outfit-shortlist.mjs';

const piece = (id, extra = {}) => ({ id, name: id, image: `/${id}.png`, part: 'upperbody', ...extra });
const look = (id, garmentIds, extra = {}) => ({ id, name: id, status: 'accepted', image: `/${id}.png`, garmentIds, occasion: ['casual'], ...extra });
const event = (date, garmentIds) => ({ date, garmentIds });

test('rediscovery counts garment snapshots across looks once per day and ranks dated history before unknown history', () => {
  const items = ['old', 'recent', 'unknown', 'shared', 'laundry'].map(id => piece(id, id === 'laundry' ? { availability: 'laundry' } : {}));
  const outfits = [
    look('original', ['recent', 'shared'], { wearHistory: [event('2026-09-01', ['old', 'shared']), event('2026-10-22', ['recent'])] }),
    look('variation', ['old', 'shared'], { wearHistory: [event('2026-09-01', ['old']), event('2026-09-02', ['old']), event('2026-10-23', ['shared']), event('2026-02-30', ['shared'])] }),
    look('blocked', ['old', 'laundry'], { wearHistory: [event('2026-09-03', ['old'])] }),
    look('rejected', ['unknown'], { status: 'rejected', wearHistory: [event('2026-01-01', ['unknown'])] }),
  ];
  const rows = wardrobeRediscovery(items, outfits, { today: '2026-10-22' });
  assert.deepEqual(rows.map(row => row.item.id), ['shared', 'old', 'recent', 'unknown']);
  assert.deepEqual(rows.map(({ item, ...history }) => history), [
    { count: 1, lastWorn: '2026-09-01' }, { count: 3, lastWorn: '2026-09-03' },
    { count: 1, lastWorn: '2026-10-22' }, { count: 0, lastWorn: '' },
  ]);
  assert.deepEqual(garmentWearDates(outfits, '2026-10-22').get('old'), ['2026-09-03', '2026-09-02', '2026-09-01']);
});

test('only Ready visible garments with usable references are suggested, with stable tie ordering', () => {
  const items = [piece('b'), piece('a'), piece('hidden', { hidden: true }), piece('deleted', { deleted: true }), piece('image', { image: null }), piece('bad'), piece('wash', { availability: 'laundry' })];
  assert.deepEqual(wardrobeRediscovery(items, [], { failedImages: new Set(['/bad.png']) }).map(row => row.item.id), ['a', 'b']);
  assert.deepEqual(items.map(item => item.id), ['b', 'a', 'hidden', 'deleted', 'image', 'bad', 'wash']);
});

test('matching looks intersect piece and occasion and exclude laundry, missing or failed images, and review candidates', () => {
  const items = new Map(['top', 'bottom', 'wash', 'hidden'].map(id => [id, piece(id, id === 'wash' ? { availability: 'laundry' } : id === 'hidden' ? { hidden: true } : {})]));
  const outfits = [look('ready', ['top', 'bottom']), look('variation', ['top', 'bottom'], { imageKind: 'cutouts', occasion: ['work'] }), look('laundry', ['top', 'wash']), look('hidden', ['top', 'hidden']), look('missing', ['top', 'gone']), look('review', ['top', 'bottom'], { status: 'review' }), look('other', ['bottom'])];
  assert.deepEqual(readySavedLooks(outfits, items, { garmentId: 'top' }).map(o => o.id), ['ready', 'variation']);
  assert.deepEqual(readySavedLooks(outfits, items, { garmentId: 'top', occasion: 'work' }).map(o => o.id), ['variation']);
  assert.equal(readySavedLooks(outfits, items, { garmentId: 'top', failedImages: new Set(['/top.png']) }).length, 0);
  assert.deepEqual(readySavedLooks(outfits, items, { garmentId: 'top', failedImages: new Set(['/ready.png']) }).map(o => o.id), ['variation']);
  items.get('wash').availability = 'ready';
  assert.ok(readySavedLooks(outfits, items, { garmentId: 'top' }).some(o => o.id === 'laundry'));
});

test('undoing a wear and local day rollover update rediscovery from the same history source', () => {
  const items = [piece('first'), piece('second')];
  const outfits = [look('look', ['first', 'second'], { wearHistory: [event('2026-10-22', ['first']), event('2026-10-23', ['second'])] })];
  assert.equal(wardrobeRediscovery(items, outfits, { today: '2026-10-22' })[1].count, 0);
  assert.equal(wardrobeRediscovery(items, outfits, { today: '2026-10-23' })[1].count, 1);
  outfits[0].wearHistory.shift();
  assert.deepEqual(wardrobeRediscovery(items, outfits, { today: '2026-10-23' }).map(row => row.item.id), ['second', 'first']);
});
