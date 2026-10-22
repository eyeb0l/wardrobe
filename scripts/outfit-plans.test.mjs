import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { API, harness } from './test-helpers/outfit-harness.mjs';
import { validateManifest } from './outfit-storage.mjs';
import { planningDays, planAvailability } from '../shared/outfit-plans.mjs';

const body = (date, revision = 'initial', outfitId = 'original-1', extra = {}) => ({ date, revision, outfitId, timezoneOffset: new Date().getTimezoneOffset(), ...extra });

test('plans persist, replace and move atomically without logging wear or losing collection fields', async t => {
  const h = await harness(t), [today, tomorrow] = planningDays();
  const file = path.join(h.dataDir, 'outfits.json');
  const original = JSON.parse(await readFile(file, 'utf8'));
  original.custom = { preserved: true };
  await writeFile(file, JSON.stringify(original));
  assert.deepEqual((await h.request('GET', API)).plans, []);
  const first = await h.request('POST', `${API}/plans`, body(today));
  await h.request('POST', `${API}/original-1/favourite`, { favourite: true });
  const second = await h.request('POST', `${API}/plans`, body(tomorrow, first.plansRevision, 'original-2'));
  const moved = await h.request('POST', `${API}/plans`, body(tomorrow, second.plansRevision, 'original-1', { fromDate: today }));
  assert.deepEqual(moved.plans, [{ date: tomorrow, outfitId: 'original-1' }]);
  await h.restart();
  const restarted = await h.request('GET', API);
  assert.deepEqual(restarted.plans, moved.plans);
  assert.equal(restarted.plansRevision, moved.plansRevision);
  const stored = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(stored.custom, original.custom);
  assert.equal(stored.outfits[0].image, original.outfits[0].image);
  assert.equal(stored.outfits[0].favourite, true);
  assert.equal(stored.outfits[0].wearHistory, undefined);
  await h.request('POST', `${API}/plans`, body(tomorrow, moved.plansRevision, null));
  assert.deepEqual((await h.request('GET', API)).plans, []);
  assert.equal(h.requests.length, 0);
});

test('stale concurrent writes and stale confirmations cannot replace a plan or log another look', async t => {
  const h = await harness(t), [today, tomorrow] = planningDays();
  const results = await Promise.all([today, tomorrow].map(date => h.request('POST', `${API}/plans`, body(date), null)));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  const current = await h.request('GET', API);
  const first = await h.request('POST', `${API}/plans`, body(today, current.plansRevision));
  const replaced = await h.request('POST', `${API}/plans`, body(today, first.plansRevision, 'original-2'));
  await h.request('POST', `${API}/original-1/wears`, { date: today, planDate: today, plansRevision: first.plansRevision }, 409);
  await h.request('POST', `${API}/original-1/wears`, { date: today, planDate: today, plansRevision: replaced.plansRevision }, 409);
  const wear = { date: today, planDate: today, plansRevision: replaced.plansRevision };
  const saved = await h.request('POST', `${API}/original-2/wears`, wear);
  assert.equal((await h.request('POST', `${API}/original-2/wears`, wear)).wearHistory.length, 1);
  await h.request('POST', `${API}/original-2/wears/${saved.wearHistory[0].id}/remove`, {});
  assert.deepEqual((await h.request('GET', API)).plans, replaced.plans);
  await h.request('POST', `${API}/original-2/wears`, wear);
  await h.request('POST', `${API}/plans`, body(today, replaced.plansRevision, null));
  assert.equal((await h.request('GET', API)).outfits.find(o => o.id === 'original-2').wearHistory.length, 1);
});

test('validation and unavailable pieces reject without writes; laundry can be planned with a warning', async t => {
  const h = await harness(t), [today] = planningDays(), file = path.join(h.dataDir, 'outfits.json');
  const before = await readFile(file, 'utf8');
  for (const date of ['', '2026-02-30', null]) await h.request('POST', `${API}/plans`, body(date), 400);
  for (const date of ['1900-01-01', '9999-01-01']) await h.request('POST', `${API}/plans`, body(date), 409);
  for (const timezoneOffset of [null, '0', -841, 721]) await h.request('POST', `${API}/plans`, body(today, 'initial', 'original-1', { timezoneOffset }), 400);
  await h.request('POST', `${API}/plans`, body(today, 'initial', 'missing'), 404);
  await h.request('POST', `${API}/plans`, body(today), 403, { origin: 'https://elsewhere.invalid' });
  await h.request('POST', `${API}/plans`, body(today, 'initial', 'original-1', { fromDate: '1900-01-01' }), 409);
  const libraryFile = path.join(h.dataDir, 'library.json');
  const library = JSON.parse(await readFile(libraryFile, 'utf8'));
  library.find(i => i.id === 'top-1').hidden = true;
  await writeFile(libraryFile, JSON.stringify(library));
  await h.request('POST', `${API}/plans`, body(today), 409);
  assert.equal(await readFile(file, 'utf8'), before);
  library.find(i => i.id === 'top-1').hidden = false;
  library.find(i => i.id === 'top-1').availability = 'laundry';
  await writeFile(libraryFile, JSON.stringify(library));
  await h.request('POST', `${API}/plans`, body(today));
  const outfit = (await h.request('GET', API)).outfits[0];
  assert.equal(planAvailability(outfit, new Map(library.map(i => [i.id, i]))).laundry.length, 1);
});

test('plan calendar handles month/year boundaries; invalid stored plans fail closed', () => {
  assert.deepEqual(planningDays(new Date(2026, 11, 31, 23, 59)), ['2026-12-31', '2027-01-01']);
  assert.deepEqual(planningDays(new Date(2024, 1, 28)), ['2024-02-28', '2024-02-29']);
  for (const outfitPlans of [null, [{ date: '2026-02-30', outfitId: 'look' }], [{ date: '2026-10-22', outfitId: 'look' }, { date: '2026-10-22', outfitId: 'other' }]]) {
    assert.throws(() => validateManifest({ version: 1, outfits: [], outfitPlans }));
  }
  assert.throws(() => validateManifest({ version: 1, outfits: [], outfitPlansRevision: 'bad' }));
});
