import test from 'node:test';
import assert from 'node:assert/strict';
import { validate, iou, score, aggregate } from './score-vision-benchmark.mjs';

test('schema checks reject wrong shapes, overflow lengths, unknown keys and invalid unions',()=>{
 const schema={type:'object',required:['items'],additionalProperties:false,properties:{items:{type:'array',minItems:1,maxItems:2,items:{anyOf:[{type:'string',maxLength:3,pattern:'^a'},{type:'null'}]}}}};
 assert.deepEqual(validate(schema,{items:['abc',null]}),[]);
 for(const value of [null,{}, {items:[]},{items:['abcd']},{items:[false]},{items:['abc'],extra:1}]) assert.ok(validate(schema,value).length);
});
test('IoU is scale-independent and penalizes loose and disjoint boxes',()=>{
 const a={x:10,y:10,width:20,height:20};
 assert.equal(iou(a,a),1);
 assert.equal(iou(a,{x:0,y:0,width:40,height:40}),.25);
 assert.equal(iou(a,{x:60,y:60,width:20,height:20}),0);
});
test('outfit and shopping hard errors are retained independently from JSON shape',()=>{
 const inventory=[{id:'top',part:'upperbody'},{id:'bottom',part:'lowerbody'},{id:'candidate',part:'upperbody'}];
 const suite={inventory,excludedPairs:[['top','bottom']],cases:[{id:'curate',task:'curation',schema:{type:'object'}},{id:'shopping-empty',task:'shopping',schema:{type:'object'}},{id:'shopping-duplicate',task:'shopping',schema:{type:'object'}}]};
 const results={curate:{outfits:[{garmentIds:['top','bottom'],outerLayerConstruction:'none'}]},'shopping-empty':{verdict:'good-addition',pairings:[{itemIds:['fake']}]},'shopping-duplicate':{verdict:'skip',pairings:[{itemIds:['candidate']}]}};
 const out=score(suite,{},results);
 assert.equal(out.schemaPasses,3);
 assert.ok(out.criticalFlags.some(x=>x.includes('excluded/repeated')));
 assert.ok(out.criticalFlags.some(x=>x.includes('wrong outfit count')));
 assert.ok(out.criticalFlags.some(x=>x.includes('must be unclear')));
 assert.ok(out.criticalFlags.some(x=>x.includes('unowned')));
 assert.ok(out.criticalFlags.some(x=>x.includes('identical owned copy')));
});
test('detection score matches categories one-to-one and catches false-clean separately',()=>{
 const box={x:100,y:100,width:800,height:800};
 const suite={inventory:[],cases:[{id:'d',task:'detection',schema:{type:'object'}}]};
 const rubric={detection:{d:{parts:['shoes'],boxes:[box],clean:false}}};
 const good={d:{items:[{part:'shoes',boundingBox:box,tags:['strap']}],isCleanProductShot:false}};
 assert.equal(score(suite,rubric,good).cases.d.detection.objectivePoints,80);
 const bad=structuredClone(good);bad.d.items.push(structuredClone(bad.d.items[0]));bad.d.isCleanProductShot=true;
 const result=score(suite,rubric,bad);
 assert.equal(result.cases.d.detection.categoryF1,2/3);
 assert.ok(result.criticalFlags.some(x=>x.includes('false clean')));
});
test('aggregation averages within tasks and preserves critical failures beside quality',()=>{
 const suite={cases:[{id:'one',task:'scene'},{id:'two',task:'scene'},{id:'three',task:'accessories'}]};
 const rubric={weights:{scene:80,accessories:20},criteria:{scene:['one'],accessories:['one']}};
 const checks={x:{schemaPasses:3,criticalFlags:['mechanical'],cases:{}}};
 const grades={x:{one:{ratings:[4],criticalFlags:[],notes:'a'},two:{ratings:[0],criticalFlags:[],notes:'b'},three:{ratings:[4],criticalFlags:['fabrication'],notes:'c'}}};
 const result=aggregate(suite,rubric,checks,grades).x;
 assert.equal(result.quality,60);
 assert.deepEqual(result.criticalFlags,['mechanical','three: fabrication']);
 assert.equal(result.measuredApiCost,null);
 grades.x.three.ratings=[5];
 assert.throws(()=>aggregate(suite,rubric,checks,grades),/Invalid ratings/);
});
