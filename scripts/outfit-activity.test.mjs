import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { API, harness } from './test-helpers/outfit-harness.mjs';
import { validateManifest } from './outfit-storage.mjs';
import { localDate, validWearDate, wearSummary } from '../shared/outfit-activity.mjs';

test('favourites and dated wear events survive restart, merge concurrent writes and preserve existing data', async t => {
  const h = await harness(t);
  const file = path.join(h.dataDir, 'outfits.json');
  const original = JSON.parse(await readFile(file, 'utf8'));
  original.extra = { retained: true };
  original.outfits[0].custom = 'keep me';
  await writeFile(file, JSON.stringify(original));
  const base = `${API}/original-1`;
  await Promise.all([
    h.request('POST', `${base}/favourite`, { favourite: true }),
    h.request('POST', `${base}/wears`, { date: '2026-01-04' }),
    h.request('POST', `${base}/wears`, { date: '2026-01-05', garmentIds: ['top-1'] }),
  ]);
  const duplicated = await h.request('POST', `${base}/wears`, { date: '2026-01-04' });
  assert.equal(duplicated.wearHistory.length, 2);
  assert.equal(duplicated.favourite, true);
  await h.restart();
  const saved = (await h.request('GET', API)).outfits[0];
  assert.equal(saved.favourite, true);
  assert.deepEqual(wearSummary(saved), { count: 2, lastWorn: '2026-01-05' });
  assert.deepEqual(saved.wearHistory.find(e => e.date === '2026-01-05').garmentIds, ['top-1']);
  const removed = saved.wearHistory.find(e => e.date === '2026-01-04').id;
  await h.request('POST', `${base}/wears/${removed}/remove`, {});
  await h.request('POST', `${base}/wears/${removed}/remove`, {});
  await h.request('POST', `${base}/favourite`, { favourite: false });
  const current = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(current.extra, original.extra);
  assert.equal(current.outfits[0].custom, 'keep me');
  assert.equal(current.outfits[0].image, original.outfits[0].image);
  assert.equal(current.outfits[0].favourite, false);
  assert.equal(current.outfits[0].wearHistory.length, 1);
  assert.deepEqual(current.outfits.slice(1), original.outfits.slice(1));
  assert.equal(h.requests.length, 0, 'activity never calls a model');
});

test('activity rejects malformed, cross-origin and conflicting records without changing the collection', async t => {
  const h = await harness(t);
  const base = `${API}/original-1`;
  const before = await readFile(path.join(h.dataDir, 'outfits.json'), 'utf8');
  for (const favourite of [undefined, 'yes', 1, null]) await h.request('POST', `${base}/favourite`, { favourite }, 400);
  for (const date of ['', '2026-02-30', '2025-02-29', '2026-1-01', null, '9999-01-01', '1800-01-01']) await h.request('POST', `${base}/wears`, { date }, 400);
  for (const garmentIds of [null, [], ['missing'], ['top-1', 'top-1'], 'top-1', [null]]) await h.request('POST', `${base}/wears`, { date: '2026-01-01', garmentIds }, 400);
  await h.request('POST', `${API}/missing/favourite`, { favourite: true }, 404);
  await h.request('POST', `${base}/favourite`, { favourite: true }, 403, { origin: 'https://other.invalid' });
  await h.request('POST', `${base}/wears`, { date: '2026-01-01' }, 415, { 'content-type': 'text/plain' });
  assert.equal(await readFile(path.join(h.dataDir, 'outfits.json'), 'utf8'), before);
  const first = await h.request('POST', `${base}/wears`, { date: '2026-01-01' });
  await h.request('POST', `${base}/wears`, { date: '2026-01-01', garmentIds: ['top-1'] }, 409);
  assert.deepEqual((await h.request('GET', API)).outfits[0].wearHistory, first.wearHistory);
  assert.equal(h.requests.length, 0);
});

test('stored activity is validated without rejecting legacy outfits or erasing damaged records', async t => {
  const h = await harness(t);
  const file = path.join(h.dataDir, 'outfits.json');
  const original = JSON.parse(await readFile(file, 'utf8'));
  assert.doesNotThrow(() => validateManifest(original));
  for (const changes of [{ favourite: 'yes' }, { wearHistory: {} }, { wearHistory: [{ id: 'bad', date: '2026-01-01' }] }]) {
    const broken = structuredClone(original);
    Object.assign(broken.outfits[0], changes);
    await writeFile(file, JSON.stringify(broken));
    await h.request('POST', `${API}/original-1/favourite`, { favourite: true }, 503);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), broken);
  }
});

test('wears retain their garment snapshot after wardrobe deletion and support correcting a date', async t => {
  const h = await harness(t);
  const base = `${API}/original-1`;
  const saved = await h.request('POST', `${base}/wears`, { date: '2026-01-01' });
  await writeFile(path.join(h.dataDir, 'library.json'), JSON.stringify(h.items.filter(item => item.id !== 'top-1')));
  await h.restart();
  const current = (await h.request('GET', API)).outfits[0];
  assert.deepEqual(current.wearHistory, saved.wearHistory);
  await h.request('POST', `${base}/wears/${saved.wearHistory[0].id}/remove`, {});
  const corrected = await h.request('POST', `${base}/wears`, { date: '2026-01-02', garmentIds: ['bottom-1'] });
  assert.deepEqual(wearSummary(corrected), { count: 1, lastWorn: '2026-01-02' });
});

test('calendar dates validate leap days and use local calendar fields', () => {
  assert.ok(validWearDate('2024-02-29'));
  assert.equal(validWearDate('2025-02-29'), false);
  assert.equal(localDate(new Date(2026, 9, 22, 23, 59)), '2026-10-22');
});
