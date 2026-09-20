import test from 'node:test';
import assert from 'node:assert/strict';
import {detectionMetrics,summary,evaluateAttempt} from './score-vision-api-eval.mjs';
const box={x:100,y:100,width:200,height:400};
const gold={items:[{part:'upperbody',box}],clean:false};
const item={part:'upperbody',boundingBox:box};
test('exact box, duplicate and missing item',()=>{
 assert.equal(detectionMetrics({items:[item],isCleanProductShot:false},gold).objectiveAccepted,true);
 assert.equal(detectionMetrics({items:[item,item],isCleanProductShot:false},gold).precision,.5);
 assert.equal(detectionMetrics({items:[],isCleanProductShot:false},gold).recall,0);
});
test('one-to-one matching uses geometry for same-category objects',()=>{
 const a={...box,x:600};const g={...gold,items:[...gold.items,{part:'upperbody',box:a}]};
 assert.equal(detectionMetrics({items:[{...item,boundingBox:a},item],isCleanProductShot:false},g).meanIoU,1);
});
test('small overlap is not a detection; full-person box not acceptable',()=>{
 const tiny=detectionMetrics({items:[{...item,boundingBox:{...box,x:299}}],isCleanProductShot:false},gold);
 assert.equal(tiny.precision,0);assert.equal(tiny.objectiveAccepted,false);
 const whole=detectionMetrics({items:[{...item,boundingBox:{x:0,y:0,width:1000,height:1000}}],isCleanProductShot:false},gold);
 assert.equal(whole.boxScores[0].coverage,1);assert.equal(whole.objectiveAccepted,false);
});
test('coverage catches clipping despite sufficient IoU',()=>{
 const m=detectionMetrics({items:[{...item,boundingBox:{...box,width:160}}],isCleanProductShot:false},gold);
 assert.equal(m.precision,1);assert.equal(m.boxesUsable,false);
});
test('optional label and explicit ambiguities do not require an extra item',()=>{
 const g={items:[{...gold.items[0],acceptableParts:['upperbody','wholebody_up']},{part:'accessories_up',box:{x:0,y:0,width:5,height:5},required:false}],clean:false,acceptableClean:[true,false]};
 assert.equal(detectionMetrics({items:[{...item,part:'wholebody_up'}],isCleanProductShot:true},g).objectiveAccepted,true);
});
test('empty negative succeeds; hallucinated item fails',()=>{
 const g={items:[],clean:false};assert.equal(detectionMetrics({items:[],isCleanProductShot:false},g).objectiveAccepted,true);
 assert.equal(detectionMetrics({items:[item],isCleanProductShot:false},g).objectiveAccepted,false);
});
test('deadline and schema failure cannot receive subjective acceptance',()=>{
 const c={id:'x',task:'scene',timeoutMs:30,request:{text:{format:{schema:{type:'object',required:['setting'],properties:{setting:{type:'string'}}}}}}};
 const a={httpStatus:200,response:{apiStatus:'completed',parsed:{setting:'valid'}},latencyMs:31,reservedNanoUsd:100};
 assert.equal(evaluateAttempt(c,a,{}, {ratings:[4],criticalFlags:[]}).accepted,false);
 a.latencyMs=20;assert.equal(evaluateAttempt(c,a,{},null).accepted,null);
 a.response.parsed={};assert.equal(evaluateAttempt(c,a,{}, {ratings:[4],criticalFlags:[]}).quality,0);
});
test('failed costs stay in acceptable-answer numerator and pending results prevent ranking',()=>{
 const rows=[{config:'x',task:'scene',accepted:true,quality:100,costLowerUsd:.1,costUpperUsd:.2,latencyMs:10},{config:'x',task:'scene',accepted:false,quality:0,costLowerUsd:.1,costUpperUsd:.2,latencyMs:30}];
 assert.equal(summary(rows).x.costPerAcceptableUpperUsd,.4);assert.equal(summary(rows).x.weightedQuality,50);
 rows[1].accepted=null;rows[1].quality=null;assert.equal(summary(rows).x.weightedAcceptance,null);
});

test('valid threshold matches outweigh several tiny required overlaps',()=>{
 const rect=(x,width)=>({x,y:0,width,height:100});
 const g={clean:false,items:[{part:'accessories_up',box:rect(690,238)},{part:'accessories_up',box:rect(439,179)}]};
 const value={isCleanProductShot:false,items:[{part:'accessories_up',boundingBox:rect(404,296)},{part:'accessories_up',boundingBox:rect(335,145)}]};
 const result=detectionMetrics(value,g);
 assert.equal(result.precision,.5);assert.equal(result.recall,.5);
 assert.deepEqual(result.pairs.map(p=>p.slice(0,2)),[[0,1]]);
 assert.equal(result.meanIoU,(179/296)/2,'missing reference object contributes zero to mean IoU');
});

test('required threshold matches take priority over optional threshold matches',()=>{
 const g={clean:false,items:[{part:'upperbody',box:{...box,width:150}},{part:'upperbody',box,required:false}]};
 const result=detectionMetrics({isCleanProductShot:false,items:[item]},g);
 assert.equal(result.recall,1);assert.equal(result.pairs[0][1],0);
});

const attempt=value=>({httpStatus:200,response:{apiStatus:'completed',parsed:value},latencyMs:1,reservedNanoUsd:0});
const fixture=(task,annotations={})=>({id:'runtime',task,timeoutMs:100,annotations,request:{text:{format:{schema:{type:'object'}}}}});
const grade=(n)=>({ratings:Array(n).fill(4),criticalFlags:[]});
const inventory=[{id:'top',part:'upperbody',name:'Blue shirt'},{id:'bottom-1',part:'lowerbody',name:'Black trousers'},{id:'bottom-2',part:'lowerbody',name:'Gray skirt'},{id:'outer',part:'wholebody_up',name:'Beige coat'}];
const outfit=(n)=>({id:`look-${n}`,name:'Look',occasion:['casual'],garmentIds:['top',`bottom-${n}`],reason:'Supported reason',setting:'A quiet room',outerLayerConstruction:'none',outerLayerNote:''});

test('all required criterion ratings must be supplied',()=>{
 const c=fixture('scene');
 assert.throws(()=>evaluateAttempt(c,attempt({setting:'A quiet room'}),{},grade(1)),/Invalid blind grade/);
 assert.equal(evaluateAttempt(c,attempt({setting:'A quiet room'}),{},grade(4)).accepted,true);
});

test('curation rejects invalid or repeated outfit IDs and blank runtime text',()=>{
 const c=fixture('curation',{expectedCount:2,excludedPairs:[]});
 const evaluate=value=>evaluateAttempt(c,attempt(value),{},grade(4),inventory);
 const valid={outfits:[outfit(1),outfit(2)]};assert.equal(evaluate(valid).accepted,true);
 for(const change of [value=>{value.outfits[1].id='look-1';},value=>{value.outfits[0].id='Invalid ID';},value=>{value.outfits[0].reason=' ';},value=>{value.outfits[0].occasion=[' '];},value=>{value.outfits[0].garmentIds.push('outer');value.outfits[0].outerLayerConstruction='full-front-opening';value.outfits[0].outerLayerNote=' ';}]){
  const value=structuredClone(valid);change(value);assert.equal(evaluate(value).accepted,false);
 }
});

test('scene and accessories enforce production trimming, uniqueness and single lines',()=>{
 assert.equal(evaluateAttempt(fixture('scene'),attempt({setting:'   '}),{},grade(4)).accepted,false);
 for(const suggestions of [['Gold hoops',' gold HOOPS '],['Gold hoops',' '],['Gold hoops','Small bag\nfor contrast']])assert.equal(evaluateAttempt(fixture('accessories'),attempt({suggestions}),{},grade(4)).accepted,false);
 assert.equal(evaluateAttempt(fixture('accessories'),attempt({suggestions:[' Gold hoops ','Small bag']}),{},grade(4)).accepted,true);
});

test('shopping accepts production ITEM repair but rejects unknown labels and blank prose',()=>{
 const c=fixture('shopping');c.request.text.format.schema.properties={summary:{type:'string',maxLength:20}};
 const valid={itemName:'Candidate',verdict:'consider',summary:'Use with ITEM 1',personalFit:'Visual harmony',wardrobeFit:'Useful contrast',overlap:'Similar shirt',watchOuts:[],pairings:[{itemIds:['bottom-1'],reason:'Tonal contrast'}]};
 const evaluate=value=>evaluateAttempt(c,attempt(value),{},grade(5),inventory);
 assert.equal(evaluate(valid).accepted,true);
 assert.equal(evaluate({...valid,summary:'Use with ITEM 999'}).accepted,false);
 assert.equal(evaluate({...valid,personalFit:'   '}).accepted,false);
 c.request.text.format.schema.properties.summary.maxLength=16;
 assert.equal(evaluate(valid).accepted,false,'name expansion can exceed production prose limit');
});

test('predeclared full detection alternatives resolve genuinely ambiguous construction',()=>{
 const top={x:100,y:100,width:200,height:200},bottom={x:100,y:300,width:200,height:200};
 const g={variants:[{clean:false,items:[{part:'upperbody',box:top},{part:'lowerbody',box:bottom}]},{clean:false,items:[{part:'dresses',box}]}]};
 const dress=detectionMetrics({isCleanProductShot:false,items:[{part:'dresses',boundingBox:box}]},g);
 assert.equal(dress.objectiveAccepted,true);assert.equal(dress.chosenVariant,1);
 const separates=detectionMetrics({isCleanProductShot:false,items:[{part:'upperbody',boundingBox:top},{part:'lowerbody',boundingBox:bottom}]},g);
 assert.equal(separates.objectiveAccepted,true);assert.equal(separates.chosenVariant,0);
 const neither=detectionMetrics({isCleanProductShot:false,items:[{part:'shoes',boundingBox:box}]},g);
 assert.equal(neither.objectiveAccepted,false);assert.equal(neither.chosenVariant,0,'ties deterministically retain first frozen alternative');
 assert.throws(()=>detectionMetrics({items:[]},{variants:[]}),/nonempty frozen array/);
});

test('a fully usable frozen alternative wins before continuous objective score',()=>{
 const g={variants:[{clean:false,items:[{part:'upperbody',box:{...box,width:250}}]},{clean:false,items:[{part:'upperbody',box}]}]};
 const result=detectionMetrics({isCleanProductShot:false,items:[item]},g);
 assert.equal(result.objectiveAccepted,true);assert.equal(result.chosenVariant,1);
});
