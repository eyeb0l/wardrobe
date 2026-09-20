import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import sharp from 'sharp';
import { createCloudStore, CLOUD_ROOT } from './cloud-store.mjs';
import { withStorage } from './storage-fs.mjs';
import { wardrobeOutfitApi } from './outfit-api.mjs';

const API = '/api/outfits';
const timestamp = '2026-09-20T00:00:00.000Z';

async function harness(t) {
  const pg = new PGlite();
  const queries = [], reads = [], blobs = new Map();
  const database = {
    async query(text, values = []) { queries.push({ text, values }); return (await pg.query(text, values)).rows; },
    async transaction(statements) { return pg.transaction(async tx => {
      const result = [];
      for (const { text, values = [] } of statements) { queries.push({ text, values }); result.push((await tx.query(text, values)).rows); }
      return result;
    }); },
  };
  const blob = {
    async put(name, bytes, options) {
      assert.equal(options.access, 'private');
      const url = `https://private.invalid/${name}`;
      blobs.set(url, Buffer.from(bytes));
      return { url };
    },
    async get(url) {
      reads.push(url);
      assert.ok(blobs.has(url), 'tests read only the in-memory Blob boundary');
      return { statusCode: 200, stream: new Response(blobs.get(url)).body };
    },
  };
  const store = createCloudStore({ database, blob });
  await store.initialize();
  const png = await sharp({ create: { width: 32, height: 32, channels: 4, background: '#abcdef' } }).png().toBuffer();
  const manifest = { version: 1, outfits: [{ id: 'saved-look', name: 'Saved look', occasion: ['casual'], garmentIds: ['top-1', 'bottom-1'], status: 'accepted', image: `${API}/images/saved-look.png` }] };
  const records = [
    { id: 'top-1', name: 'Top', part: 'upperbody', image: '/api/import/library/top-1.png' },
    { id: 'bottom-1', name: 'Bottom', part: 'lowerbody', image: '/api/import/library/bottom-1.png' },
    { id: 'bottom-2', name: 'Second bottom', part: 'lowerbody', image: '/api/import/library/bottom-2.png' },
  ];
  await store.withLease(async () => {
    for (const directory of ['outfit-jobs', 'outfit-images', 'imported']) await store.mkdir(`${CLOUD_ROOT}/${directory}`);
    for (const record of records) await store.writeFile(`${CLOUD_ROOT}/imported/${record.id}.png`, png);
    await store.writeFile(`${CLOUD_ROOT}/outfit-images/saved-look.png`, png);
    await store.writeFile(`${CLOUD_ROOT}/model-reference.png`, png);
    await store.writeFile(`${CLOUD_ROOT}/library.json`, JSON.stringify(records));
    await store.writeFile(`${CLOUD_ROOT}/outfits.json`, JSON.stringify(manifest));
  });
  const instances = [];
  const makePlugin = async (targetStore = store) => {
    const plugin = wardrobeOutfitApi({ serverless: true, readOnly: true,
      env: { WARDROBE_DATA_DIR: CLOUD_ROOT, WARDROBE_MODEL_REFERENCE: `${CLOUD_ROOT}/model-reference.png`, OPENAI_API_KEY: 'test-key' },
      fetch: () => assert.fail('read-only routes never call a provider'),
    });
    instances.push(plugin);
    await withStorage(targetStore, () => plugin.configResolved({ root: '/unused' }));
    return plugin;
  };
  const request = async (url, { plugin, headers = {}, targetStore = store } = {}) => withStorage(targetStore, async () => {
    const instance = plugin || await makePlugin(targetStore);
    let route;
    instance.configureServer({ middlewares: { use(handler) { route = handler; } } });
    const req = Object.assign(Readable.from([]), { url, method: 'GET', headers });
    const result = { status: 200, headers: {} };
    const res = { statusCode: 200, setHeader(name, value) { result.headers[name.toLowerCase()] = value; }, end(value) {
      result.status = this.statusCode;
      result.body = typeof value === 'string' ? JSON.parse(value) : value;
    } };
    await route(req, res, () => assert.fail('unhandled route'));
    return result;
  });
  const reset = () => { queries.length = 0; reads.length = 0; };
  const job = (id = randomUUID(), status = 'rejected') => ({ version: 1, id, count: 1, direction: '', modelReferenceId: 'default', createdAt: timestamp, updatedAt: timestamp,
    status: status === 'review' ? 'review' : 'complete', outfits: [{ id: `look-${id}`, name: 'Historical look', occasion: ['casual'], garmentIds: ['top-1', 'bottom-2'], status, attempts: 1, internal: {} }], internal: {} });
  const writeJob = async value => store.withLease(async () => {
    await store.mkdir(`${CLOUD_ROOT}/outfit-jobs/${value.id}`, { recursive: true });
    await store.writeFile(`${CLOUD_ROOT}/outfit-jobs/${value.id}/job.json`, JSON.stringify(value));
  });
  t.after(async () => { for (const instance of instances) await instance.closeBundle(); await pg.close(); });
  return { store, png, manifest, records, queries, reads, makePlugin, request, reset, job, writeJob, freshStore: () => createCloudStore({ database, blob }) };
}

test('accepted list, image 304 and accessory checks do not hydrate historical jobs', async t => {
  const h = await harness(t);
  const image = await h.request(`${API}/images/saved-look.png`);
  assert.equal(image.status, 200);
  const actions = [
    [API, {}],
    [`${API}/images/saved-look.png`, { headers: { 'if-none-match': image.headers.etag } }],
    [`${API}/saved-look/accessories`, {}],
  ];
  const baseline = [];
  for (const [url, options] of actions) {
    h.reset();
    baseline.push({ response: await h.request(url, options), queries: h.queries.length });
    assert.equal(h.reads.length, 0);
  }
  for (let index = 0; index < 25; index++) await h.writeJob(h.job());
  for (const [index, [url, options]] of actions.entries()) {
    h.reset();
    assert.deepEqual(await h.request(url, options), baseline[index].response);
    assert.equal(h.queries.length, baseline[index].queries, url);
    assert.equal(h.reads.length, 0, 'conditional and metadata routes download no image bodies');
    assert.ok(h.queries.every(({ values }) => !values.some(value => typeof value === 'string' && value.includes('/outfit-jobs'))));
  }
  t.diagnostic(`Local database calls with 0 or 25 jobs: list=${baseline[0].queries}, original 304=${baseline[1].queries}, accessories=${baseline[2].queries}`);
});

test('accepted image checks revalidate manifest membership and source existence before 304', async t => {
  const h = await harness(t);
  const plugin = await h.makePlugin();
  const image = await h.request(`${API}/images/saved-look.png`, { plugin });
  const headers = { 'if-none-match': image.headers.etag };
  h.reset();
  assert.equal((await h.request(`${API}/images/saved-look.png`, { plugin, headers })).status, 304);
  assert.equal(h.reads.length, 0);
  await h.store.withLease(() => h.store.writeFile(`${CLOUD_ROOT}/outfits.json`, JSON.stringify({ version: 1, outfits: [] })));
  assert.equal((await h.request(`${API}/images/saved-look.png`, { plugin, headers })).status, 404);
  await h.store.withLease(async () => {
    await h.store.writeFile(`${CLOUD_ROOT}/outfits.json`, JSON.stringify(h.manifest));
    await h.store.rm(`${CLOUD_ROOT}/outfit-images/saved-look.png`);
  });
  assert.equal((await h.request(`${API}/images/saved-look.png`, { plugin, headers })).status, 404);
  assert.equal((await h.request(`${API}/images/saved-look.png`, { headers, targetStore: h.freshStore() })).status, 404);
  assert.equal(h.reads.length, 0);
});

test('settings batch garment metadata and refresh changed and deleted paths without image reads', async t => {
  const h = await harness(t);
  const plugin = await h.makePlugin();
  h.reset();
  const before = await h.request(`${API}/config`, { plugin });
  const baselineQueries = h.queries.length;
  assert.equal(before.body.availableCombinations, 1);
  assert.equal(h.reads.length, 0);
  const extra = Array.from({ length: 60 }, (_, index) => ({ id: `extra-${index}`, name: 'Extra top', part: 'upperbody', image: `/api/import/library/extra-${index}.png` }));
  await h.store.withLease(async () => {
    for (const record of extra) await h.store.writeFile(`${CLOUD_ROOT}/imported/${record.id}.png`, h.png);
    await h.store.writeFile(`${CLOUD_ROOT}/library.json`, JSON.stringify([...h.records, ...extra]));
  });
  h.reset();
  const grown = await h.request(`${API}/config`, { plugin });
  assert.equal(grown.body.counts.upperbody, 61);
  assert.equal(h.queries.length, baselineQueries, 'metadata calls do not grow per garment');
  assert.equal(h.reads.length, 0);
  await h.store.withLease(() => h.store.rm(`${CLOUD_ROOT}/imported/top-1.png`));
  const deleted = await h.request(`${API}/config`, { plugin });
  assert.equal(deleted.body.counts.upperbody, 60);
  await h.store.withLease(() => h.store.writeFile(`${CLOUD_ROOT}/library.json`, JSON.stringify(h.records.map(record => ({ ...record, hidden: true })))));
  assert.equal((await h.request(`${API}/config`, { plugin })).body.counts.upperbody, 0);
  t.diagnostic(`Local settings database calls with 3 or 63 garments: ${baselineQueries}`);
});

test('lazy jobs preserve reservations and corruption warnings and refresh reused readers', async t => {
  const h = await harness(t);
  const plugin = await h.makePlugin();
  const reservation = h.job(undefined, 'review');
  await h.writeJob(reservation);
  assert.equal((await h.request(`${API}/config`, { plugin })).body.availableCombinations, 0);
  reservation.outfits[0].status = 'rejected'; reservation.status = 'complete';
  await h.writeJob(reservation);
  assert.equal((await h.request(`${API}/config`, { plugin })).body.availableCombinations, 1);
  const corruptId = randomUUID();
  await h.store.withLease(async () => {
    await h.store.mkdir(`${CLOUD_ROOT}/outfit-jobs/${corruptId}`);
    await h.store.writeFile(`${CLOUD_ROOT}/outfit-jobs/${corruptId}/job.json`, '{broken');
  });
  const jobs = await h.request(`${API}/jobs`, { plugin });
  assert.equal(jobs.body.jobs.length, 1);
  assert.equal(jobs.body.warnings.length, 1);
  assert.match(jobs.body.warnings[0], /Invalid JSON/);
  assert.equal((await h.request(API, { plugin })).status, 200);
  await h.store.withLease(() => h.store.rm(`${CLOUD_ROOT}/outfit-jobs/${reservation.id}`, { recursive: true }));
  assert.equal((await h.request(`${API}/jobs/${reservation.id}`, { plugin })).status, 404);
});

test('individual job polls and candidate 304s read only the fresh requested job', async t => {
  const h = await harness(t);
  const target = h.job(undefined, 'review');
  const candidate = `${API}/jobs/${target.id}/assets/candidate.png`;
  target.outfits[0].image = candidate;
  target.outfits[0].internal.candidateFile = 'candidate.png';
  await h.writeJob(target);
  await h.store.withLease(() => h.store.writeFile(`${CLOUD_ROOT}/outfit-jobs/${target.id}/candidate.png`, h.png));
  const plugin = await h.makePlugin();
  const image = await h.request(candidate, { plugin });
  assert.equal(image.status, 200);
  const actions = [
    [`${API}/jobs/${target.id}`, { plugin }],
    [candidate, { plugin, headers: { 'if-none-match': image.headers.etag } }],
  ];
  const baseline = [];
  for (const [url, options] of actions) {
    h.reset();
    baseline.push({ response: await h.request(url, options), queries: h.queries.length });
    assert.equal(h.reads.length, 0);
  }
  const unrelated = [];
  for (let index = 0; index < 25; index++) { const job = h.job(); unrelated.push(job.id); await h.writeJob(job); }
  for (const [index, [url, options]] of actions.entries()) {
    h.reset();
    assert.deepEqual(await h.request(url, options), baseline[index].response);
    assert.equal(h.queries.length, baseline[index].queries, url);
    assert.equal(h.reads.length, 0);
    assert.ok(h.queries.every(({ values }) => !values.some(value => typeof value === 'string' && unrelated.some(id => value.includes(id)))));
  }
  // Warm readers must honor candidate membership changes, even with an ETag.
  delete target.outfits[0].internal.candidateFile;
  await h.writeJob(target);
  assert.equal((await h.request(candidate, actions[1][1])).status, 404);
  await h.store.withLease(() => h.store.rm(`${CLOUD_ROOT}/outfit-jobs/${target.id}/job.json`));
  for (const [url, options] of actions) assert.equal((await h.request(url, options)).status, 404);
  assert.equal((await h.request(`${API}/jobs/${target.id}`, { targetStore: h.freshStore() })).status, 404);
  t.diagnostic(`Local database calls with 0 or 25 unrelated jobs: individual poll=${baseline[0].queries}, candidate 304=${baseline[1].queries}`);
});

test('job routes and pending-task discovery retain the collection corruption guard', async t => {
  const h = await harness(t);
  const target = h.job();
  await h.writeJob(target);
  const plugin = await h.makePlugin();
  await h.store.withLease(() => h.store.writeFile(`${CLOUD_ROOT}/outfits.json`, '{broken'));
  for (const url of [`${API}/jobs`, `${API}/jobs/${target.id}`, `${API}/config`]) {
    const response = await h.request(url, { plugin });
    assert.equal(response.status, 503);
    assert.match(response.body.error, /could not be parsed/);
  }
  await assert.rejects(withStorage(h.store, () => plugin.pendingTasks()), { status: 503 });
});
