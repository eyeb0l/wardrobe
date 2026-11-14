import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { API, harness } from './test-helpers/outfit-harness.mjs';
import { validateJob, validateManifest } from './outfit-storage.mjs';
import { planningDays } from '../shared/outfit-plans.mjs';
import { garmentWearHistory } from '../shared/outfit-shortlist.mjs';

const planBody = (date, revision, outfitId) => ({ date, revision, outfitId, timezoneOffset: new Date().getTimezoneOffset() });

test('removing a look takes it out of the collection, clears its plans and keeps its wears in garment history', async t => {
  const h = await harness(t, { env: { OPENAI_API_KEY: '' } });
  const file = path.join(h.dataDir, 'outfits.json');
  const original = JSON.parse(await readFile(file, 'utf8'));
  original.extra = { retained: true };
  original.outfits[0].custom = 'keep me';
  await writeFile(file, JSON.stringify(original));
  const [today, tomorrow] = planningDays();
  await h.request('POST', `${API}/original-1/favourite`, { favourite: true });
  const worn = await h.request('POST', `${API}/original-1/wears`, { date: '2026-01-04', garmentIds: ['top-1'] });
  const first = await h.request('POST', `${API}/plans`, planBody(today, 'initial', 'original-1'));
  const second = await h.request('POST', `${API}/plans`, planBody(tomorrow, first.plansRevision, 'original-2'));
  const freeBefore = (await h.request('GET', `${API}/config`)).availableCombinations;
  const before = await h.request('GET', API);
  const historyBefore = garmentWearHistory(before.outfits, undefined, before.garmentWears);
  assert.deepEqual(historyBefore.get('top-1'), { count: 1, lastWorn: '2026-01-04' });

  const removed = await h.request('POST', `${API}/original-1/remove`, {});
  assert.equal(removed.id, 'original-1');
  assert.deepEqual(removed.plans.map(item => [item.date, item.outfitId]), [[tomorrow, 'original-2']]);
  assert.notEqual(removed.plansRevision, second.plansRevision);
  assert.deepEqual(removed.garmentWears, [worn.wearHistory[0]]);

  await h.restart();
  const after = await h.request('GET', API);
  assert.deepEqual(after.outfits.map(item => item.id), ['original-2', 'original-3', 'original-4', 'original-5', 'original-6']);
  assert.deepEqual(after.plans, removed.plans);
  assert.equal(after.plansRevision, removed.plansRevision);
  // The piece keeps exactly the history it had before the look was removed.
  assert.deepEqual(garmentWearHistory(after.outfits, undefined, after.garmentWears), historyBefore);
  assert.equal((await h.request('GET', `${API}/config`)).availableCombinations, freeBefore + 1, 'the pair can be generated again');

  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.doesNotThrow(() => validateManifest(saved));
  const tombstone = saved.outfits[0];
  assert.equal(tombstone.status, 'removed');
  assert.ok(Number.isFinite(Date.parse(tombstone.removedAt)));
  assert.equal(tombstone.wearHistory, undefined, 'wears moved rather than counted twice');
  assert.equal(tombstone.custom, 'keep me');
  assert.equal(tombstone.image, original.outfits[0].image);
  assert.deepEqual(saved.extra, original.extra);
  assert.deepEqual(saved.outfits.slice(1), original.outfits.slice(1));

  // Repeating the removal succeeds without changing anything.
  const unchanged = await readFile(file, 'utf8');
  assert.deepEqual(await h.request('POST', `${API}/original-1/remove`, {}), { ...removed, plans: after.plans });
  assert.equal(await readFile(file, 'utf8'), unchanged);
  // The removed look can no longer be used.
  await h.request('POST', `${API}/original-1/favourite`, { favourite: false }, 404);
  await h.request('POST', `${API}/original-1/wears`, { date: '2026-01-05' }, 404);
  await h.request('POST', `${API}/plans`, planBody(today, after.plansRevision, 'original-1'), 404);
  await h.request('GET', `${API}/images/${path.basename(original.outfits[0].image)}`, undefined, 404);
  await h.request('POST', `${API}/missing/remove`, {}, 404);
  await h.request('POST', `${API}/original-2/remove`, {}, 403, { origin: 'https://other.invalid' });
  assert.equal(await readFile(file, 'utf8'), unchanged);
  assert.equal(h.requests.length, 0, 'removal never calls a model');
});

test('a removed generated look keeps its job reconciled and cannot be restored by a delayed retry', async t => {
  const h = await harness(t);
  const job = await h.settled((await h.create(1)).id);
  await h.action(job, job.outfits[0], 'approve');
  const id = job.outfits[0].id;
  await h.request('POST', `${API}/${id}/remove`, {});
  await h.restart();
  const history = await h.request('GET', `${API}/jobs`);
  assert.deepEqual(history.warnings, []);
  assert.equal(history.jobs.find(item => item.id === job.id).outfits[0].status, 'accepted');
  await h.action(job, job.outfits[0], 'approve');
  assert.ok(!(await h.request('GET', API)).outfits.some(item => item.id === id));
  assert.equal(JSON.parse(await readFile(path.join(h.dataDir, 'outfits.json'), 'utf8')).outfits.find(item => item.id === id).status, 'removed');
  // Jobs never take the collection-only status.
  const stored = JSON.parse(await readFile(path.join(h.dataDir, 'outfit-jobs', job.id, 'job.json'), 'utf8'));
  assert.doesNotThrow(() => validateJob(structuredClone(stored), job.id));
  stored.outfits[0].status = 'removed';
  assert.throws(() => validateJob(stored, job.id), /outfits\[0\]\.status/);

  // A saved variation's retry after removal is refused rather than brought back.
  const source = h.originals[0];
  const input = { requestId: randomUUID(), name: 'Variation', expectedGarmentIds: source.garmentIds, expectedImage: source.image, replacedGarmentId: 'top-1', replacementGarmentId: 'top-2' };
  const variation = await h.request('POST', `${API}/original-1/variations`, input);
  await h.request('POST', `${API}/${variation.id}/remove`, {});
  await h.request('POST', `${API}/original-1/variations`, input, 409);
  assert.ok(!(await h.request('GET', API)).outfits.some(item => item.id === variation.id));
});

test('only the saved collection may hold removed looks', () => {
  const look = { id: 'look-1', name: 'Look', occasion: [], garmentIds: ['top-1'], status: 'removed', image: 'outfit-images/look-1.png', removedAt: new Date().toISOString() };
  assert.doesNotThrow(() => validateManifest({ version: 1, outfits: [look] }));
  assert.throws(() => validateManifest({ version: 1, outfits: [{ ...look, removedAt: 'yesterday' }] }), /removedAt/);
  assert.throws(() => validateManifest({ version: 1, outfits: [{ ...look, image: undefined }] }), /image/);
});
