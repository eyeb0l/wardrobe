import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';
import { wardrobeImportApi } from './import-job-api.mjs';
import { migrateBrowserEdits, EDITS_KEY, DELETED_KEY } from '../src/wardrobe-sync.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(),'wardrobe-sync-')); t.after(()=>rm(root,{recursive:true,force:true}));
  const data = path.join(root,'data'); await mkdir(path.join(data,'imported'),{recursive:true});
  const originals = [
    {id:'outside-1',name:'Original',part:'upperbody',color:'#112233',secondaryColor:null,tags:['cotton'],image:'/api/import/library/item.png',custom:{preserve:true}},
    {id:'outside-2',name:'Second',part:'shoes',color:'#ffffff',tags:[],image:'/api/import/library/shoe.png'},
  ];
  await writeFile(path.join(data,'library.json'),JSON.stringify(originals));
  const connect = async () => {
    const plugin = wardrobeImportApi({serverless:true,readOnly:true,env:{WARDROBE_DATA_DIR:data}});
    await plugin.configResolved({root}); let handler; plugin.configureServer({middlewares:{use(fn){handler=fn}}});
    return async (method='GET',url='/api/import/wardrobe',payload,headers={}) => {
      const req=Readable.from(payload===undefined?[]:[Buffer.from(JSON.stringify(payload))]);
      Object.assign(req,{method,url,headers:{host:'wardrobe.test',origin:'https://wardrobe.test','x-forwarded-proto':'https','sec-fetch-site':'same-origin','content-type':'application/json',...headers}});
      let body;const res={statusCode:200,setHeader(){},end(value){body=JSON.parse(value)}};
      await handler(req,res,()=>assert.fail('Unexpected route'));
      return {status:res.statusCode,body};
    };
  };
  return {connect,data,originals,request:await connect()};
}

test('all editable fields persist across independent clients; stale saves cannot overwrite them',async t=>{
  const h=await fixture(t), a=h.request, b=await h.connect();
  const initial=(await a()).body[0];
  const changes={name:'Edited',part:'dresses',color:'#abcdef',secondaryColor:'#123456',tags:['silk','formal']};
  const saved=await a('PATCH',`/api/import/wardrobe/${initial.id}`,{revision:initial.revision,changes});
  assert.equal(saved.status,200);
  const fresh=(await b()).body[0];
  for(const key of Object.keys(changes)) assert.deepEqual(fresh[key],changes[key]);
  assert.deepEqual(fresh.custom,{preserve:true}); assert.equal(fresh.image,initial.image);
  assert.notEqual(fresh.revision,initial.revision);
  assert.equal((await b('PATCH',`/api/import/wardrobe/${initial.id}`,{revision:initial.revision,changes:{name:'Stale'}})).status,409);
  assert.equal((await b()).body[0].name,'Edited');
  const results=await Promise.all(['One','Two'].map(name=>a('PATCH',`/api/import/wardrobe/${initial.id}`,{revision:fresh.revision,changes:{name}})));
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
});

test('hiding an external item syncs; stale deletion, image injection and cross-site writes are rejected',async t=>{
  const h=await fixture(t);const initial=(await h.request()).body[0],url=`/api/import/wardrobe/${initial.id}`;
  assert.equal((await h.request('DELETE',url,{revision:'stale'})).status,409);
  assert.equal((await h.request('PATCH',url,{revision:initial.revision,changes:{image:'https://unsafe.test/image'}})).status,400);
  assert.equal((await h.request('PATCH',url,{revision:initial.revision,changes:{part:'unknown'}})).status,400);
  assert.equal((await h.request('PATCH',url,{revision:initial.revision,changes:{name:'Bad'}},{origin:'https://foreign.test'})).status,403);
  assert.equal((await h.request('DELETE',url,{revision:initial.revision})).status,200);
  assert.equal((await (await h.connect())()).body.length,1);
  const disk=JSON.parse(await readFile(path.join(h.data,'library.json'),'utf8'));
  assert.equal(disk[0].hidden,true);assert.equal(disk[0].image,initial.image);
});

test('legacy migration is idempotent, keeps shared changes, migrates hides, and never resurrects missing items',async t=>{
  const h=await fixture(t);
  const payload={edits:{'outside-1':{name:'Legacy'},missing:{name:'Deleted'}},deleted:['outside-2','missing']};
  const first=await h.request('POST','/api/import/wardrobe/migrate-edits',payload);assert.equal(first.status,200);
  assert.deepEqual(first.body.migrated,['outside-1','outside-2']);
  const item=(await h.request()).body[0];assert.equal(item.name,'Legacy');
  await h.request('PATCH',`/api/import/wardrobe/${item.id}`,{revision:item.revision,changes:{name:'Shared'}});
  const second=await h.request('POST','/api/import/wardrobe/migrate-edits',payload);
  assert.equal(second.body.migrated.length,0);assert.equal(second.body.skipped.length,2);
  const records=(await h.request()).body;assert.equal(records.length,1);assert.equal(records[0].name,'Shared');
});

test('browser migration retains edits after a failed request and only clears an acknowledged snapshot',async()=>{
  const values=new Map([[EDITS_KEY,JSON.stringify({one:{name:'Legacy'}})],[DELETED_KEY,'[]']]);
  const storage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};
  await assert.rejects(migrateBrowserEdits(storage,async()=>{throw new Error('offline')}),/offline/);
  assert.ok(values.has(EDITS_KEY));
  await migrateBrowserEdits(storage,async()=>{values.set(EDITS_KEY,JSON.stringify({one:{name:'New local edit'}}));return{skipped:[]}});
  assert.ok(values.has(EDITS_KEY),'a newer edit made during upload is kept');assert.ok(!values.has(DELETED_KEY));
  await migrateBrowserEdits(storage,async()=>({skipped:['one']}));
  assert.ok(!values.has(EDITS_KEY));assert.ok(values.has('open-wardrobe-legacy-backup-v1'));
});

test('malformed manifests and legacy edits fail without replacing stored data',async t=>{
  const h=await fixture(t);const file=path.join(h.data,'library.json');
  const before=await readFile(file,'utf8');
  assert.equal((await h.request('POST','/api/import/wardrobe/migrate-edits',{edits:{'outside-1':{tags:['ok',7]}}})).status,400);
  assert.equal(await readFile(file,'utf8'),before);
  await writeFile(file,'{broken');
  assert.ok((await h.request()).status>=400);
  assert.equal(await readFile(file,'utf8'),'{broken');
});
