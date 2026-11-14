import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { PGlite } from '@electric-sql/pglite';
import { createCloudStore, CLOUD_ROOT } from './cloud-store.mjs';
import { displayVersions, encodeDisplayImage, sendDisplayImage, withImageVersions } from './display-image.mjs';
import { withStorage } from './storage-fs.mjs';
import { DISPLAY_WIDTHS, displayImageSource } from '../shared/image-variants.mjs';

async function fixture(t) {
  const pg = new PGlite(); t.after(() => pg.close());
  const database = {
    query: async (sql, args = []) => (await pg.query(sql, args)).rows,
    transaction: queries => pg.transaction(async tx => { for (const q of queries) await tx.query(q.text, q.values); }),
  };
  const objects = new Map(), gets = [], puts = [];
  const blob = {
    async put(name, bytes, opts) {
      assert.equal(opts.access, 'private'); assert.equal(opts.allowOverwrite, false);
      const url = `https://private.invalid/${randomUUID()}/${name}`;
      objects.set(url, Buffer.from(bytes)); puts.push(url); return {url};
    },
    async get(url, opts) {
      assert.equal(opts.access, 'private'); gets.push(url);
      const bytes = objects.get(url); return bytes ? {statusCode: 200, stream: new Response(bytes).body} : null;
    },
  };
  const store = createCloudStore({database, blob}); await store.initialize();
  const file = `${CLOUD_ROOT}/photo.png`;
  const original = await sharp({create:{width:800,height:960,channels:4,background:{r:90,g:60,b:120,alpha:0.6}}}).png().toBuffer();
  await store.withLease(() => store.writeFile(file, original));
  return {store, database, blob, original, file, gets, puts, objects, other:()=>createCloudStore({database,blob})};
}

test('WebP preserves resized alpha exactly, uses requested width, and strips metadata', async () => {
  const width = 800, height = 160;
  const pixels = Buffer.alloc(width * height * 4);
  for(let i=0;i<width*height;i++) { pixels[i*4]=180; pixels[i*4+1]=80; pixels[i*4+2]=140; pixels[i*4+3]=i%256; }
  const png=await sharp(pixels,{raw:{width,height,channels:4}}).png().toBuffer();
  const webp=await encodeDisplayImage(png,320);
  const meta=await sharp(webp).metadata();
  assert.equal(meta.format,'webp'); assert.equal(meta.width,320); assert.equal(meta.hasAlpha,true); assert.equal(meta.exif,undefined);
  const expected=await sharp(png).resize({width:320,withoutEnlargement:true}).extractChannel('alpha').raw().toBuffer();
  assert.deepEqual(await sharp(webp).extractChannel('alpha').raw().toBuffer(),expected);
  await assert.rejects(encodeDisplayImage(png,99999),{status:400});
});

test('stored derivatives survive fresh instances and original replacement invalidates them', async t => {
  const h=await fixture(t); const originalUrl=h.puts[0];
  const first=await h.store.displayImage(h.file,320);
  const before=h.gets.filter(url=>url===originalUrl).length;
  const next=await h.other().displayImage(h.file,320);
  assert.deepEqual(next,first); assert.equal(h.puts.length,2);
  assert.equal(h.gets.filter(url=>url===originalUrl).length,before,'warm requests must not fetch the full PNG');
  assert.deepEqual(await h.store.readFile(h.file),h.original);
  const readCount=h.gets.length;
  assert.deepEqual(await h.other().displayImage(h.file,320,`W/${first.etag}`),{etag:first.etag,version:first.version,notModified:true});
  assert.equal(h.gets.length,readCount,'304 must not fetch either image');
  const replacement=await sharp({create:{width:800,height:960,channels:4,background:'blue'}}).png().toBuffer();
  await h.store.withLease(()=>h.store.writeFile(h.file,replacement));
  const changed=await h.other().displayImage(h.file,320,first.etag);
  assert.notEqual(changed.etag,first.etag); assert.notDeepEqual(changed.bytes,first.bytes);
  assert.deepEqual(await h.store.readFile(h.file),replacement);
  await h.store.withLease(()=>h.store.rm(h.file));
  await assert.rejects(h.store.displayImage(h.file,320,changed.etag),{code:'ENOENT'});
});

test('new derivatives are served from encoded bytes and concurrent requests share one publication', async t => {
  const h = await fixture(t);
  const results = await Promise.all(Array.from({ length: 4 }, () => h.store.displayImage(h.file, 320)));
  assert.equal(h.puts.length, 2, 'one original and one derivative upload');
  assert.deepEqual(h.gets, [h.puts[0]], 'only the original is downloaded; the new WebP is not read back');
  const expected = await encodeDisplayImage(h.original, 320);
  for (const result of results) assert.deepEqual(result.bytes, expected);
  results[0].bytes.fill(0);
  assert.deepEqual(results[1].bytes, expected, 'concurrent consumers cannot mutate each other');
  assert.deepEqual((await h.store.displayImage(h.file, 320)).bytes, expected);
  assert.equal(h.gets.length, 1, 'a later warm request reuses the bounded immutable cache');
  assert.deepEqual((await h.other().displayImage(h.file, 320)).bytes, expected);
  assert.deepEqual(h.gets, [h.puts[0], h.puts[1]], 'a fresh process downloads the persisted derivative only');
});

test('a losing derivative publication serves the database winner rather than its own upload', async t => {
  const h = await fixture(t);
  const otherOriginal = await sharp({create:{width:800,height:960,channels:4,background:'blue'}}).png().toBuffer();
  const winnerBytes = await encodeDisplayImage(otherOriginal, 320);
  const winner = await h.blob.put('competing.webp', winnerBytes, { access: 'private', allowOverwrite: false });
  const query = h.database.query;
  let competed = false;
  h.database.query = async (sql, values) => {
    if (!competed && sql.startsWith('INSERT INTO wardrobe_image_variants')) {
      competed = true;
      // Replay another process publishing between this worker's upload and its
      // insert. Distinct valid bytes make using the losing upload observable.
      const competing = [...values]; competing[4] = winner.url; competing[5] = winnerBytes.length;
      await query(sql, competing);
    }
    return query(sql, values);
  };
  const result = await h.store.displayImage(h.file, 320);
  assert.equal(competed, true);
  assert.deepEqual(result.bytes, winnerBytes);
  assert.deepEqual(h.gets, [h.puts[0], winner.url], 'winner bytes are downloaded once after losing publication');
  assert.deepEqual((await h.store.displayImage(h.file, 320)).bytes, winnerBytes);
  assert.equal(h.gets.length, 2, 'the losing upload never replaces the winner in the immutable cache');
});

test('derivatives remain tied to immutable source bytes during replacement and need no writer lease',async t=>{
  const h=await fixture(t), originalUrl=h.puts[0]; const get=h.blob.get;
  let replaced=false;
  h.blob.get=async(url,opts)=>{
    if(url===originalUrl && !replaced){
      replaced=true;
      const replacement=await sharp({create:{width:800,height:960,channels:4,background:'green'}}).png().toBuffer();
      await h.store.withLease(()=>h.store.writeFile(h.file,replacement));
    }
    return get(url,opts);
  };
  const first=await h.store.displayImage(h.file,640);
  assert.deepEqual(first.bytes,await encodeDisplayImage(h.original,640));
  await h.store.withLease(async()=>{
    const second=await h.other().displayImage(h.file,640);
    assert.notEqual(first.etag,second.etag,'cache writes must work while another operation holds the original-data lease');
  });
});

test('warmup reads each original once and HTTP delivery revalidates privately', async t=>{
  const h=await fixture(t); const originalUrl=h.puts[0];
  await h.store.warmDisplayImages(h.file);
  assert.equal(h.gets.filter(url=>url===originalUrl).length,1);
  assert.equal(h.puts.length,1+DISPLAY_WIDTHS.length);
  const request=async(condition)=>{
    const headers={};let bytes;
    const res={statusCode:200,setHeader(k,v){headers[k]=v},end(value){bytes=value}};
    await withStorage(h.store,()=>sendDisplayImage({headers:{'if-none-match':condition}},res,h.file,new URL('http://local/api/file?format=webp&w=320')));
    return {headers,bytes,status:res.statusCode};
  };
  const first=await request(); assert.equal(first.headers['Content-Type'],'image/webp'); assert.equal(first.headers['Cache-Control'],'private, no-cache');
  assert.equal(h.gets.length, 1, 'warmup seeds the bounded derivative cache without reading back uploads');
  const second=await request(first.headers.ETag);assert.equal(second.status,304);assert.equal(second.bytes,undefined);
});

test('local variants reuse the content hash until the file is replaced in place or by rename', async t=>{
  const fs=await import('node:fs/promises'), path=await import('node:path'), os=await import('node:os');
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'wardrobe-display-local-')); t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const file=path.join(root,'photo.png'), image=color=>sharp({create:{width:400,height:300,channels:4,background:color}}).png().toBuffer();
  await fs.writeFile(file,await image('#336699'));
  let reads=0; const storage={...fs,async readFile(...args){reads++;return fs.readFile(...args);}};
  const request=async(condition)=>{
    const headers={};let bytes;
    const res={statusCode:200,setHeader(k,v){headers[k]=v},end(value){bytes=value}};
    await withStorage(storage,()=>sendDisplayImage({headers:{'if-none-match':condition}},res,file,new URL('http://local/api/file?format=webp&w=320')));
    return {etag:headers.ETag,bytes,status:res.statusCode};
  };
  const first=await request(); assert.equal(first.status,200); assert.equal(reads,1);
  assert.equal((await request(first.etag)).status,304,'revalidation');
  assert.ok((await request()).bytes.equals(first.bytes)); assert.equal(reads,1,'unchanged files are neither reread nor rehashed');
  const { mtime }=await fs.stat(file);
  await fs.writeFile(file,await image('#993366')); await fs.utimes(file,mtime,new Date(mtime.getTime()+5000));
  const edited=await request(first.etag); assert.equal(edited.status,200); assert.notEqual(edited.etag,first.etag);
  const replacement=path.join(root,'next.png'); await fs.writeFile(replacement,await image('#669933'));
  const current=await fs.stat(file); await fs.utimes(replacement,current.atime,current.mtime); await fs.rename(replacement,file);
  const renamed=await request(edited.etag); assert.equal(renamed.status,200); assert.notEqual(renamed.etag,edited.etag);
  assert.equal((await sharp(renamed.bytes).stats()).dominant.g>(await sharp(renamed.bytes).stats()).dominant.r,true,'served bytes come from the replacement');
});

test('responsive URLs preserve version queries and never optimize uploads, SVGs, or external URLs',()=>{
  const src='/api/import/library/photo.png?v=attempt-2';
  assert.equal(displayImageSource(src,320),src+'&format=webp&w=320');
  assert.equal(displayImageSource('/api/import/library/photo.png',320,'abc123'),'/api/import/library/photo.png?format=webp&w=320&v=abc123');
  assert.equal(displayImageSource('/api/import/library/photo.png',320,''),'/api/import/library/photo.png?format=webp&w=320');
  for(const src of ['data:image/png;base64,abc','blob:abc','https://external.test/a.png','/api/import/assets/a/placeholder.svg','/api/secret.json'])assert.equal(displayImageSource(src),null);
});

test('private original responses revalidate without Blob reads and never return stale replacements/deletions',async t=>{
  const {sendOriginalImage}=await import('./display-image.mjs');
  const h=await fixture(t);
  const request=async(condition)=>{
    const headers={};let bytes;
    const res={statusCode:200,setHeader(k,v){headers[k]=v},end(value){bytes=value}};
    await withStorage(h.store,()=>sendOriginalImage({headers:{'if-none-match':condition}},res,h.file));
    return {headers,bytes,status:res.statusCode};
  };
  const first=await request();assert.deepEqual(first.bytes,h.original);assert.equal(first.headers['Cache-Control'],'private, no-cache');
  const reads=h.gets.length;const second=await request(first.headers.ETag);
  assert.equal(second.status,304);assert.equal(second.bytes,undefined);assert.equal(h.gets.length,reads);
  const replacement=await sharp({create:{width:100,height:100,channels:4,background:'red'}}).png().toBuffer();
  await h.store.withLease(()=>h.store.writeFile(h.file,replacement));
  const next=await request(first.headers.ETag);assert.equal(next.status,200);assert.deepEqual(next.bytes,replacement);assert.notEqual(next.headers.ETag,first.headers.ETag);
  await h.store.withLease(()=>h.store.rm(h.file));await assert.rejects(request(next.headers.ETag),{code:'ENOENT'});
});

const deliver = async (store, file, query, condition) => {
  const headers = {}; let bytes;
  const res = { statusCode: 200, setHeader(k, v) { headers[k] = v; }, end(value) { bytes = value; } };
  const send = () => sendDisplayImage({ headers: { 'if-none-match': condition } }, res, file, new URL(`http://local/api/file?format=webp&w=320${query}`));
  await (store ? withStorage(store, send) : send());
  return { cache: headers['Cache-Control'], etag: headers.ETag, bytes, status: res.statusCode };
};
const KEEP = 'private, max-age=31536000, immutable', REVALIDATE = 'private, no-cache';

test('a hosted address carrying the current version is kept; any other version still revalidates', async t => {
  const h = await fixture(t);
  const queries = []; const query = h.database.query;
  h.database.query = async (sql, values) => { queries.push(sql); return query(sql, values); };
  const versions = await withStorage(h.store, () => displayVersions([h.file, `${CLOUD_ROOT}/missing.png`, '/outside/photo.png']));
  assert.equal(queries.length, 1, 'every path is named by one metadata query');
  assert.deepEqual([...versions.keys()], [h.file], 'missing and outside paths have no version');
  const version = versions.get(h.file);
  assert.match(version, /^[a-f0-9]{20}$/);
  assert.equal((await h.store.displayImage(h.file, 320)).version, version, 'the list and the delivery name the same image');

  assert.equal((await deliver(h.store, h.file, '')).cache, REVALIDATE, 'an unversioned address behaves as before');
  assert.equal((await deliver(h.store, h.file, '&v=0000')).cache, REVALIDATE);
  const kept = await deliver(h.store, h.file, `&v=${version}`);
  assert.equal(kept.cache, KEEP);
  const reads = h.gets.length, confirmed = await deliver(h.store, h.file, `&v=${version}`, kept.etag);
  assert.equal(confirmed.status, 304); assert.equal(confirmed.cache, KEEP); assert.equal(h.gets.length, reads);

  // The same path now holds another image. The old address must never be kept
  // with the new bytes, and the list hands out a new version.
  const replacement = await sharp({ create: { width: 800, height: 960, channels: 4, background: 'blue' } }).png().toBuffer();
  await h.store.withLease(() => h.store.writeFile(h.file, replacement));
  const stale = await deliver(h.other(), h.file, `&v=${version}`);
  assert.equal(stale.cache, REVALIDATE); assert.notEqual(stale.etag, kept.etag); assert.notDeepEqual(stale.bytes, kept.bytes);
  const next = (await withStorage(h.store, () => displayVersions([h.file]))).get(h.file);
  assert.notEqual(next, version);
  assert.equal((await deliver(h.other(), h.file, `&v=${next}`)).cache, KEEP);
  await h.store.withLease(() => h.store.rm(h.file));
  assert.equal((await withStorage(h.store, () => displayVersions([h.file]))).size, 0);
  await assert.rejects(deliver(h.store, h.file, `&v=${next}`), { code: 'ENOENT' }, 'a kept address is still refused once the image is gone');
});

test('a local address is kept only for the file it was listed with', async t => {
  const fs = await import('node:fs/promises'), path = await import('node:path'), os = await import('node:os');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wardrobe-display-version-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'photo.png'), image = color => sharp({ create: { width: 400, height: 300, channels: 4, background: color } }).png().toBuffer();
  await fs.writeFile(file, await image('#336699'));
  const version = (await displayVersions([file, path.join(root, 'missing.png'), root])).get(file);
  assert.match(version, /^[a-f0-9]{20}$/);
  assert.equal((await displayVersions([file, path.join(root, 'missing.png'), root])).size, 1, 'missing files and directories have no version');
  assert.equal((await deliver(null, file, '')).cache, REVALIDATE);
  const kept = await deliver(null, file, `&v=${version}`);
  assert.equal(kept.cache, KEEP);
  assert.equal((await deliver(null, file, `&v=${version}`, kept.etag)).status, 304);
  await fs.writeFile(file, await image('#993366'));
  const stale = await deliver(null, file, `&v=${version}`);
  assert.equal(stale.cache, REVALIDATE, 'a replaced file is never kept under its old address');
  assert.notDeepEqual(stale.bytes, kept.bytes);
  const next = (await displayVersions([file])).get(file);
  assert.notEqual(next, version);
  assert.equal((await deliver(null, file, `&v=${next}`)).cache, KEEP);
});

test('lists name each distinct image once, by the field that holds its address', async t => {
  const fs = await import('node:fs/promises'), path = await import('node:path'), os = await import('node:os');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wardrobe-list-version-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'a.png'), 'a'); await fs.writeFile(path.join(root, 'b.png'), 'b');
  const fileFor = address => address.startsWith('/img/') ? path.join(root, address.slice(5)) : null;
  const records = [
    { id: 'both', image: '/img/a.png', thumbnail: '/img/a.png', modeledImage: '/img/b.png' },
    { id: 'gone', image: '/img/missing.png', thumbnail: null, modeledImage: null },
    { id: 'elsewhere', image: 'https://external.test/a.png' },
  ];
  const [both, gone, elsewhere] = await withImageVersions(records, ['image', 'thumbnail', 'modeledImage'], fileFor);
  assert.deepEqual(Object.keys(both.imageVersions), ['image', 'modeledImage']);
  assert.notEqual(both.imageVersions.image, both.imageVersions.modeledImage);
  assert.deepEqual(gone, { ...records[1], imageVersions: {} }, 'a listed record without images says so');
  assert.deepEqual(elsewhere, { ...records[2], imageVersions: {} });
  assert.equal(records[0].imageVersions, undefined, 'stored records are not changed');
});
