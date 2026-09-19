import test from 'node:test';
import assert from 'node:assert/strict';
import { immutableByteCache } from './immutable-byte-cache.mjs';

test('immutable bytes coalesce concurrent reads, isolate mutations, and retry failures', async () => {
  const read = immutableByteCache(); let downloads = 0;
  const load = async () => { downloads++; await new Promise(resolve => setImmediate(resolve)); return Buffer.from('original'); };
  const [a,b] = await Promise.all([read('image',load),read('image',load)]);
  assert.equal(downloads,1); a.fill(0); assert.equal(b.toString(),'original');
  assert.equal((await read('image',load)).toString(),'original'); assert.equal(downloads,1);
  await assert.rejects(read('bad',async()=>{throw new Error('offline')}),/offline/);
  assert.equal((await read('bad',async()=>Buffer.from('recovered'))).toString(),'recovered');
});

test('byte and entry limits evict least recently used files; oversized files are not retained',async()=>{
  const read=immutableByteCache({maxBytes:8,maxEntryBytes:5,maxEntries:2});const counts={};
  const get=(key,size=4)=>read(key,async()=>{counts[key]=(counts[key]||0)+1;return Buffer.alloc(size,1)});
  await get('a');await get('b');await get('a');await get('c');await get('b');
  assert.deepEqual(counts,{a:1,b:2,c:1});
  await get('large',6);await get('large',6);assert.equal(counts.large,2);
  const one=immutableByteCache({maxBytes:100,maxEntries:1});let calls=0;
  const load=async()=>{calls++;return Buffer.from('x')};await one('a',load);await one('b',load);await one('a',load);assert.equal(calls,3);
});
