import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { API, harness } from './test-helpers/outfit-harness.mjs';
import { publicLibraryItem } from './wardrobe-library.mjs';
import { garmentWearHistory } from '../shared/outfit-shortlist.mjs';
import { validateManifest } from './outfit-storage.mjs';

const collection = h => h.request('GET', API);
const log = async (h, ids = ['top-1','bottom-1']) => (await h.request('POST', `${API}/garment-wears`, { requestId: randomUUID(), date: '2026-01-04', garmentIds: ids, timezoneOffset: 0 })).event;
const save = (h, entry, body, status = 200, headers) => h.request('POST', `${API}/garment-wears/${entry.id}/look`, body, status, headers);
async function input(h, entry, extra = {}) {
  const garmentIds = extra.garmentIds || entry.garmentIds;
  const library = JSON.parse(await readFile(path.join(h.dataDir, 'library.json'), 'utf8'));
  return { requestId: randomUUID(), name: 'An everyday combination', occasion: 'Smart casual', garmentIds,
    expectedPieces: garmentIds.map(id => ({ id, revision: publicLibraryItem(library.find(item => item.id === id)).revision })), ...extra };
}

test('worn pieces save independent cutouts without AI and preserve wear, plans, metadata and laundry through Undo', async t => {
  const h = await harness(t, { seed: false, env: { OPENAI_API_KEY: '' } });
  const file = path.join(h.dataDir,'outfits.json'), library = path.join(h.dataDir,'library.json');
  await writeFile(library, JSON.stringify(h.items.map(item => ({ ...item, availability: 'laundry' }))));
  const entry = await log(h, ['shoe-1','bottom-1','top-1']);
  const before = JSON.parse(await readFile(file, 'utf8'));
  before.custom = { keep: true }; before.outfitPlans = [];
  await writeFile(file, JSON.stringify(before));
  const originalLibrary = await readFile(library,'utf8');
  const body = await input(h,entry);
  const result = await save(h,entry,body), look = result.outfit;
  assert.equal(result.created,true); assert.equal(look.imageKind,'cutouts');
  assert.deepEqual(look.garmentIds,['top-1','bottom-1','shoe-1']);
  assert.deepEqual(look.occasion,['smart-casual']);
  assert.equal(look.garmentWearId,entry.id);
  assert.equal(look.wearHistory,undefined); assert.equal(look.favourite,undefined);
  const bytes = await h.request('GET',look.image);
  const meta = await sharp(bytes).metadata();
  assert.equal(meta.width,1024); assert.equal(meta.height,1024);
  assert.notDeepEqual(bytes,h.output);
  const after = await collection(h);
  assert.deepEqual(after.garmentWears,[entry]); assert.deepEqual(after.plans,[]);
  assert.deepEqual(garmentWearHistory(after.outfits,'2026-02-01',after.garmentWears).get('top-1'),{count:1,lastWorn:entry.date});
  await h.request('POST',`${API}/garment-wears/${entry.id}/remove`,{});
  await h.restart();
  assert.deepEqual((await collection(h)).outfits,[look]);
  assert.deepEqual((await collection(h)).garmentWears,[]);
  assert.equal(await readFile(library,'utf8'),originalLibrary);
  assert.deepEqual(JSON.parse(await readFile(file,'utf8')).custom,before.custom);
  assert.equal(h.requests.length,0);
});

test('retries recover the same save after restart and source removal; conflicting request payloads are rejected', async t => {
  const h = await harness(t,{seed:false}); const entry = await log(h);
  const body = await input(h,entry), result = await save(h,entry,body);
  await h.restart();
  assert.deepEqual(await save(h,entry,{...body,garmentIds:[...body.garmentIds].reverse()}),result);
  await save(h,entry,{...body,name:'Changed name'},409);
  await save(h,entry,{...body,occasion:'work'},409);
  const other = await log(h);
  await save(h,other,body,409);
  await h.request('POST',`${API}/garment-wears/${entry.id}/remove`,{});
  assert.deepEqual(await save(h,entry,body),result);
  await save(h,entry,{...body,requestId:randomUUID()},409);
});

test('an exact saved combination opens the existing look and concurrent saves create only one combination',async t=>{
  const h = await harness(t); const entry = await log(h);
  const existing = await save(h,entry,await input(h,entry));
  assert.equal(existing.created,false); assert.equal(existing.outfit.id,'original-1');
  assert.equal(existing.outfit.image,`${API}/images/original-1.png`);
  assert.equal((await collection(h)).outfits.length,6);
  const fresh = await log(h,['top-6','bottom-4']);
  const [a,b] = await Promise.all([save(h,fresh,await input(h,fresh)),save(h,fresh,await input(h,fresh,{name:'Another name'}))]);
  assert.equal(a.outfit.id,b.outfit.id); assert.equal(Number(a.created)+Number(b.created),1);
  assert.equal((await collection(h)).outfits.length,7);
});

test('review can select one complete combination from a larger entry; dress looks and later favourites/planning work',async t=>{
  const h = await harness(t,{seed:false});
  const entry = await log(h,['top-1','top-2','bottom-1','dress-1','shoe-1']);
  const result = await save(h,entry,await input(h,entry,{garmentIds:['dress-1','shoe-1']}));
  assert.deepEqual(result.outfit.garmentIds,['dress-1','shoe-1']);
  await h.request('POST',`${API}/${result.outfit.id}/favourite`,{favourite:true});
  const date = new Date().toISOString().slice(0,10);
  await h.request('POST',`${API}/plans`,{date,outfitId:result.outfit.id,revision:'initial',timezoneOffset:0});
  const current = await collection(h);
  assert.equal(current.outfits[0].favourite,true);
  assert.equal(current.outfits[0].wearHistory,undefined);
  assert.deepEqual(current.garmentWears,[entry]);
  assert.deepEqual(current.plans,[{date,outfitId:result.outfit.id}]);
});

test('invalid, stale, unsupported and out-of-entry choices cannot change the collection',async t=>{
  const h = await harness(t,{seed:false}), entry = await log(h,['top-1','top-2','bottom-1','shoe-1']);
  const body = await input(h,entry,{garmentIds:['top-1','bottom-1']});
  const file = path.join(h.dataDir,'outfits.json'), before = await readFile(file,'utf8');
  for(const changes of [{requestId:'bad'},{requestId:[randomUUID()]},{name:''},{name:'x'.repeat(121)},{occasion:[]},{occasion:''},{garmentIds:[]},{garmentIds:['top-1','top-1']}]) await save(h,entry,{...body,...changes},400);
  await save(h,entry,await input(h,entry,{garmentIds:['top-1','top-2']}),400);
  await save(h,entry,await input(h,entry,{garmentIds:['top-1','bottom-2']}),400);
  await save(h,entry,{...body,expectedPieces:[]},409);
  await save(h,entry,{...body,expectedPieces:body.expectedPieces.map(piece=>({...piece,revision:'stale'}))},409);
  await save(h,entry,body,403,{origin:'https://other.invalid'});
  await save(h,entry,body,415,{'content-type':'text/plain'});
  await writeFile(path.join(h.dataDir,'library.json'),JSON.stringify(h.items.map(item=>item.id==='top-1'?{...item,name:'Changed on another device'}:item)));
  await save(h,entry,body,409);
  for(const flag of ['hidden','deleted']) {
    await writeFile(path.join(h.dataDir,'library.json'),JSON.stringify(h.items.map(item=>item.id==='top-1'?{...item,[flag]:true}:item)));
    await save(h,entry,await input(h,entry,{garmentIds:['top-1','bottom-1']}),409);
  }
  assert.equal(await readFile(file,'utf8'),before); assert.equal(h.requests.length,0);
});

test('missing or corrupt selected cutouts fail before saving, and damaged provenance fails closed',async t=>{
  const h = await harness(t,{seed:false}), entry = await log(h);
  const body = await input(h,entry), image = path.join(h.dataDir,'imported/top-1.png');
  await rm(image); await save(h,entry,body,409);
  await writeFile(image,'invalid'); await save(h,entry,body,409);
  const manifest = {version:1,outfits:[{id:'broken',name:'Broken',status:'accepted',garmentIds:['top-1'],occasion:['casual'],image:'outfit-images/broken.png',garmentWearId:'invalid'}]};
  assert.throws(()=>validateManifest(manifest));
  assert.equal((await collection(h)).outfits.length,0);
});

test('a source Undo racing a save either retains an independent look or rejects the removed entry',async t=>{
  const h = await harness(t,{seed:false}), entry = await log(h), body = await input(h,entry);
  const [saved] = await Promise.all([
    save(h,entry,body,null),
    h.request('POST',`${API}/garment-wears/${entry.id}/remove`,{}),
  ]);
  assert.ok([200,409].includes(saved.status));
  const after = await collection(h);
  assert.deepEqual(after.garmentWears,[]);
  assert.equal(after.outfits.length,saved.status===200?1:0);
  assert.equal(h.requests.length,0);
});
