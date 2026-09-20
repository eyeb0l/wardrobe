import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import sharp from 'sharp';
import {createCaptureHarness,externalizeRequest} from './prepare-vision-api-suite.mjs';

test('all five requests are captured through production middleware before generation',async()=>{
  const snapshot=await fs.mkdtemp(path.join(os.tmpdir(),'vision-capture-test-'));
  const ids=Array.from({length:4},(_,i)=>`import-00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`);
  const image=await sharp({create:{width:100,height:160,channels:3,background:'#a98765'}}).png().toBuffer();
  await fs.mkdir(path.join(snapshot,'imported'));await fs.mkdir(path.join(snapshot,'outfit-images'));
  const items=ids.map((id,i)=>({id,name:`Test garment ${i}`,part:i<2?'upperbody':'lowerbody',color:'#a98765',secondaryColor:null,tags:['plain'],image:`/api/import/library/${id}-garment.png`}));
  for(const item of items)await fs.writeFile(path.join(snapshot,'imported',`${item.id}-garment.png`),image);
  await fs.writeFile(path.join(snapshot,'library.json'),JSON.stringify(items));
  await fs.writeFile(path.join(snapshot,'model-reference.png'),image);
  await fs.writeFile(path.join(snapshot,'outfit-images','example.png'),image);
  await fs.writeFile(path.join(snapshot,'outfits.json'),JSON.stringify({version:1,outfits:[{id:'example',name:'Example',image:'outfit-images/example.png',status:'accepted',garmentIds:[ids[0],ids[2]],setting:'Plain room',occasion:['casual'],reason:'Example'}]}));
  const originalFetch=globalThis.fetch;
  globalThis.fetch=()=>{throw new Error('Network transport escaped interception');};
  let harness;
  try{
    harness=await createCaptureHarness({snapshot});
    const detection=await harness.captureDetection(`data:image/png;base64,${image.toString('base64')}`);
    const curation=await harness.captureCuration('Three distinct looks');
    const shopping=await harness.captureShopping(`data:image/jpeg;base64,${(await sharp(image).jpeg().toBuffer()).toString('base64')}`,'Assess the top',items);
    const scene=await harness.captureScene(items[0],'Different setting');
    const accessories=await harness.captureAccessories('example');
    assert.deepEqual([detection,curation,shopping,scene,accessories].map(x=>x.text.format.name),['wardrobe_items','wardrobe_outfits','wardrobe_shopping_assessment','wardrobe_modeled_setting','outfit_accessories']);
    for(const request of [detection,curation,shopping,scene,accessories]){
      assert.equal(request.model,'gpt-5.6-luna');assert.equal(request.text.format.strict,true);
      const images=request.input.flatMap(x=>x.content).filter(x=>x.type==='input_image');
      assert.ok(images.length>0);assert.ok(images.every(x=>x.image_url.startsWith('data:image/')));
      assert.ok(images.every(x=>x.detail===([detection,scene].includes(request)?undefined:'high')));
    }
    assert.equal(curation.text.format.schema.properties.outfits.minItems,3);
    assert.equal(shopping.store,false);
    assert.match(scene.input[0].content[0].text,/Different setting/);
    assert.equal((JSON.parse(await fs.readFile(path.join(snapshot,'outfits.json'),'utf8'))).outfits.length,1);
  } finally{await harness?.close();globalThis.fetch=originalFetch;await fs.rm(snapshot,{recursive:true,force:true});}
});

test('externalized production images round-trip byte-for-byte and preserve detail',async()=>{
 const out=await fs.mkdtemp(path.join(os.tmpdir(),'vision-externalize-'));
 try{
  const bytes=Buffer.from('image bytes'),hashes={};
  const original={input:[{role:'user',content:[{type:'input_text',text:'Unchanged'},{type:'input_image',image_url:`data:image/png;base64,${bytes.toString('base64')}`,detail:'high'}]}]};
  const result=await externalizeRequest(original,out,hashes),image=result.input[0].content[1];
  assert.equal(image.detail,'high');assert.equal(image.mime_type,'image/png');assert.equal(image.image_url,undefined);
  assert.deepEqual(await fs.readFile(path.join(out,image.image_path)),bytes);
  assert.equal(hashes[image.image_path],createHash('sha256').update(bytes).digest('hex'));
  assert.ok(original.input[0].content[1].image_url);
 }finally{await fs.rm(out,{recursive:true,force:true});}
});
