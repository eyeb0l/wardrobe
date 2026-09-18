import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initBackup, openBackup, withBackupLock, exportBackup, verifyBackup, readSnapshot, listSnapshots, restoreLocal, restoreCloud, backupStatus, pruneBackups } from './backup-core.mjs';
import { parseBackupArgs } from './wardrobe-backup.mjs';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'wardrobe-backup-test-'));
  t.after(() => fs.rm(dir,{recursive:true,force:true}));
  const opts = { repo:path.join(dir,'backup'), keyFile:path.join(dir,'key') };
  await initBackup(opts); const repo = await openBackup(opts);
  const data = new Map([
    ['library.json',Buffer.from(JSON.stringify([{id:'a',name:'Changed name',hidden:true,_editVersion:'preserved',image:'/api/import/library/a.png'}]))],
    ['outfits.json',Buffer.from('{"outfits":[]}')],
    ['imported/a.png',Buffer.from([0,1,2,3,4])],
    ['jobs/old/source.png',Buffer.from([0,6,7,8,9])],
    ['.api-usage.json',Buffer.from('{"day":"2026-09-18","calls":4}')],
    ['.blob-gc-state.json',Buffer.from('{}')],
  ]);
  let leased = false, blobReads = 0, replacements = 0;
  const urls = new Map();
  const inventory = () => [{path:'/wardrobe-data',kind:'dir',text_content:null,blob_url:null,size:0,updated_at:'2026-09-18'},...Array.from(data,([name,bytes]) => {
    const binary = name.endsWith('.png'), url = binary ? `https://private.invalid/${name}` : null;
    if(binary)urls.set(url,bytes);
    return {path:`/wardrobe-data/${name}`,kind:'file',text_content:binary?null:bytes.toString(),blob_url:url,size:bytes.length,updated_at:'2026-09-18'};
  })];
  const store = {
    async withLease(fn){ if(leased)return fn(); leased=true;try{return await fn();}finally{leased=false;} },
    async assertLease(){assert.ok(leased)},
    async backupInventory(){assert.ok(leased);return inventory()},
    async readBackupBlob(url){assert.ok(leased);blobReads++;return urls.get(url)},
    async replaceFromBackup(files){assert.ok(leased);replacements++;data.clear();for(const f of files)data.set(f.path.slice('/wardrobe-data/'.length),f.bytes)},
  };
  return {dir,opts,repo,store,data,counts:()=>({blobReads,replacements})};
}

test('encrypted full snapshots preserve all data and reuse verified immutable images',async t=>{
  const f=await fixture(t);
  const first=await exportBackup(f.repo,f.store,{now:new Date('2026-09-18T01:00:00Z')});
  assert.equal(first.downloadedFiles,2); assert.equal(first.files,5);
  const manifest=await readSnapshot(f.repo); assert.equal(manifest.files.some(x=>x.name==='.blob-gc-state.json'),false);
  const second=await exportBackup(f.repo,f.store,{now:new Date('2026-09-18T02:00:00Z')});
  assert.equal(second.downloadedFiles,0); assert.equal(second.reusedFiles,2);assert.equal(f.counts().blobReads,2);
  assert.equal((await verifyBackup(f.repo)).files,5);
  for(const name of await fs.readdir(path.join(f.opts.repo,'objects')))assert.equal((await fs.readFile(path.join(f.opts.repo,'objects',name))).includes(Buffer.from('Changed name')),false);
  const out=path.join(f.dir,'restored'); await restoreLocal(f.repo,{out});
  assert.deepEqual(await fs.readFile(path.join(out,'library.json')),f.data.get('library.json'));
  assert.deepEqual(await fs.readFile(path.join(out,'jobs/old/source.png')),f.data.get('jobs/old/source.png'));
  await assert.rejects(restoreLocal(f.repo,{out}),/existing/);
  await assert.rejects(restoreLocal(f.repo,{out:path.join(f.opts.repo,'restore')}),/outside/);
  assert.equal((await backupStatus(f.repo,{now:new Date('2026-09-21')})).healthy,false);
});

test('wrong key, damaged encrypted bytes and interrupted downloads never count as a completed backup',async t=>{
  const f=await fixture(t);const first=await exportBackup(f.repo,f.store);
  const wrong=path.join(f.dir,'wrong');await fs.writeFile(wrong,Buffer.alloc(32,9).toString('base64'));
  await assert.rejects(openBackup({...f.opts,keyFile:wrong}),/authentication/);
  const manifest=await readSnapshot(f.repo), file=manifest.files.find(f=>f.sourceId);
  const object=path.join(f.opts.repo,'objects',`${file.sha256}.bin`), bytes=await fs.readFile(object);bytes[bytes.length-1]^=1;await fs.writeFile(object,bytes);
  await assert.rejects(verifyBackup(f.repo),/authentication/);
  await assert.rejects(exportBackup(f.repo,f.store),/authentication/);
  assert.deepEqual(await listSnapshots(f.repo),[first.snapshot]);
  await assert.rejects(pruneBackups(f.repo,{apply:true}),/authentication/);
  const g=await fixture(t);g.store.readBackupBlob=()=>{throw new Error('connection lost')};
  await assert.rejects(exportBackup(g.repo,g.store),/connection lost/);assert.deepEqual(await listSnapshots(g.repo),[]);
});

test('local lock, symlink protection and changed inventory fail closed',async t=>{
  const f=await fixture(t);
  await withBackupLock(f.repo,async()=>{await assert.rejects(withBackupLock(f.repo,async()=>{}),/owns/)});
  const original=f.store.backupInventory;let reads=0;
  f.store.backupInventory=async()=>{const rows=await original();if(++reads===2)rows[1].updated_at='changed';return rows};
  await assert.rejects(exportBackup(f.repo,f.store),/changed/);assert.equal((await listSnapshots(f.repo)).length,0);
  const g=await fixture(t);await exportBackup(g.repo,g.store);const m=await readSnapshot(g.repo);const object=path.join(g.opts.repo,'objects',`${m.files[0].sha256}.bin`);
  const originalBytes=await fs.readFile(object);const linked=path.join(g.dir,'outside');await fs.writeFile(linked,originalBytes);await fs.unlink(object);await fs.symlink(linked,object);
  await assert.rejects(verifyBackup(g.repo));
});

test('cloud restore requires reviewed destination, backs it up, and preserves higher current paid count',async t=>{
  const f=await fixture(t);const before=await exportBackup(f.repo,f.store);
  f.data.set('library.json',Buffer.from('[{"id":"new"}]'));
  f.data.set('.api-usage.json',Buffer.from('{"day":"2026-09-18","calls":19}'));
  const review=await restoreCloud(f.repo,f.store,{snapshot:before.snapshot});assert.equal(review.applied,false);assert.equal(f.counts().replacements,0);
  await assert.rejects(restoreCloud(f.repo,f.store,{snapshot:before.snapshot,apply:true,replace:true,expectDestination:'bad'}),/Destination/);
  await assert.rejects(restoreCloud(f.repo,f.store,{snapshot:before.snapshot,apply:true,expectDestination:review.destinationFingerprint}),/replace/);
  const result=await restoreCloud(f.repo,f.store,{snapshot:before.snapshot,apply:true,replace:true,expectDestination:review.destinationFingerprint});
  assert.ok(result.safetySnapshot);assert.equal(f.counts().replacements,1);assert.equal(JSON.parse(f.data.get('.api-usage.json')).calls,19);
  assert.equal(JSON.parse(f.data.get('library.json'))[0].name,'Changed name');
  assert.equal((await listSnapshots(f.repo)).length,2);
});

test('retention keeps dated history and surviving snapshots remain fully restorable',async t=>{
  const f=await fixture(t);let old;
  for(const date of ['2025-01-01','2025-12-10','2026-02-10','2026-04-10','2026-07-10','2026-08-10','2026-09-01','2026-09-10','2026-09-12','2026-09-13','2026-09-14','2026-09-15','2026-09-16','2026-09-17','2026-09-18']) {
    f.data.set('history.json',Buffer.from(JSON.stringify({date})));
    const r=await exportBackup(f.repo,f.store,{now:new Date(`${date}T00:00:00Z`)});old||=r.snapshot;
  }
  const preview=await pruneBackups(f.repo,{now:new Date('2026-09-18T01:00:00Z')});assert.ok(preview.removedSnapshots>0);
  assert.equal((await listSnapshots(f.repo)).length,15);
  await pruneBackups(f.repo,{apply:true,now:new Date('2026-09-18T01:00:00Z')});assert.equal((await listSnapshots(f.repo)).includes(old),false);
  for(const id of await listSnapshots(f.repo))await verifyBackup(f.repo,id);
  await restoreLocal(f.repo,{out:path.join(f.dir,'after-prune')});
});

test('CLI rejects dangerous accidental flag combinations',()=>{
  const base=['--repo','/tmp/a','--key-file','/tmp/key'];
  assert.throws(()=>parseBackupArgs(['export',...base,'--replace']),/not valid/);
  assert.throws(()=>parseBackupArgs(['restore',...base,'--apply']),/Local/);
  assert.throws(()=>parseBackupArgs(['restore',...base,'--target','cloud','--replace']),/requires/);
  assert.equal(parseBackupArgs(['restore',...base,'--out','/tmp/new']).target,'local');
});


test('cloud paths that collide on macOS never publish a completed snapshot',async t=>{
  const f=await fixture(t);f.data.set('COLLISION',Buffer.from('a'));f.data.set('collision/x',Buffer.from('b'));
  await assert.rejects(exportBackup(f.repo,f.store),/conflicts/);assert.deepEqual(await listSnapshots(f.repo),[]);
});
