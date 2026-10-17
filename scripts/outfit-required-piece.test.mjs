import assert from 'node:assert/strict';
import { readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { API, plan, harness } from './test-helpers/outfit-harness.mjs';

test('configuration counts only unused combinations for each supported piece', async t => {
  const h = await harness(t);
  const config = await h.request('GET', `${API}/config`);
  assert.equal(config.garmentCombinations['top-1'], 0);
  assert.equal(config.garmentCombinations['top-2'], 2);
  assert.equal(config.garmentCombinations['top-3'], 4);
  assert.equal(config.garmentCombinations['bottom-1'], 4);
  assert.equal(config.garmentCombinations['bottom-4'], 5);
  assert.equal(config.garmentCombinations['outer-1'], 18);
  assert.equal(config.garmentCombinations['dress-1'], undefined);
  for (const requiredGarmentId of ['missing', 'dress-1', 'top-1']) {
    await h.request('POST', `${API}/jobs`, { count: 1, requiredGarmentId }, 409);
  }
  for (const requiredGarmentId of [null, [], '../top-3', '']) {
    await h.request('POST', `${API}/jobs`, { count: 1, requiredGarmentId }, 400);
  }
  await h.request('POST', `${API}/jobs`, { count: 3, requiredGarmentId: 'top-2' }, 409);
  assert.equal(h.requests.length, 0, 'invalid requests spend no AI calls');
});

for (const requiredGarmentId of ['top-3', 'bottom-1', 'outer-1', 'shoe-1', 'accessory-1']) {
  test(`required ${requiredGarmentId} persists through planning, retry and restart`, async t => {
    const ids = ['top-3', 'bottom-1', ...(['top-3', 'bottom-1'].includes(requiredGarmentId) ? [] : [requiredGarmentId])];
    const h = await harness(t, { analysis: [plan(1, ids)] });
    const created = await h.create(1, { requiredGarmentId });
    const job = await h.settled(created.id);
    assert.equal(job.status, 'review', job.error);
    assert.equal(job.requiredGarmentId, requiredGarmentId);
    assert.ok(job.outfits[0].garmentIds.includes(requiredGarmentId));
    assert.match(h.requests[0].request.input[0].content[0].text, new RegExp(`Required garment ID: "${requiredGarmentId}"`));
    await h.restart();
    const restored = await h.request('GET', `${API}/jobs/${job.id}`);
    assert.equal(restored.requiredGarmentId, requiredGarmentId);
    await h.action(restored, restored.outfits[0], 'retry', { prompt: 'Keep the required piece visible' });
    const retried = await h.settled(job.id);
    assert.ok(retried.outfits[0].garmentIds.includes(requiredGarmentId));
    await h.action(retried, retried.outfits[0], 'approve');
    const saved = await h.request('GET', API);
    assert.ok(saved.outfits.find(o => o.id === retried.outfits[0].id).garmentIds.includes(requiredGarmentId));
  });
}

test('omitting the required piece fails before image generation; retry retains the constraint', async t => {
  const h = await harness(t);
  const created = await h.create(1, { requiredGarmentId: 'top-4' });
  const failed = await h.settled(created.id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /omitted your required piece/);
  assert.equal(h.requests.filter(r => r.kind === 'edit').length, 0);
  await h.restart();
  await h.request('POST', `${API}/jobs/${created.id}/retry`, {}, 202);
  assert.match((await h.settled(created.id)).error, /omitted your required piece/);
});

for (const unavailable of ['hidden', 'deleted', 'broken-image']) test(`rejects ${unavailable} required pieces before paid planning`, async t => {
  const h = await harness(t);
  const libraryPath = path.join(h.dataDir, 'library.json');
  const library = JSON.parse(await readFile(libraryPath, 'utf8'));
  if (unavailable === 'hidden') library.find(i => i.id === 'top-3').hidden = true;
  if (unavailable === 'deleted') library.splice(library.findIndex(i => i.id === 'top-3'), 1);
  if (unavailable === 'broken-image') await rm(path.join(h.dataDir, 'imported/top-3.png'));
  await writeFile(libraryPath, JSON.stringify(library));
  await h.request('POST', `${API}/jobs`, { count: 1, requiredGarmentId: 'top-3' }, 409);
  assert.equal(h.requests.length, 0);
});
