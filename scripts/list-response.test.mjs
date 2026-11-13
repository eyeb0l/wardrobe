import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import { wardrobeImportApi } from './import-job-api.mjs';
import { wardrobeOutfitApi } from './outfit-api.mjs';
import { sendListJson } from './list-response.mjs';
import { wardrobeRead } from '../src/wardrobe-sync.mjs';
import { imageVersion, rememberImageVersions } from '../src/image-versions.mjs';

const respond = (value, condition) => {
  const headers = {}; let body;
  const res = { statusCode: 200, setHeader(name, header) { headers[name] = header; }, end(sent) { body = sent; } };
  sendListJson({ headers: condition ? { 'if-none-match': condition } : {} }, res, value);
  return { status: res.statusCode, headers, body };
};

test('an unchanged list answers 304 with no body and is never stored', () => {
  const first = respond([{ id: 'a' }]);
  assert.equal(first.status, 200); assert.deepEqual(JSON.parse(first.body), [{ id: 'a' }]);
  assert.equal(first.headers['Cache-Control'], 'no-store');
  assert.match(first.headers.ETag, /^"list-[a-f0-9]{32}"$/);
  for (const condition of [first.headers.ETag, `W/${first.headers.ETag}`, `"other", ${first.headers.ETag}`]) {
    const again = respond([{ id: 'a' }], condition);
    assert.equal(again.status, 304); assert.equal(again.body, undefined);
    assert.equal(again.headers['Cache-Control'], 'no-store'); assert.equal(again.headers.ETag, first.headers.ETag);
  }
  const changed = respond([{ id: 'b' }], first.headers.ETag);
  assert.equal(changed.status, 200); assert.notEqual(changed.headers.ETag, first.headers.ETag);
  assert.deepEqual(JSON.parse(changed.body), [{ id: 'b' }]);
});

async function servers(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wardrobe-list-')); t.after(() => rm(root, { recursive: true, force: true }));
  const data = path.join(root, 'data');
  await mkdir(path.join(data, 'imported'), { recursive: true }); await mkdir(path.join(data, 'outfit-images'), { recursive: true });
  const image = color => sharp({ create: { width: 64, height: 64, channels: 4, background: color } }).png().toBuffer();
  for (const [name, color] of [['top.png', '#336699'], ['bottom.png', '#996633'], ['top-modeled.png', '#669933']]) await writeFile(path.join(data, 'imported', name), await image(color));
  await writeFile(path.join(data, 'outfit-images', 'look.png'), await image('#444444'));
  await writeFile(path.join(data, 'library.json'), JSON.stringify([
    { id: 'top', name: 'Top', part: 'upperbody', color: '#336699', tags: [], image: '/api/import/library/top.png', thumbnail: '/api/import/library/top.png', modeledImage: '/api/import/library/top-modeled.png' },
    { id: 'bottom', name: 'Bottom', part: 'lowerbody', color: '#996633', tags: [], image: '/api/import/library/bottom.png' },
  ]));
  await writeFile(path.join(data, 'outfits.json'), JSON.stringify({ version: 1, outfits: [
    { id: 'look', name: 'Look', occasion: ['casual'], garmentIds: ['top', 'bottom'], status: 'accepted', image: 'outfit-images/look.png' },
  ] }));
  const connect = async (factory, options = {}) => {
    const plugin = factory({ env: { WARDROBE_DATA_DIR: data, OPENAI_API_KEY: '' }, ...options });
    await plugin.configResolved({ root }); t.after(() => plugin.closeBundle?.());
    let handler; plugin.configureServer({ middlewares: { use(fn) { handler = fn; } } });
    return async (method, url, { payload, headers = {} } = {}) => {
      const req = Readable.from(payload === undefined ? [] : [Buffer.from(JSON.stringify(payload))]);
      Object.assign(req, { method, url, headers: { host: 'wardrobe.test', origin: 'http://wardrobe.test', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...headers } });
      const sent = {}; let body;
      const res = { statusCode: 200, setHeader(name, value) { sent[name.toLowerCase()] = value; }, end(value) { body = value; } };
      await handler(req, res, () => assert.fail('Unexpected route'));
      return { status: res.statusCode, headers: sent, body, json: () => JSON.parse(body) };
    };
  };
  return { data, image, wardrobe: await connect(wardrobeImportApi), outfits: await connect(wardrobeOutfitApi) };
}

test('the wardrobe list names image versions, answers 304 until it changes, and its addresses are kept', async t => {
  const h = await servers(t);
  const first = await h.wardrobe('GET', '/api/import/wardrobe');
  assert.equal(first.status, 200); assert.equal(first.headers['cache-control'], 'no-store');
  const [top, bottom] = first.json();
  assert.deepEqual(Object.keys(top.imageVersions), ['image', 'modeledImage'], 'a thumbnail that is the image is named once');
  assert.deepEqual(Object.keys(bottom.imageVersions), ['image']);
  const again = await h.wardrobe('GET', '/api/import/wardrobe', { headers: { 'if-none-match': first.headers.etag } });
  assert.equal(again.status, 304); assert.equal(again.body, undefined);

  const address = `${top.image}?format=webp&w=320&v=${top.imageVersions.image}`;
  const kept = await h.wardrobe('GET', address);
  assert.equal(kept.headers['cache-control'], 'private, max-age=31536000, immutable');
  assert.equal((await sharp(kept.body).metadata()).format, 'webp');
  assert.equal((await h.wardrobe('GET', `${top.image}?format=webp&w=320`)).headers['cache-control'], 'private, no-cache');
  assert.equal((await h.wardrobe('GET', `${bottom.image}?format=webp&w=320&v=${top.imageVersions.image}`)).headers['cache-control'], 'private, no-cache', 'another image\'s version is not this one\'s');

  // An edit and a replaced image each change the list, so neither can hide behind a 304.
  const edited = await h.wardrobe('PATCH', '/api/import/wardrobe/top', { payload: { revision: top.revision, changes: { name: 'Renamed' } } });
  assert.equal(edited.status, 200); assert.equal(edited.json().imageVersions, undefined, 'only lists name versions');
  const afterEdit = await h.wardrobe('GET', '/api/import/wardrobe', { headers: { 'if-none-match': first.headers.etag } });
  assert.equal(afterEdit.status, 200); assert.equal(afterEdit.json()[0].name, 'Renamed');
  assert.equal(afterEdit.json()[0].imageVersions.image, top.imageVersions.image, 'an edit leaves the image version alone');
  await writeFile(path.join(h.data, 'imported', 'top.png'), await h.image('#cc3366'));
  const afterReplace = await h.wardrobe('GET', '/api/import/wardrobe', { headers: { 'if-none-match': afterEdit.headers.etag } });
  assert.equal(afterReplace.status, 200);
  assert.notEqual(afterReplace.json()[0].imageVersions.image, top.imageVersions.image);
  assert.equal(afterReplace.json()[0].imageVersions.modeledImage, top.imageVersions.modeledImage);
  await rm(path.join(h.data, 'imported', 'bottom.png'));
  assert.deepEqual((await h.wardrobe('GET', '/api/import/wardrobe')).json()[1].imageVersions, {}, 'a missing image is listed without a version');
  assert.equal((await h.wardrobe('GET', address)).headers['cache-control'], 'private, no-cache', 'the replaced image is not kept under its old address');
  assert.equal(JSON.parse(await readFile(path.join(h.data, 'library.json'), 'utf8')).some(item => 'imageVersions' in item), false, 'versions are never saved');
});

test('the outfit collection names image versions and answers 304 until it changes', async t => {
  const h = await servers(t);
  const first = await h.outfits('GET', '/api/outfits');
  assert.equal(first.status, 200); assert.equal(first.headers['cache-control'], 'no-store');
  const [look] = first.json().outfits;
  assert.equal(look.image, '/api/outfits/images/look.png');
  assert.match(look.imageVersions.image, /^[a-f0-9]{20}$/);
  assert.equal((await h.outfits('GET', '/api/outfits', { headers: { 'if-none-match': first.headers.etag } })).status, 304);
  assert.equal((await h.outfits('GET', `${look.image}?format=webp&w=320&v=${look.imageVersions.image}`)).headers['cache-control'], 'private, max-age=31536000, immutable');
  assert.equal((await h.outfits('GET', `${look.image}?format=webp&w=320`)).headers['cache-control'], 'private, no-cache');
  const favourite = await h.outfits('POST', '/api/outfits/look/favourite', { payload: { favourite: true } });
  assert.equal(favourite.status, 200);
  const changed = await h.outfits('GET', '/api/outfits', { headers: { 'if-none-match': first.headers.etag } });
  assert.equal(changed.status, 200); assert.equal(changed.json().outfits[0].favourite, true);
  assert.equal(JSON.parse(await readFile(path.join(h.data, 'outfits.json'), 'utf8')).outfits.some(outfit => 'imageVersions' in outfit), false, 'versions are never saved');
});

test('the browser reader sends its validator, keeps its copy on 304 and reports failures', async t => {
  const calls = [];
  const reply = (status, body, headers = {}) => ({ status, ok: status >= 200 && status < 300, headers: new Headers(headers), json: async () => { if (body === undefined) throw new Error('no body'); return body; } });
  let next;
  t.mock.method(globalThis, 'fetch', async (url, options) => { calls.push({ url, options }); return next; });
  next = reply(200, [{ id: 'a' }], { ETag: '"list-1"' });
  assert.deepEqual(await wardrobeRead('/api/import/wardrobe', null), { value: [{ id: 'a' }], etag: '"list-1"' });
  assert.equal(calls[0].options.headers, undefined); assert.equal(calls[0].options.cache, 'no-store');
  next = reply(304);
  const controller = new AbortController();
  assert.deepEqual(await wardrobeRead('/api/import/wardrobe', '"list-1"', { signal: controller.signal }), { notModified: true });
  assert.deepEqual(calls[1].options.headers, { 'If-None-Match': '"list-1"' }); assert.equal(calls[1].options.signal, controller.signal);
  next = reply(200, [{ id: 'b' }]);
  assert.deepEqual(await wardrobeRead('/api/import/wardrobe', '"list-1"'), { value: [{ id: 'b' }], etag: null }, 'a server without validators is read in full every time');
  next = reply(304);
  await assert.rejects(wardrobeRead('/api/import/wardrobe', null), /Could not reach the wardrobe/, 'a 304 nobody asked for is not a list');
  next = reply(503, { error: 'Wardrobe unavailable.' });
  await assert.rejects(wardrobeRead('/api/import/wardrobe', '"list-1"'), { message: 'Wardrobe unavailable.', status: 503 });
});

test('image versions are remembered by address and survive records that omit them', () => {
  rememberImageVersions([{ image: '/api/import/library/a.png', modeledImage: '/api/import/library/a-modeled.png', imageVersions: { image: 'v1', modeledImage: 'v2', thumbnail: 'ignored' } }, { image: '/api/import/library/b.png' }, null]);
  assert.equal(imageVersion('/api/import/library/a.png'), 'v1');
  assert.equal(imageVersion('/api/import/library/a-modeled.png'), 'v2');
  assert.equal(imageVersion('/api/import/library/b.png'), undefined);
  rememberImageVersions([{ image: '/api/import/library/a.png' }]);
  assert.equal(imageVersion('/api/import/library/a.png'), 'v1', 'a record returned by a write does not forget the version');
  rememberImageVersions([{ image: '/api/import/library/a.png', thumbnail: '/api/import/library/a.png', imageVersions: { image: 'v3' } }]);
  assert.equal(imageVersion('/api/import/library/a.png'), 'v3', 'an address named under another field keeps its version');
  assert.equal(imageVersion('/api/import/library/a-modeled.png'), 'v2', 'a record that no longer mentions an address says nothing about it');
  rememberImageVersions([{ image: '/api/import/library/a.png', modeledImage: '/api/import/library/a-modeled.png', imageVersions: { modeledImage: 'v2' } }]);
  assert.equal(imageVersion('/api/import/library/a.png'), undefined, 'a listed image the store no longer has is asked for afresh');
  assert.equal(imageVersion('/api/import/library/a-modeled.png'), 'v2');
  rememberImageVersions([{ image: '/api/import/library/a-modeled.png', imageVersions: {} }]);
  assert.equal(imageVersion('/api/import/library/a-modeled.png'), undefined);
  rememberImageVersions(undefined);
});
