import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { CLOUD_ROOT, createCloudStore } from './cloud-store.mjs';
import { parseAccessoryUpgradeArgs, upgradeAccessoryCache } from './upgrade-accessory-cache.mjs';

const bytes = Buffer.from('fixture original image bytes');
const hash = createHash('sha256').update(bytes).digest('hex');
const file = `${CLOUD_ROOT}/outfit-images/one.png`;
const cacheFile = `${CLOUD_ROOT}/outfit-accessories.json`;

async function fixture(t) {
  const pg = new PGlite();
  t.after(() => pg.close());
  const queries = [], reads = [], blobs = new Map();
  const database = {
    async query(text, values = []) { queries.push(text); return (await pg.query(text, values)).rows; },
    async transaction(statements) { return pg.transaction(async tx => {
      const results = [];
      for (const { text, values = [] } of statements) results.push((await tx.query(text, values)).rows);
      return results;
    }); },
  };
  const blob = {
    async put(name, value, options) {
      assert.equal(options.access, 'private');
      assert.equal(options.allowOverwrite, false);
      const url = `https://fixture.invalid/${name}`;
      blobs.set(url, Buffer.from(value));
      return { url };
    },
    async get(url) { reads.push(url); return { statusCode: 200, stream: new Response(blobs.get(url)).body }; },
  };
  const fresh = () => createCloudStore({ database, blob });
  const store = fresh();
  await store.initialize();
  const original = { version: 1, futureRoot: { retained: true }, outfits: {
    one: { suggestions: ['Keep one', 'Keep two'], imageHash: hash, model: 'unchanged-model', contextHash: 'unchanged-context', recipeVersion: 1, generatedAt: 'unchanged-time', futureEntry: [1, 2] },
  } };
  await store.withLease(async () => {
    await store.mkdir(`${CLOUD_ROOT}/outfit-images`, { recursive: true });
    await store.writeFile(file, bytes);
    await store.writeFile(`${CLOUD_ROOT}/outfits.json`, JSON.stringify({ version: 1, outfits: [{ id: 'one', name: 'Saved', garmentIds: ['top'], occasion: [], image: 'outfit-images/one.png', status: 'accepted' }] }));
    await store.writeFile(cacheFile, JSON.stringify(original));
  });
  reads.length = 0; queries.length = 0;
  return { store, fresh, reads, queries, original, readCache: async () => JSON.parse(await store.readFile(cacheFile, 'utf8')),
    run: (apply = false, customStore = fresh()) => upgradeAccessoryCache({ dataDir: CLOUD_ROOT, store: customStore, apply }) };
}

test('accessory upgrade dry-run is metadata-only and never acquires a writer lease', async t => {
  const h = await fixture(t);
  const result = await h.run();
  assert.equal(result.candidates, 1);
  assert.equal(result.estimatedOriginalBytes, bytes.length);
  assert.equal(result.imageReads, 0);
  assert.equal(result.imageBytesRead, 0);
  assert.equal(result.upgraded, 0);
  assert.deepEqual(h.reads, []);
  assert.ok(h.queries.every(query => /^SELECT\b/i.test(query.trim())), 'dry-run database work is read-only');
  assert.deepEqual(await h.readCache(), h.original);
});

test('accessory upgrade adds only verified identity hints and is idempotent', async t => {
  const h = await fixture(t);
  const result = await h.run(true);
  assert.equal(result.upgraded, 1);
  assert.equal(result.imageReads, 1);
  assert.equal(result.imageBytesRead, bytes.length);
  assert.equal(h.reads.length, 1);
  const identity = await h.store.imageIdentity(file);
  assert.deepEqual(await h.readCache(), { ...h.original, outfits: { one: { ...h.original.outfits.one, imageIdentity: identity } } });
  h.reads.length = 0;
  const again = await h.run(true);
  assert.equal(again.alreadyCurrent, 1);
  assert.equal(again.upgraded, 0);
  assert.equal(again.imageReads, 0);
  assert.deepEqual(h.reads, []);
});

test('an identical restored image adopts its new identity without changing the portable hash', async t => {
  const h = await fixture(t);
  await h.run(true);
  const previous = await h.readCache();
  await h.store.withLease(() => h.store.writeFile(file, bytes));
  const identity = await h.store.imageIdentity(file);
  assert.notEqual(identity, previous.outfits.one.imageIdentity);
  assert.equal((await h.run(true)).upgraded, 1);
  assert.deepEqual(await h.readCache(), { ...previous, outfits: { one: { ...previous.outfits.one, imageIdentity: identity } } });
});

test('mismatched hashes, malformed entries, deleted files and unsupported cache versions remain unchanged', async t => {
  const h = await fixture(t);
  for (const imageHash of ['0'.repeat(64), 'not-a-hash']) {
    const cache = { ...h.original, outfits: { one: { ...h.original.outfits.one, imageHash } } };
    await h.store.withLease(() => h.store.writeFile(cacheFile, JSON.stringify(cache)));
    const result = await h.run(true);
    assert.equal(result.upgraded, 0);
    assert.equal(result.mismatchedHash, imageHash.length === 64 ? 1 : 0);
    assert.equal(result.skipped, imageHash.length === 64 ? 0 : 1);
    assert.deepEqual(await h.readCache(), cache);
  }
  await h.store.withLease(async () => { await h.store.writeFile(cacheFile, JSON.stringify(h.original)); await h.store.rm(file); });
  assert.equal((await h.run(true)).skipped, 1);
  assert.deepEqual(await h.readCache(), h.original);
  const future = { ...h.original, version: 2 };
  await h.store.withLease(() => h.store.writeFile(cacheFile, JSON.stringify(future)));
  await assert.rejects(h.run(true), /Unsupported/);
  assert.deepEqual(await h.readCache(), future);
});

test('replacement during hashing and loss of the writer lease prevent publication', async t => {
  const h = await fixture(t);
  const store = h.fresh();
  const replacing = { ...store, async readFile(source, ...args) {
    const value = await store.readFile(source, ...args);
    if (source === file) await store.writeFile(file, bytes);
    return value;
  } };
  await assert.rejects(h.run(true, replacing), /image changed/);
  assert.deepEqual(await h.readCache(), h.original);
  const failing = { ...h.fresh(), assertLease: async () => { throw new Error('Lease expired'); } };
  await assert.rejects(h.run(true, failing), /Lease expired/);
  assert.deepEqual(await h.readCache(), h.original);
});

test('upgrade CLI requires explicit cloud selection and apply is opt-in', () => {
  assert.deepEqual(parseAccessoryUpgradeArgs(['--target', 'cloud']), { target: 'cloud', apply: false });
  assert.deepEqual(parseAccessoryUpgradeArgs(['--target', 'cloud', '--apply']), { target: 'cloud', apply: true });
  for (const args of [[], ['--apply'], ['--target', 'local'], ['--target', 'cloud', '--unknown']]) assert.throws(() => parseAccessoryUpgradeArgs(args));
});
