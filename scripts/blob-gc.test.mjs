import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { createCloudStore, CLOUD_ROOT } from './cloud-store.mjs';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { maintenance } from '../server/maintenance.mjs';
import { withStorage } from './storage-fs.mjs';
import { readLibrary, saveLibraryEdit, publicLibraryItem, deleteLibraryItem } from './wardrobe-library.mjs';

async function fixture(t) {
  const pg = new PGlite(); t.after(() => pg.close());
  const database = {
    query: async (text, values = []) => (await pg.query(text, values)).rows,
    transaction: queries => pg.transaction(async tx => { for (const q of queries) await tx.query(q.text, q.values); }),
  };
  const objects = new Map(), removed = [];
  const blob = {
    async put(name, bytes) {
      const pathname = name.replace(/(\.[^.]+)$/, `-${randomUUID()}$1`);
      const url = `https://test.private.blob.vercel-storage.com/${pathname}`;
      objects.set(url, { url, pathname, size: bytes.length, bytes }); return { url };
    },
    async get(url) { const value = objects.get(url); return value ? { statusCode: 200, stream: new Response(value.bytes).body } : null; },
    async list({ prefix }) { return { blobs: [...objects.values()].filter(x => x.pathname.startsWith(prefix)), hasMore: false }; },
    async del(url) { removed.push(url); objects.delete(url); },
  };
  const store = createCloudStore({ database, blob }); await store.initialize();
  const image = await sharp({ create: { width: 64, height: 64, channels: 4, background: 'red' } }).png().toBuffer();
  const file = `${CLOUD_ROOT}/image.png`;
  await store.withLease(() => store.writeFile(file, image));
  const original = [...objects.keys()][0];
  const age = () => pg.query("UPDATE wardrobe_blob_gc SET first_unreferenced_at = clock_timestamp() - interval '8 days'");
  return { pg, database, blob, objects, removed, store, file, image, original, age, other: () => createCloudStore({ database, blob }) };
}

test('GC protects live originals, copies and derivatives; only deletes seven-day orphans', async t => {
  const h = await fixture(t);
  await h.store.displayImage(h.file, 320);
  const copy = `${CLOUD_ROOT}/copy.png`;
  await h.store.withLease(async () => { await h.store.copyFile(h.file, copy); await h.store.rm(h.file); });
  const foreign = 'https://test.private.blob.vercel-storage.com/wardrobe/keep.png';
  h.objects.set(foreign, { url: foreign, pathname: 'wardrobe/keep.png', size: 1 });
  assert.equal((await h.store.collectGarbage()).pending, 0);
  assert.equal(h.removed.length, 0);
  await h.store.withLease(() => h.store.rm(copy));
  assert.equal((await h.store.collectGarbage({ dryRun: true })).unreferenced, 2);
  assert.equal((await h.pg.query('SELECT * FROM wardrobe_blob_gc')).rows.length, 0, 'dry run does not mark anything');
  assert.equal((await h.store.collectGarbage()).pending, 2);
  assert.equal((await h.store.collectGarbage()).deleted, 0, 'upload age is not enough: seven days start at first orphan observation');
  await h.age();
  assert.equal((await h.store.collectGarbage()).deleted, 2);
  assert.equal(h.objects.size, 1); assert.ok(h.objects.has(foreign));
  assert.equal((await h.pg.query('SELECT * FROM wardrobe_image_variants')).rows.length, 0);
});

test('restoring a reference resets the grace period, including its display copies', async t => {
  const h = await fixture(t); await h.store.displayImage(h.file, 320);
  await h.store.withLease(() => h.store.rm(h.file));
  await h.store.collectGarbage(); await h.age();
  await h.pg.query("INSERT INTO wardrobe_files (path,kind,blob_url,size) VALUES ($1,'file',$2,$3)", [h.file,h.original,h.image.length]);
  assert.equal((await h.pg.query('SELECT * FROM wardrobe_blob_gc')).rows.length,0);
  await h.store.withLease(() => h.store.rm(h.file));
  assert.equal((await h.store.collectGarbage()).deleted, 0);
});

test('failed deletion retries and its durable marker blocks republishing after lease loss', async t => {
  const h = await fixture(t);
  await h.store.withLease(() => h.store.rm(h.file)); await h.store.collectGarbage(); await h.age();
  const del = h.blob.del;
  h.blob.del = async () => {
    await h.pg.query("UPDATE wardrobe_storage_lease SET expires_at = clock_timestamp() - interval '1 second'");
    await h.other().withLease(async () => {
      await assert.rejects(h.pg.query("INSERT INTO wardrobe_files (path,kind,blob_url,size) VALUES ($1,'file',$2,1)", [h.file,h.original]), /retired Blob/);
      await assert.rejects(h.pg.query("INSERT INTO wardrobe_image_variants (cache_key,source_blob_url,recipe,width,blob_url,size) VALUES ('late',$1,'v1',320,'https://test/late',1)",[h.original]), /retired Blob/);
    });
    throw new Error('Temporary Blob failure');
  };
  await assert.rejects(h.store.collectGarbage(), { code: 'ESTALE' });
  assert.ok(h.objects.has(h.original));
  assert.equal((await h.pg.query('SELECT state FROM wardrobe_blob_gc')).rows[0].state,'deleting');
  h.blob.del = del;
  assert.equal((await h.other().collectGarbage()).deleted,1);
});

test('pagination, unpublished uploads, active writer exclusion and malformed listings', async t => {
  const h = await fixture(t);
  const orphan = await h.blob.put(`wardrobe/${randomUUID()}.png`, h.image);
  const all = [...h.objects.values()];
  h.blob.list = async ({ cursor }) => cursor ? { blobs: [all[1]], hasMore: false } : { blobs: [all[0]], hasMore: true, cursor: 'second' };
  assert.equal((await h.store.collectGarbage()).pending, 1);
  await h.age();
  await h.store.withLease(() => assert.rejects(h.other().collectGarbage(), { code: 'EBUSY' }));
  await h.store.collectGarbage();
  assert.deepEqual(h.removed,[orphan.url]); assert.ok(h.objects.has(h.original));
  h.blob.list = async () => ({ blobs: [], hasMore: true });
  await assert.rejects(h.store.collectGarbage(), /Invalid Blob listing/);
});

test('maintenance requires its separate secret and never collects on unauthorized requests', async () => {
  let calls = 0;
  const request = async (headers = {}, secret = 'test-secret', method = 'GET') => {
    let body; const res = { statusCode:200, setHeader(){}, end(value){body=JSON.parse(value)} };
    await maintenance({method,headers},res,{collectGarbage:async()=>{calls++;return{deleted:0}}},secret);
    return {status:res.statusCode,body};
  };
  assert.equal((await request()).status,401);
  assert.equal((await request({authorization:'Bearer wrong'})).status,401);
  assert.equal((await request({authorization:'Bearer '},'')).status,401);
  assert.equal((await request({authorization:'Bearer test-secret'},undefined,'POST')).status,405);
  assert.equal(calls,0);
  assert.equal((await request({authorization:'Bearer test-secret'})).status,200);assert.equal(calls,1);
});

test('shared edits commit atomically through cloud storage and survive fresh store instances', async t => {
  const h = await fixture(t), file = `${CLOUD_ROOT}/library.json`;
  const original = { id:'cloud-item',name:'Before',part:'upperbody',tags:[],image:'/api/import/library/image.png' };
  await h.store.withLease(() => h.store.writeFile(file,JSON.stringify([original])));
  await h.store.withLease(() => withStorage(h.store, () => saveLibraryEdit(file,original.id,{revision:publicLibraryItem(original).revision,changes:{name:'After'}})));
  const other = h.other();
  const records = await withStorage(other,()=>readLibrary(file));
  assert.equal(records[0].name,'After');assert.equal(records[0].image,original.image);
  await other.withLease(() => withStorage(other,()=>deleteLibraryItem(file,original.id,publicLibraryItem(records[0]).revision)));
  assert.equal((await withStorage(h.store,()=>readLibrary(file)))[0].hidden,true);
  assert.deepEqual(await h.store.readFile(h.file),h.image,'edits and hides do not rewrite original image bytes');
});
