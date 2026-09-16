import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { PGlite } from '@electric-sql/pglite';
import { createCloudStore, CLOUD_ROOT } from './cloud-store.mjs';
import { skillStorage } from './skill-storage.mjs';
import { snapshotForSkill } from './skill-snapshot.mjs';
import { importReviewedClothes } from './import-reviewed-clothes.mjs';
import { saveOutfitCollection } from './save-outfit-collection.mjs';

async function setup(t) {
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'wardrobe-skill-test-')));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const pg=new PGlite();t.after(()=>pg.close());
  const database={query:async(sql,args=[]) => (await pg.query(sql,args)).rows,
    transaction: statements=>pg.transaction(async tx=>{for(const s of statements)await tx.query(s.text,s.values);})};
  const objects=new Map();
  const blob={put:async(name,bytes,opts)=>{assert.equal(opts.access,'private');const url='https://private.test/'+name;objects.set(url,Buffer.from(bytes));return {url};},
    get:async(url,opts)=>{assert.equal(opts.access,'private');return {statusCode:200,stream:new Response(objects.get(url)).body};}};
  const store=createCloudStore({database,blob});await store.initialize();
  const opaque=await sharp({create:{width:60,height:60,channels:4,background:'red'}}).png().toBuffer();
  const cutout=await sharp({create:{width:80,height:80,channels:4,background:{r:0,g:0,b:0,alpha:0}}}).composite([{input:opaque,left:10,top:10}]).png().toBuffer();
  await store.withLease(async()=>{
    await store.mkdir(CLOUD_ROOT+'/imported');await store.mkdir(CLOUD_ROOT+'/outfit-images');
    await store.writeFile(CLOUD_ROOT+'/imported/old.png',cutout);
    await store.writeFile(CLOUD_ROOT+'/model-reference.png',opaque);
    await store.writeFile(CLOUD_ROOT+'/library.json',JSON.stringify([{id:'owned',name:'Old item',image:'/api/import/library/old.png',custom:'keep'}]));
    await store.writeFile(CLOUD_ROOT+'/outfits.json',JSON.stringify({version:1,custom:'keep',outfits:[]}));
  });
  await fs.mkdir(root+'/items');await fs.mkdir(root+'/modeled');await fs.mkdir(root+'/outfit-images');
  await fs.writeFile(root+'/items/piece.png',cutout);await fs.writeFile(root+'/modeled/piece.png',opaque);
  const manifest=root+'/manifest.json';const item={slug:'piece',file:'piece.png',modeledFile:'piece.png',modelReferenceId:'default',name:'New piece',part:'upperbody',color:'#ff0000',status:'accepted'};
  await fs.writeFile(manifest,JSON.stringify({items:[item]}));
  const selected=await skillStorage({target:'cloud',store});
  return {root,store,objects,pg,cutout,opaque,item,manifest,selected,options:{items:root+'/items',modeled:root+'/modeled',manifest,selected},other:()=>createCloudStore({database,blob})};
}

test('target selection is explicit and never falls back to local on cloud failure',async()=>{
  await assert.rejects(skillStorage({}),/Select --target/);
  await assert.rejects(skillStorage({target:'cloud',dataDir:'/tmp/data'}),/cannot be combined/);
});

test('snapshot reads original bytes and metadata without any cloud mutations, rejects reuse and changing data',async t=>{
  const h=await setup(t);const before=await h.pg.query('SELECT * FROM wardrobe_files ORDER BY path');const count=h.objects.size;
  const out=h.root+'/snapshot';const result=await snapshotForSkill({...h.selected,out});
  assert.equal(result.target,'cloud');assert.equal(result.wardrobeCount,1);assert.equal(result.references[0].id,'default');
  assert.deepEqual(await fs.readFile(out+'/imported/old.png'),h.cutout);
  assert.deepEqual(await fs.readFile(out+'/model-reference.png'),h.opaque);
  assert.equal(h.objects.size,count);assert.deepEqual((await h.pg.query('SELECT * FROM wardrobe_files ORDER BY path')).rows,before.rows);
  assert.equal((await h.pg.query('SELECT token FROM wardrobe_storage_lease')).rows[0].token,null);
  await assert.rejects(snapshotForSkill({...h.selected,out}),{code:'EEXIST'});
  const mutable={...h.store,readFile:async(file,...args)=>{const bytes=await h.store.readFile(file,...args);if(file.endsWith('/old.png'))await h.store.withLease(()=>h.store.writeFile(file,h.opaque));return bytes;}};
  await assert.rejects(snapshotForSkill({...h.selected,store:mutable,out:h.root+'/unstable'}),/changed during snapshot/);
  await assert.rejects(fs.stat(h.root+'/unstable/snapshot.json'),{code:'ENOENT'});
});

test('cloud import dry run is read-only, real saves preserve records and reruns reuse originals',async t=>{
  const h=await setup(t);const before=h.objects.size;
  const dry=await importReviewedClothes({...h.options,dryRun:true});assert.equal(dry.total,2);assert.equal(h.objects.size,before);
  assert.equal(JSON.parse(await h.store.readFile(CLOUD_ROOT+'/library.json','utf8')).length,1);
  const saved=await importReviewedClothes(h.options);const records=JSON.parse(await h.store.readFile(CLOUD_ROOT+'/library.json','utf8'));
  assert.equal(records.length,2);assert.equal(records[0].custom,'keep');assert.equal(records[1].modelReferenceId,'default');
  assert.deepEqual(await h.store.readFile(CLOUD_ROOT+'/imported/'+saved.items[0].assetName),h.cutout);
  assert.equal(records[1].modeledImage.endsWith(saved.items[0].modeledAssetName),true);
  const objectCount=h.objects.size;await importReviewedClothes(h.options);
  assert.equal(JSON.parse(await h.store.readFile(CLOUD_ROOT+'/library.json','utf8')).length,2);
  assert.equal(h.objects.size,objectCount,'identical reruns must not upload duplicate images');
  assert.deepEqual(JSON.parse(await h.store.readFile(CLOUD_ROOT+'/library.json','utf8')),records);
  await h.store.withLease(async()=>{
    await assert.rejects(importReviewedClothes({...h.options,selected:{...h.selected,store:h.other()}}),{code:'EBUSY'});
    assert.equal((await importReviewedClothes({...h.options,selected:{...h.selected,store:h.other()},dryRun:true})).total,2);
  });
  await fs.writeFile(h.root+'/modeled/piece.png',Buffer.from('bad'));
  await assert.rejects(importReviewedClothes(h.options));
  assert.equal(JSON.parse(await h.store.readFile(CLOUD_ROOT+'/library.json','utf8')).length,2);
});

test('cloud outfit save is additive, dry-run has no writes, conflicts and stale garments fail',async t=>{
  const h=await setup(t), staged=h.root+'/outfits.json';
  const outfit={id:'reviewed',name:'Reviewed',occasion:['casual'],garmentIds:['owned'],reason:'Original garment',status:'accepted',image:'outfit-images/reviewed.png',modelReferenceId:'default'};
  await fs.writeFile(h.root+'/outfit-images/reviewed.png',h.opaque);await fs.writeFile(staged,JSON.stringify({version:1,outfits:[outfit]}));
  const options={dataDir:CLOUD_ROOT,store:h.store,stagedManifestPath:staged};const count=h.objects.size;
  assert.equal((await saveOutfitCollection({...options,dryRun:true})).added,1);assert.equal(h.objects.size,count);
  assert.equal((await saveOutfitCollection(options)).added,1);assert.equal((await saveOutfitCollection(options)).existing,1);
  const saved=JSON.parse(await h.store.readFile(CLOUD_ROOT+'/outfits.json','utf8'));assert.equal(saved.custom,'keep');
  assert.deepEqual(await h.store.readFile(CLOUD_ROOT+'/outfit-images/'+path.basename(saved.outfits[0].image)),h.opaque);
  await fs.writeFile(staged,JSON.stringify({version:1,outfits:[{...outfit,name:'Conflicting'}]}));await assert.rejects(saveOutfitCollection(options),{status:409});
  await fs.writeFile(staged,JSON.stringify({version:1,outfits:[{...outfit,id:'another',garmentIds:['missing']}]}));await assert.rejects(saveOutfitCollection(options),/no longer in the live wardrobe/);
  assert.deepEqual(JSON.parse(await h.store.readFile(CLOUD_ROOT+'/outfits.json','utf8')),saved);
});

test('local skill import honors the selected directory and never writes repository data',async t=>{
  const h=await setup(t);const dataDir=h.root+'/local-data';
  const selected=await skillStorage({target:'local',repo:h.root,dataDir});
  await importReviewedClothes({...h.options,selected});
  const records=JSON.parse(await fs.readFile(dataDir+'/library.json','utf8'));assert.equal(records.length,1);
  const snapshot=await snapshotForSkill({...selected,out:h.root+'/local-snapshot'});assert.equal(snapshot.wardrobeCount,1);
  await assert.rejects(snapshotForSkill({...selected,out:dataDir+'/snapshot'}),/outside the live data/);
});

test('skill snapshots omit deleted cutouts and cloud outfit saves reject hidden garments',async t=>{
  const h=await setup(t);
  await h.store.withLease(async()=>{
    const records=JSON.parse(await h.store.readFile(CLOUD_ROOT+'/library.json','utf8'));
    records[0].hidden=true;
    await h.store.writeFile(CLOUD_ROOT+'/library.json',JSON.stringify(records));
    await h.store.rm(CLOUD_ROOT+'/imported/old.png');
  });
  const out=h.root+'/hidden-snapshot';
  assert.equal((await snapshotForSkill({...h.selected,out})).wardrobeCount,0);
  assert.deepEqual(JSON.parse(await fs.readFile(out+'/library.json','utf8')),[]);
  const staged=h.root+'/hidden-outfits.json';
  await fs.writeFile(staged,JSON.stringify({version:1,outfits:[{id:'hidden-look',name:'Hidden look',occasion:['casual'],garmentIds:['owned'],reason:'Must not publish',status:'accepted',image:'outfit-images/reviewed.png'}]}));
  await assert.rejects(saveOutfitCollection({dataDir:CLOUD_ROOT,store:h.store,stagedManifestPath:staged}),/no longer in the live wardrobe/);
});
