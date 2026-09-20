// Offline scoring only. Predictions are evidence, never executable instructions.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validate, iou } from './score-vision-benchmark.mjs';

export function coverage(pred, gold) {
  if(!pred||!gold)return 0;
  const intersection=Math.max(0,Math.min(pred.x+pred.width,gold.x+gold.width)-Math.max(pred.x,gold.x))*Math.max(0,Math.min(pred.y+pred.height,gold.y+gold.height)-Math.max(pred.y,gold.y));
  return intersection/(gold.width*gold.height)||0;
}
// Exact one-to-one assignment for the detector's <=8 outputs. Optional gold
// observations accept a visible but ambiguous small accessory without requiring it.
export function matchItems(predictions, labels) {
  if(labels.length>16)throw new Error('Too many reference labels');
  const memo=new Map();
  function best(i,mask) {
    if(i===predictions.length)return {value:0,pairs:[]};
    const key=`${i}:${mask}`;if(memo.has(key))return memo.get(key);
    let result=best(i+1,mask);
    labels.forEach((g,j)=>{
      if(mask&(1<<j)||!(g.acceptableParts||[g.part]).includes(predictions[i].part))return;
      const overlap=iou(predictions[i].boundingBox,g.box);
      if(overlap<=0)return;
      const rest=best(i+1,mask|(1<<j));
      // At most eight predictions: one valid required match outweighs
      // all optional matches; one valid optional match outweighs all IoUs.
      const value=rest.value+overlap+(overlap>=.5?(g.required===false?10:100):0);
      if(value>result.value)result={value,pairs:[[i,j,overlap],...rest.pairs]};
    });memo.set(key,result);return result;
  }
  return best(0,0).pairs;
}
export function detectionMetrics(value, gold) {
  if(gold.variants!==undefined) {
    if(!Array.isArray(gold.variants)||!gold.variants.length)throw Error('Detection variants must be a nonempty frozen array');
    const variants=gold.variants.map((variant,index)=>({...detectionMetrics(value,{...gold,...variant,variants:undefined}),chosenVariant:index}));
    // Ambiguity alternatives are frozen before any predictions. Prefer a
    // fully usable interpretation, then objective quality; stable ties use
    // the first declared alternative, never a newly invented annotation.
    return variants.reduce((best,next)=>{
      if(best.objectiveAccepted!==next.objectiveAccepted)return next.objectiveAccepted?next:best;
      const quality=result=>result.f1+result.meanIoU+Number(result.cleanCorrect);
      return quality(next)>quality(best)?next:best;
    });
  }
  const items=value.items||[],labels=gold.items;
  const pairs=matchItems(items,labels);
  const required=labels.filter(x=>x.required!==false).length;
  const matchedRequired=pairs.filter(([,j])=>labels[j].required!==false);
  const detected=pairs.filter(([, , overlap])=>overlap>=.5);
  const precision=items.length?detected.length/items.length:required?0:1;
  const recall=required?detected.filter(([,j])=>labels[j].required!==false).length/required:1;
  const boxScores=matchedRequired.map(([i,j,overlap])=>({iou:overlap,coverage:coverage(items[i].boundingBox,labels[j].box)}));
  const boxQuality=required?boxScores.reduce((s,x)=>s+x.iou,0)/required:items.length?0:1;
  const boxesUsable=matchedRequired.length===required&&boxScores.every(x=>x.iou>=.5&&x.coverage>=.85);
  const cleanCorrect=(gold.acceptableClean||[gold.clean]).includes(value.isCleanProductShot);
  const boundsValid=items.every(x=>{const b=x.boundingBox;return b&&b.x+b.width<=1000&&b.y+b.height<=1000;});
  return {precision,recall,f1:precision+recall?2*precision*recall/(precision+recall):0,meanIoU:boxQuality,boxesUsable,cleanCorrect,boundsValid,pairs,boxScores,objectiveAccepted:precision===1&&recall===1&&boxesUsable&&cleanCorrect&&boundsValid};
}

export const CRITERION_COUNTS={detection:2,curation:4,shopping:5,scene:4,accessories:4};

export function evaluateAttempt(c, attempt, gold, grade, inventory=[]) {
  const value=attempt.response?.parsed;
  const flags=[];
  const schema=c.request.text.format.schema;
  const schemaErrors=validate(schema,value);
  const completed=attempt.response?.apiStatus==='completed' && attempt.httpStatus>=200&&attempt.httpStatus<300&&!attempt.operationalFailure&&!['unexpected_model','unverified_service_tier','usage_exceeded_reservation'].includes(attempt.failure)&&attempt.latencyMs<=c.timeoutMs;
  const result={caseId:c.id,task:c.task,family:c.family,config:attempt.config,repeat:attempt.repeat,completed,schemaErrors,flags,latencyMs:attempt.latencyMs,costLowerUsd:(attempt.cost?.lowerNanoUsd??0)/1e9,costUpperUsd:(attempt.chargedNanoUsd??attempt.usageUpperNanoUsd??attempt.reservedNanoUsd)/1e9};
  if(!completed||schemaErrors.length){result.accepted=false;result.quality=0;flags.push(!completed?'request_not_completed':'schema_failure');return result;}
  const inv=new Map(inventory.map(x=>[x.id,x]));
  if(c.task==='detection') {
    if(!gold?.items&&!gold?.variants)throw Error(`No frozen gold for ${c.id}`);
    result.detection=detectionMetrics(value,gold);
    if(result.detection.precision!==1||result.detection.recall!==1)flags.push('item_set_error');
    if(value.isCleanProductShot&&!result.detection.cleanCorrect)flags.push('false_clean');
    if(value.items.some(x=>!x.tags.length))flags.push('missing_visible_tags');
    if(!result.detection.boxesUsable)flags.push('unusable_crop');
    if(!result.detection.boundsValid)flags.push('box_out_of_bounds');
  }
  if(c.task==='curation') {
    const seen=new Set((c.annotations?.excludedPairs||[]).map(x=>[...x].sort().join('|')));
    const outfitIds=new Set();
    if(value.outfits.length!==c.annotations.expectedCount)flags.push('wrong_count');
    for(const o of value.outfits) {
      if(!/^[a-z0-9][a-z0-9-]{0,69}$/.test(o.id))flags.push('invalid_outfit_id');
      if(outfitIds.has(o.id))flags.push('duplicate_outfit_id');outfitIds.add(o.id);
      if([o.name,o.reason,o.setting,...o.occasion].some(text=>!text.trim()))flags.push('empty_curation_text');
      if(new Set(o.garmentIds).size!==o.garmentIds.length)flags.push('duplicate_id');
      const items=o.garmentIds.map(id=>inv.get(id));
      if(items.some(x=>!x)){flags.push('unknown_id');continue;}
      for(const p of ['upperbody','lowerbody'])if(items.filter(x=>x.part===p).length!==1)flags.push(`wrong_${p}_count`);
      for(const p of ['wholebody_up','shoes','accessories_up'])if(items.filter(x=>x.part===p).length>1)flags.push(`too_many_${p}`);
      if(items.some(x=>x.part==='dresses'))flags.push('dress_in_top_bottom_task');
      const pair=items.filter(x=>['upperbody','lowerbody'].includes(x.part)).map(x=>x.id).sort().join('|');
      if(seen.has(pair))flags.push('repeated_or_excluded_pair');seen.add(pair);
      const outer=items.find(x=>x.part==='wholebody_up');
      if(outer&&!o.outerLayerNote.trim())flags.push('empty_outer_layer_note');
      if(Boolean(outer)===(o.outerLayerConstruction==='none'))flags.push('outer_construction_mismatch');
      if(outer&&gold?.forbidFullOpeningIds?.includes(outer.id)&&o.outerLayerConstruction==='full-front-opening')flags.push('invented_opening');
    }
  }
  if(c.task==='scene'&&!value.setting.trim())flags.push('empty_scene_setting');
  if(c.task==='accessories') {
    const suggestions=value.suggestions.map(text=>text.trim().toLowerCase());
    if(suggestions.some(text=>!text))flags.push('empty_accessory_suggestion');
    if(value.suggestions.some(text=>/[\r\n]/.test(text)))flags.push('multiline_accessory_suggestion');
    if(new Set(suggestions).size!==suggestions.length)flags.push('duplicate_accessory_suggestion');
  }
  if(c.task==='shopping') {
    // Production resolves valid ITEM labels to actual names before validating
    // prose again. Unknown labels and length overflow after replacement fail.
    const ids=schema.properties?.pairings?.items?.properties?.itemIds?.items?.enum||inventory.map(x=>x.id);
    const prose=[...['itemName','summary','personalFit','wardrobeFit','overlap'].map(key=>[value[key],schema.properties?.[key]?.maxLength??Infinity]),...value.watchOuts.map(text=>[text,350]),...value.pairings.map(p=>[p.reason,500])];
    for(const [text,limit] of prose) {
      if(!text.trim()){flags.push('empty_shopping_text');continue;}
      const named=text.trim().replace(/\bITEM\s+(\d+)\b/gi,(match,number)=>{
        const item=inv.get(ids[Number(number)-1]);
        if(!item){flags.push('unknown_shopping_item_label');return match;}
        return item.name;
      });
      if(named.length>limit)flags.push('expanded_shopping_text_too_long');
    }
    if(gold?.unclear && (value.verdict!=='unclear'||value.pairings.length))flags.push('unclear_candidate_invented');
    for(const p of value.pairings){if(p.itemIds.some(id=>!inv.has(id)))flags.push('unowned_pairing');if(new Set(p.itemIds).size!==p.itemIds.length)flags.push('duplicate_pairing_id');}
  }
  if(!grade){result.accepted=null;result.quality=null;result.reviewPending=true;return result;}
  if(!Array.isArray(grade.ratings)||grade.ratings.length!==CRITERION_COUNTS[c.task]||grade.ratings.some(n=>!Number.isInteger(n)||n<0||n>4)||!Array.isArray(grade.criticalFlags))throw Error(`Invalid blind grade ${c.id}`);
  const rating=grade.ratings.reduce((a,b)=>a+b,0)/grade.ratings.length;
  flags.push(...grade.criticalFlags);
  if(c.task==='detection')result.quality=30*result.detection.f1+30*result.detection.meanIoU+20*Number(result.detection.cleanCorrect)+rating*5;
  else result.quality=rating*25;
  const mechanical=c.task==='detection'?result.detection.objectiveAccepted&&flags.length===0:flags.length===0;
  result.accepted=mechanical&&rating>=3&&grade.ratings.every(n=>n>=2)&&grade.criticalFlags.length===0;
  result.notes=grade.notes;return result;
}

export function summary(rows) {
  const result={};
  const median=a=>a.length?a[Math.floor((a.length-1)/2)]:null;
  for(const config of [...new Set(rows.map(x=>x.config))]) {
    const r=rows.filter(x=>x.config===config),accepted=r.filter(x=>x.accepted===true).length,pending=r.filter(x=>x.accepted===null).length;
    const low=r.reduce((s,x)=>s+x.costLowerUsd,0),high=r.reduce((s,x)=>s+x.costUpperUsd,0);
    const lat=r.map(x=>x.latencyMs).filter(Number.isFinite).sort((a,b)=>a-b);
    result[config]={attempts:r.length,accepted,pending,acceptanceRate:pending?null:accepted/r.length,costLowerUsd:low,costUpperUsd:high,costPerAcceptableLowerUsd:pending||!accepted?null:low/accepted,costPerAcceptableUpperUsd:pending||!accepted?null:high/accepted,medianLatencyMs:median(lat),p95LatencyMs:lat.length?lat[Math.ceil(.95*lat.length)-1]:null,tasks:{}};
    const weights={detection:35,curation:30,shopping:20,scene:10,accessories:5};
    for(const task of [...new Set(r.map(x=>x.task))]){const t=r.filter(x=>x.task===task);result[config].tasks[task]={attempts:t.length,accepted:t.filter(x=>x.accepted===true).length,pending:t.filter(x=>x.accepted===null).length,meanQuality:t.some(x=>x.quality===null)?null:t.reduce((s,x)=>s+x.quality,0)/t.length};}
    const tasks=Object.entries(result[config].tasks);
    result[config].weightedQuality=pending?null:tasks.reduce((s,[k,t])=>s+weights[k]*t.meanQuality,0)/tasks.reduce((s,[k])=>s+weights[k],0);
    result[config].weightedAcceptance=pending?null:tasks.reduce((s,[k,t])=>s+weights[k]*t.accepted/t.attempts,0)/tasks.reduce((s,[k])=>s+weights[k],0);
  }
  return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const [suiteFile,ledgerFile,goldFile,gradeFile,outFile]=process.argv.slice(2);
 if(!outFile)throw Error('Usage: node scripts/score-vision-api-eval.mjs SUITE LEDGER GOLD GRADES OUTPUT');
 const read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
 const [suite,ledger,gold,grades]=await Promise.all([suiteFile,ledgerFile,goldFile,gradeFile].map(read));
 const rows=Object.values(ledger.attempts).map(a=>{const c=suite.cases.find(x=>x.id===a.caseId);if(!c)throw Error('Unknown case');return {attemptId:a.id,...evaluateAttempt(c,a,gold.cases[c.id],grades[a.id],suite.inventory)};});
 await fs.writeFile(outFile,JSON.stringify({rows,summary:summary(rows)},null,2));
 console.log(JSON.stringify(summary(rows),null,2));
}
