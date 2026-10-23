import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { API, harness } from './test-helpers/outfit-harness.mjs';
import { validateManifest } from './outfit-storage.mjs';
import { garmentWearDates, garmentWearHistory, outfitShortlist } from '../shared/outfit-shortlist.mjs';
import { wardrobeRediscovery } from '../shared/wardrobe-rediscovery.mjs';

const route = `${API}/garment-wears`;
const payload = (garmentIds = ['top-1'], date = '2026-01-04') => ({ requestId: randomUUID(), date, garmentIds, timezoneOffset: new Date().getTimezoneOffset() });

test('individual and bulk backdated wears persist after restart without changing outfits, plans or availability', async t => {
  const h = await harness(t), file = path.join(h.dataDir, 'outfits.json');
  const original = JSON.parse(await readFile(file, 'utf8'));
  Object.assign(original, { custom: { keep: true }, outfitPlans: [{ date: '2026-01-04', outfitId: 'original-1' }] });
  original.outfits[0].favourite = true;
  await writeFile(file, JSON.stringify(original));
  const libraryBefore = await readFile(path.join(h.dataDir, 'library.json'), 'utf8');
  const one = await h.request('POST', route, payload());
  const bulk = await h.request('POST', route, payload(['top-1', 'bottom-1'], '2026-01-05'));
  assert.deepEqual(one.event.garmentIds, ['top-1']);
  assert.deepEqual(bulk.event.garmentIds, ['top-1', 'bottom-1']);
  await h.restart();
  const current = await h.request('GET', API);
  assert.deepEqual(current.garmentWears, bulk.garmentWears);
  assert.deepEqual(current.plans, original.outfitPlans);
  const stored = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(stored.outfits, original.outfits);
  assert.deepEqual(stored.custom, original.custom);
  assert.equal(await readFile(path.join(h.dataDir, 'library.json'), 'utf8'), libraryBefore);
  assert.equal(h.requests.length, 0);
});

test('concurrent direct and outfit logging counts each garment once per date; Undo preserves other evidence', async t => {
  const h = await harness(t);
  const first = payload(['top-1', 'bottom-1']);
  const second = payload(['top-1']);
  await Promise.all([
    h.request('POST', route, first), h.request('POST', route, second),
    h.request('POST', `${API}/original-1/wears`, { date: first.date }),
    h.request('POST', `${API}/original-1/favourite`, { favourite: true }),
  ]);
  let current = await h.request('GET', API);
  const dates = () => garmentWearDates(current.outfits, '2026-02-01', current.garmentWears);
  assert.deepEqual(dates().get('top-1'), [first.date]);
  assert.deepEqual(dates().get('bottom-1'), [first.date]);
  await h.request('POST', `${route}/${first.requestId}/remove`, {});
  await h.request('POST', `${route}/${first.requestId}/remove`, {});
  current = await h.request('GET', API);
  assert.equal(current.garmentWears.length, 1);
  assert.deepEqual(dates().get('top-1'), [first.date]);
  assert.deepEqual(dates().get('bottom-1'), [first.date]);
  assert.equal(current.outfits[0].favourite, true);
  const outfitEvent = current.outfits[0].wearHistory[0];
  await h.request('POST', `${API}/original-1/wears/${outfitEvent.id}/remove`, {});
  current = await h.request('GET', API);
  assert.deepEqual(dates().get('top-1'), [first.date]);
  assert.equal(dates().has('bottom-1'), false);
  await h.request('POST', `${route}/${second.requestId}/remove`, {});
  current = await h.request('GET', API);
  assert.equal(dates().size, 0);
});

test('request retries are idempotent, conflicting payloads fail, and delayed retries cannot resurrect Undo', async t => {
  const h = await harness(t), body = payload(['top-1', 'bottom-1']);
  const saved = await h.request('POST', route, body);
  const retry = await h.request('POST', route, { ...body, garmentIds: [...body.garmentIds].reverse() });
  assert.deepEqual(retry, saved);
  await h.request('POST', route, { ...body, date: '2026-01-03' }, 409);
  await h.request('POST', route, { ...body, garmentIds: ['top-1'] }, 409);
  await h.request('POST', `${route}/${body.requestId}/remove`, {});
  await h.restart();
  await h.request('POST', route, body, 409);
  const current = await h.request('GET', API);
  assert.deepEqual(current.garmentWears, []);
  assert.equal(current.removedGarmentWearIds, undefined, 'internal retry protection is not public data');
  await h.request('POST', route, { ...body, requestId: randomUUID() });
});

test('invalid dates, pieces, request IDs, offsets and origins fail atomically', async t => {
  const h = await harness(t), file = path.join(h.dataDir, 'outfits.json');
  const before = await readFile(file, 'utf8'), body = payload();
  for (const date of ['', null, '2026-02-30', '9999-01-01', '1800-01-01', '2026-1-01']) await h.request('POST', route, { ...body, date }, 400);
  for (const garmentIds of [[], ['top-1', 'top-1'], [null], ['../top'], 'top-1', null]) await h.request('POST', route, { ...body, garmentIds }, 400);
  for (const requestId of ['', null, [body.requestId], 'invalid']) await h.request('POST', route, { ...body, requestId }, 400);
  for (const timezoneOffset of [undefined, null, '0', 1.5, -841, 721]) await h.request('POST', route, { ...body, timezoneOffset }, 400);
  await h.request('POST', route, body, 403, { origin: 'https://other.invalid' });
  await h.request('POST', route, body, 415, { 'content-type': 'text/plain' });
  await h.request('POST', route, { ...body, garmentIds: ['top-1', 'missing'] }, 409);
  const hidden = h.items.map(item => item.id === 'top-1' ? { ...item, hidden: true } : item);
  await writeFile(path.join(h.dataDir, 'library.json'), JSON.stringify(hidden));
  await h.request('POST', route, { ...body, garmentIds: ['bottom-1', 'top-1'] }, 409);
  assert.equal(await readFile(file, 'utf8'), before);
});

test('local date boundaries respect timezone offsets and disallow tomorrow', async t => {
  const h = await harness(t);
  t.mock.method(Date, 'now', () => Date.parse('2026-10-23T00:30:00Z'));
  await h.request('POST', route, { ...payload(), date: '2026-10-23', timezoneOffset: 720 }, 400);
  await h.request('POST', route, { ...payload(), date: '2026-10-22', timezoneOffset: 720 });
  await h.request('POST', route, { ...payload(), date: '2026-10-23', timezoneOffset: -840 });
  await h.request('POST', route, { ...payload(), date: '2026-10-24', timezoneOffset: -840 }, 400);
});

test('without saved looks or an API key, laundry pieces can be logged and deletion retains history and safe retry', async t => {
  const h = await harness(t, { seed: false, env: { OPENAI_API_KEY: '' } }), file = path.join(h.dataDir, 'library.json'), body = payload();
  await writeFile(file, JSON.stringify(h.items.map(item => ({ ...item, availability: 'laundry' }))));
  const saved = await h.request('POST', route, body);
  await writeFile(file, JSON.stringify(h.items.filter(item => item.id !== 'top-1')));
  await h.restart();
  assert.deepEqual(await h.request('POST', route, body), saved);
  assert.deepEqual((await h.request('GET', API)).garmentWears[0].garmentIds, ['top-1']);
  assert.deepEqual((await h.request('GET', API)).outfits, []);
  assert.equal(h.requests.length, 0);
  await h.request('POST', route, payload(), 409);
  await h.request('POST', `${route}/${body.requestId}/remove`, {});
});

test('damaged direct history fails closed while legacy manifests remain valid', async t => {
  const h = await harness(t), file = path.join(h.dataDir, 'outfits.json');
  const original = JSON.parse(await readFile(file, 'utf8'));
  assert.doesNotThrow(() => validateManifest(original));
  const event = { id: randomUUID(), date: '2026-01-04', garmentIds: ['top-1'], createdAt: new Date().toISOString() };
  for (const changes of [
    { garmentWears: {} }, { garmentWears: [{ ...event, date: '2026-02-30' }] },
    { garmentWears: [{ ...event, garmentIds: ['top-1', 'top-1'] }] }, { garmentWears: [event, event] },
    { removedGarmentWearIds: ['bad'] }, { garmentWears: [event], removedGarmentWearIds: [event.id] },
  ]) {
    const damaged = { ...original, ...changes };
    await writeFile(file, JSON.stringify(damaged));
    await h.request('POST', route, payload(), 503);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), damaged);
  }
});

test('direct logging feeds both rediscovery and shortlist explanations without inventing outfit wear', () => {
  const outfits = [{ id: 'look', status: 'accepted', garmentIds: ['top'], occasion: ['casual'], image: '/look.png' }];
  const items = [{ id: 'top', name: 'Top', part: 'upperbody', image: '/top.png' }];
  const garmentWears = [
    { date: '2026-01-04', garmentIds: ['top'] }, { date: '2026-01-04', garmentIds: ['top'] },
    { date: '2026-01-05', garmentIds: ['top'] }, { date: '9999-01-01', garmentIds: ['top'] },
  ];
  assert.deepEqual(garmentWearHistory(outfits, '2026-02-01', garmentWears).get('top'), { count: 2, lastWorn: '2026-01-05' });
  const options = { today: '2026-02-01', garmentWears };
  const shortlist = outfitShortlist(outfits, new Map(items.map(item => [item.id, item])), options);
  assert.equal(shortlist.choices[0].pieces[0].lastWorn, '2026-01-05');
  const rediscovery = wardrobeRediscovery(items, outfits, options);
  assert.equal(rediscovery[0].lastWorn, '2026-01-05');
  assert.equal(outfits[0].wearHistory, undefined);
});
