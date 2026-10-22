import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { API, harness } from './test-helpers/outfit-harness.mjs';

const body = (source, extra = {}) => ({ requestId: randomUUID(), name: 'A lighter variation', expectedGarmentIds: source.garmentIds, expectedImage: source.image, replacedGarmentId: 'top-1', replacementGarmentId: 'top-2', ...extra });
const save = (h, extra = {}) => h.request('POST', `${API}/original-1/variations`, body(h.originals[0], extra));
const photo = (h, saved, extra = {}, status = 202) => h.request('POST', `${API}/${saved.id}/photo`, { requestId: randomUUID(), modelReferenceId: 'default', ...extra }, status);
const collection = async h => (await h.request('GET', API)).outfits;

test('variations save real cutouts without AI, allow existing combinations, deduplicate retries and persist independently', async t => {
  const h = await harness(t, { env: { OPENAI_API_KEY: '' } });
  await h.request('POST', `${API}/original-1/favourite`, { favourite: true });
  await h.request('POST', `${API}/original-1/wears`, { date: '2026-01-02' });
  const original = (await collection(h))[0];
  const input = body(original);
  const saved = await h.request('POST', `${API}/original-1/variations`, input);
  assert.equal(saved.imageKind, 'cutouts');
  assert.equal(saved.variationOf, original.id);
  assert.deepEqual(saved.garmentIds, ['top-2', 'bottom-1']); // already saved as original-5
  assert.equal(saved.favourite, undefined);
  assert.equal(saved.wearHistory, undefined);
  const image = await h.request('GET', saved.image);
  const meta = await sharp(image).metadata();
  assert.equal(meta.width, 1024); assert.equal(meta.height, 1024);
  assert.notDeepEqual(image, h.output);
  assert.deepEqual(await h.request('POST', `${API}/original-1/variations`, input), saved);
  await h.request('POST', `${API}/original-1/variations`, { ...input, name: 'Different' }, 409);
  await h.restart();
  const after = await collection(h);
  assert.equal(after.length, 7);
  assert.deepEqual(after.find(o => o.id === original.id), original);
  assert.deepEqual(after.find(o => o.id === saved.id), saved);
  assert.deepEqual(h.requests, []);
  await photo(h, saved, {}, 503);
});

test('invalid or stale replacements cannot save or incur generation', async t => {
  const h = await harness(t);
  for (const [extra, status] of [[{ replacementGarmentId: 'bottom-2' }, 400], [{ replacementGarmentId: 'top-1' }, 400], [{ replacementGarmentId: 'missing' }, 409], [{ expectedImage: 'outfit-images/original-2.png' }, 409], [{ expectedGarmentIds: ['top-1', 'bottom-2'] }, 409], [{ requestId: '../invalid' }, 400], [{ requestId: [randomUUID()] }, 400]]) {
    await h.request('POST', `${API}/original-1/variations`, body(h.originals[0], extra), status);
  }
  for (const flag of ['hidden', 'deleted']) {
    await writeFile(path.join(h.dataDir, 'library.json'), JSON.stringify(h.items.map(i => i.id === 'top-2' ? { ...i, [flag]: true } : i)));
    await h.request('POST', `${API}/original-1/variations`, body(h.originals[0]), 409);
  }
  await h.request('POST', `${API}/original-1/variations`, body(h.originals[0]), 403, { origin: 'https://other.invalid' });
  assert.equal((await collection(h)).length, 6);
  assert.deepEqual(h.requests, []);
});

test('concurrent variations preserve both looks and the original metadata', async t => {
  const h = await harness(t);
  const results = await Promise.all([save(h), save(h, { replacementGarmentId: 'top-4', name: 'Another look' }), h.request('POST', `${API}/original-1/favourite`, { favourite: true })]);
  const saved = await collection(h);
  assert.equal(saved.length, 8);
  assert.equal(saved.find(o => o.id === 'original-1').favourite, true);
  for (const result of results.slice(0, 2)) assert.ok(saved.find(o => o.id === result.id));
});

test('optional photo uses exact replacement cutouts, survives restart and rejection, then updates only its variation on approval', async t => {
  const h = await harness(t);
  const saved = await save(h);
  const original = (await collection(h))[0];
  const requestId = randomUUID();
  const job = await photo(h, saved, { requestId });
  let review = await h.settled(job.id);
  assert.equal(review.status, 'review');
  assert.deepEqual(review.outfits[0].garmentIds, saved.garmentIds);
  assert.deepEqual(h.requests.map(r => r.kind), ['edit']);
  const names = h.requests[0].images.map(i => i.name);
  assert.ok(names.some(n => n.includes('top-2'))); assert.ok(!names.some(n => n.includes('top-1')));
  await photo(h, saved, { requestId });
  await photo(h, saved, {}, 409);
  assert.equal(h.requests.length, 1);
  await h.restart();
  await h.action(review, review.outfits[0], 'reject');
  assert.deepEqual((await collection(h)).find(o => o.id === saved.id), saved);
  await h.action(review, review.outfits[0], 'retry', { prompt: 'Keep the trousers visible' });
  review = await h.settled(job.id);
  assert.equal(review.status, 'review');
  await h.request('POST', `${API}/${saved.id}/favourite`, { favourite: true });
  await h.request('POST', `${API}/${saved.id}/wears`, { date: '2026-01-02' });
  await h.action(review, review.outfits[0], 'approve');
  await h.restart();
  const after = await collection(h);
  assert.equal(after.length, 7);
  assert.deepEqual(after.find(o => o.id === original.id), original);
  const updated = after.find(o => o.id === saved.id);
  assert.equal(updated.imageKind, 'modelled'); assert.equal(updated.favourite, true);
  assert.equal(updated.wearHistory.length, 1); assert.equal(updated.variationOf, original.id);
  assert.notEqual(updated.image, saved.image); assert.deepEqual(updated.garmentIds, saved.garmentIds);
  assert.equal((await h.request('GET', `${API}/jobs/${job.id}`)).outfits[0].status, 'accepted');
  await h.action(review, review.outfits[0], 'approve');
  await photo(h, updated, {}, 409);
});

test('failed photo can explicitly retry while cutouts remain saved; stale targets cannot approve', async t => {
  const h = await harness(t, { edit: () => Response.json({ error: { message: 'Unavailable' } }, { status: 503 }) });
  const saved = await save(h);
  const job = await photo(h, saved);
  let review = await h.settled(job.id);
  assert.equal(review.status, 'failed');
  assert.deepEqual((await collection(h)).find(o => o.id === saved.id), saved);
  h.setEdit(null);
  await h.request('POST', `${API}/jobs/${job.id}/retry`, {}, 202);
  review = await h.settled(job.id);
  assert.equal(review.status, 'review');
  const file = path.join(h.dataDir, 'outfits.json');
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  manifest.outfits.find(o => o.id === saved.id).garmentIds = ['top-4', 'bottom-1'];
  await writeFile(file, JSON.stringify(manifest));
  await h.action(review, review.outfits[0], 'approve', {}, 409);
  await h.action(review, review.outfits[0], 'retry', {}, 409);
  assert.equal((await collection(h)).find(o => o.id === saved.id).imageKind, 'cutouts');
});

test('approval recovery recognizes the photo marker without adding a duplicate outfit', async t => {
  const h = await harness(t);
  const saved = await save(h);
  const job = await photo(h, saved);
  const review = await h.settled(job.id);
  const file = path.join(h.dataDir, 'outfit-jobs', job.id, 'job.json');
  const before = await readFile(file);
  await h.action(review, review.outfits[0], 'approve');
  await writeFile(file, before); // crash between manifest commit and job commit
  await h.restart();
  const recovered = await h.request('GET', `${API}/jobs/${job.id}`);
  assert.equal(recovered.outfits[0].status, 'accepted');
  assert.equal((await collection(h)).length, 7);
});

test('replacing shoes keeps the same base pair and does not exhaust another generation combination', async t => {
  const h = await harness(t);
  const source = { ...h.originals[0], garmentIds: ['top-1', 'bottom-1', 'shoe-1'] };
  await writeFile(path.join(h.dataDir, 'outfits.json'), JSON.stringify({ version: 1, outfits: [source, ...h.originals.slice(1)] }));
  await writeFile(path.join(h.dataDir, 'imported', 'shoe-2.png'), h.output);
  await writeFile(path.join(h.dataDir, 'library.json'), JSON.stringify([...h.items, { id: 'shoe-2', name: 'Other shoes', part: 'shoes', image: '/api/import/library/shoe-2.png' }]));
  const before = await h.request('GET', `${API}/config`);
  const saved = await h.request('POST', `${API}/original-1/variations`, body(source, { replacedGarmentId: 'shoe-1', replacementGarmentId: 'shoe-2' }));
  assert.deepEqual(saved.garmentIds, ['top-1', 'bottom-1', 'shoe-2']);
  assert.equal((await h.request('GET', `${API}/config`)).availableCombinations, before.availableCombinations);
  const job = await photo(h, saved);
  assert.equal((await h.settled(job.id)).status, 'review');
  assert.ok(h.requests[0].images.some(image => image.name.includes('shoe-2')));
  assert.ok(!h.requests[0].images.some(image => image.name.includes('shoe-1')));
});

test('request identities normalize UUID case and a rejected old photo cannot compete with a newer photo', async t => {
  const h = await harness(t);
  const requestId = randomUUID().toUpperCase();
  const saved = await save(h, { requestId });
  assert.equal(saved.id, `variation-${requestId.toLowerCase()}`);
  const job = await photo(h, saved, { requestId: randomUUID().toUpperCase() });
  const review = await h.settled(job.id);
  await h.action(review, review.outfits[0], 'reject');
  const newer = await photo(h, saved);
  await h.settled(newer.id);
  await h.action(review, review.outfits[0], 'retry', {}, 409);
  assert.equal(h.requests.length, 2);
  await h.request('POST', `${API}/${saved.id}/accessories`, {}, 409);
  assert.equal(h.requests.length, 2);
});
