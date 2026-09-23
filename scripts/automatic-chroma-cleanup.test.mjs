import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { automaticChromaCleanup, inspectFinishedCutout, inspectPreservation } from './automatic-chroma-cleanup.mjs';
import { processChromaBackground } from './chroma-processing.mjs';
const raster = async (fn, size = 96) => {
  const bytes = Buffer.alloc(size * size * 4);
  for (let y=0;y<size;y++) for(let x=0;x<size;x++) bytes.set(fn(x,y),4*(y*size+x));
  return sharp(bytes,{raw:{width:size,height:size,channels:4}}).png().toBuffer();
};

test('one intense green pixel fails final-image verification, including partial alpha', async () => {
  for (const alpha of [255, 96, 12]) {
    const image = await raster((x,y) => x===10&&y===10 ? [0,255,0,alpha] : x>20&&x<75&&y>20&&y<75 ? [240,240,240,255] : [0,0,0,0]);
    const result = await inspectFinishedCutout(image,'#00ff00');
    assert.equal(result.contaminatedPixels,1);
    assert.equal(result.regions.length,1);
  }
});

test('automatic search reaches 110 to remove near-key clusters without eroding the item', async () => {
  const source = await raster((x,y) => x>=8&&x<16&&y>=8&&y<16 ? [7,242,7,255] : x>25&&x<75&&y>25&&y<75 ? [240,240,240,255] : [0,255,0,255]);
  const result = await automaticChromaCleanup(source,'#00ff00');
  assert.equal(result.tolerance,110);
  assert.deepEqual(result.attempts.map(a=>a.tolerance),[46,62,78,94,110]);
  assert.equal(result.diagnostics.contaminatedPixels,0);
  assert.equal(result.diagnostics.clean,true);
  assert.equal(result.diagnostics.preservation.protectedChanged,0);
  assert.equal(result.diagnostics.preservation.safe,true);
});

test('clean cutouts stop at the gentlest setting and keep contrasting detached details', async () => {
  const source = await raster((x,y) => x>20&&x<75&&y>20&&y<75 ? [230,230,230,255] : x>=8&&x<12&&y>=8&&y<12 ? [220,20,80,255] : [0,255,0,255]);
  const result = await automaticChromaCleanup(source,'#00ff00');
  assert.equal(result.tolerance,46);
  assert.equal(result.attempts.length,1);
  assert.equal(result.diagnostics.clean,true);
});

test('existing alpha, lace openings, thin straps and coloured trim are not repaired', async () => {
  const source = await raster((x,y) => {
    if (x===30&&y>9&&y<25) return [210,70,30,255];
    if(x>20&&x<75&&y>25&&y<75) return (x+y)%7===0 ? [0,0,0,0] : x<24 ? [0,255,0,255] : [210,70,30,128];
    return [0,0,0,0];
  });
  const reference = await processChromaBackground(source,'#00ff00');
  const result = await automaticChromaCleanup(source,'#00ff00');
  assert.deepEqual(result.bytes,reference.bytes);
  assert.equal(result.diagnostics.repairedPixels,0);
});

test('ambiguous key-like fabric requires review rather than automatic acceptance', async () => {
  const source = await raster((x,y) => x>20&&x<75&&y>20&&y<75 ? [5,240,235,255] : [0,255,255,255]);
  const result = await automaticChromaCleanup(source,'#00ffff');
  assert.equal(result.diagnostics.clean,false);
  assert.equal(result.diagnostics.preservation.protectedChanged,0);
});

test('preservation rejects erased pieces and altered opaque interiors', () => {
  const width=32,height=32,raw=Buffer.alloc(width*height*4);
  for(let y=4;y<28;y++)for(let x=4;x<28;x++)raw.set([240,240,240,255],4*(y*width+x));
  const baseline={info:{width,height},raw};
  const recoloured=Buffer.from(raw);recoloured[4*(16*width+16)]=10;
  assert.equal(inspectPreservation(baseline,{raw:recoloured}).safe,false);
  const erased=Buffer.from(raw);erased.fill(0);
  const result=inspectPreservation(baseline,{raw:erased});
  assert.equal(result.safe,false);assert.equal(result.missingComponents,1);
});
