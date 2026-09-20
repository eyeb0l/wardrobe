// Deterministic checks for the private Codex pilot. Does not call any model.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function validate(schema, value, location = '$') {
  if (schema.anyOf) return schema.anyOf.some(s => !validate(s, value).length) ? [] : [`${location}: no anyOf match`];
  const errors = [];
  const type = schema.type;
  const valid = type === 'null' ? value === null : type === 'array' ? Array.isArray(value) : type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value) : type === 'integer' ? Number.isInteger(value) : typeof value === type;
  if (type && !valid) return [`${location}: expected ${type}`];
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${location}: invalid enum`);
  if (type === 'object') {
    for (const k of schema.required || []) if (!Object.hasOwn(value,k)) errors.push(`${location}.${k}: missing`);
    for (const [k,v] of Object.entries(value)) {
      if (schema.properties?.[k]) errors.push(...validate(schema.properties[k],v,`${location}.${k}`));
      else if(schema.additionalProperties === false) errors.push(`${location}.${k}: additional property`);
    }
  }
  if (type === 'array') {
    if(value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) errors.push(`${location}: array length`);
    value.forEach((v,i)=>errors.push(...validate(schema.items,v,`${location}[${i}]`)));
  }
  if (type === 'string') {
    if(value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity)) errors.push(`${location}: string length`);
    if(schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${location}: pattern`);
  }
  if (type === 'integer' || type === 'number') if(value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) errors.push(`${location}: numeric range`);
  return errors;
}

export function iou(a,b) {
  if(!a||!b)return 0;
  const overlap=Math.max(0,Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y));
  return overlap/(a.width*a.height+b.width*b.height-overlap)||0;
}

export function score(suite, rubric, results) {
  const inventory=new Map(suite.inventory.map(x=>[x.id,x]));
  const report={cases:{},schemaPasses:0,criticalFlags:[]};
  for(const c of suite.cases) {
    const v=results[c.id];
    const errors=validate(c.schema,v), flags=[];
    const row={schemaErrors:errors};
    if(!errors.length)report.schemaPasses++;
    if(c.task==='detection' && Array.isArray(v?.items)) {
      const gold=rubric.detection[c.id];
      const seen=new Set();let matches=0,totalIou=0;
      for(const [i,item] of v.items.entries()) {
        const index=gold.parts.findIndex((p,j)=>p===item.part&&!seen.has(j));
        if(index>=0){seen.add(index);matches++;totalIou+=iou(item.boundingBox,gold.boxes[index]);}
        const b=item.boundingBox;
        if(b&&(b.x+b.width>1000||b.y+b.height>1000))errors.push(`items[${i}]: box overflows image`);
        if(!item.tags?.length)errors.push(`items[${i}]: prompt requires at least one tag`);
      }
      const f1=!gold.parts.length&&!v.items.length?1:2*matches/(gold.parts.length+v.items.length);
      const boxScore=!gold.parts.length?(v.items.length?0:1):totalIou/gold.parts.length;
      row.detection={categoryF1:f1,meanIoU:boxScore,cleanCorrect:v.isCleanProductShot===gold.clean,objectivePoints:30*f1+30*boxScore+20*Number(v.isCleanProductShot===gold.clean),attributesPointsPending:20};
      if(f1<1)flags.push('missing/extra item or incorrect category');
      if(v.isCleanProductShot && !gold.clean)flags.push('false clean product shot');
    }
    if(c.task==='curation' && Array.isArray(v?.outfits)) {
      const seen=new Set(suite.excludedPairs.map(x=>[...x].sort().join('|')));
      if(v.outfits.length!==3)flags.push('wrong outfit count');
      for(const o of v.outfits) {
        if(!Array.isArray(o.garmentIds)){flags.push('missing garmentIds');continue;}
        if(new Set(o.garmentIds).size!==o.garmentIds.length)flags.push('duplicate garment ID');
        const items=o.garmentIds.map(id=>inventory.get(id));
        if(items.some(x=>!x)){flags.push('unknown garment ID');continue;}
        for(const p of ['upperbody','lowerbody'])if(items.filter(x=>x.part===p).length!==1)flags.push(`requires exactly one ${p}`);
        for(const p of ['wholebody_up','shoes','accessories_up'])if(items.filter(x=>x.part===p).length>1)flags.push(`multiple ${p}`);
        const pair=items.filter(x=>['upperbody','lowerbody'].includes(x.part)).map(x=>x.id).sort().join('|');
        if(seen.has(pair))flags.push('excluded/repeated top-bottom pair');seen.add(pair);
        const outer=items.find(x=>x.part==='wholebody_up');
        if(Boolean(outer)===(o.outerLayerConstruction==='none'))flags.push('outer construction inconsistent with selection');
        if(outer?.name==='black long-sleeve full-skirt dress coat'&&o.outerLayerConstruction==='full-front-opening')flags.push('unsupported full opening on black dress coat');
      }
    }
    if(c.task==='shopping' && v) {
      if(c.id==='shopping-empty'&&(v.verdict!=='unclear'||v.pairings?.length))flags.push('empty image must be unclear without pairings');
      for(const p of v.pairings||[]) {
        if(p.itemIds?.some(id=>!inventory.has(id)))flags.push('unowned shopping pairing');
        if(c.id==='shopping-duplicate'&&p.itemIds?.includes(suite.inventory[2].id))flags.push('shopping candidate paired with its identical owned copy');
      }
    }
    row.criticalFlags=[...new Set(flags)];
    report.criticalFlags.push(...row.criticalFlags.map(x=>`${c.id}: ${x}`));
    report.cases[c.id]=row;
  }
  report.extraCases=Object.keys(results).filter(k=>!suite.cases.some(c=>c.id===k));
  return report;
}

export function aggregate(suite, rubric, checks, grades) {
  const reports={};
  const mean=xs=>xs.reduce((a,b)=>a+b,0)/xs.length;
  for(const [candidate,checked] of Object.entries(checks)) {
    const taskScores={},cases={},criticalFlags=[...checked.criticalFlags];
    for(const c of suite.cases) {
      const grade=grades[candidate]?.[c.id];
      if(!grade || !Array.isArray(grade.criticalFlags))throw new Error(`Missing grade ${candidate}/${c.id}`);
      const ratings=c.task==='detection'?[grade.attributeScore]:grade.ratings;
      const count=c.task==='detection'?1:rubric.criteria[c.task].length;
      if(!Array.isArray(ratings)||ratings.length!==count||ratings.some(x=>!Number.isInteger(x)||x<0||x>4))throw new Error(`Invalid ratings ${candidate}/${c.id}`);
      const quality=c.task==='detection'?checked.cases[c.id].detection.objectivePoints+grade.attributeScore*5:mean(ratings)*25;
      (taskScores[c.task]||=[]).push(quality);
      cases[c.id]={quality,notes:grade.notes,criticalFlags:grade.criticalFlags};
      criticalFlags.push(...grade.criticalFlags.map(x=>`${c.id}: ${x}`));
    }
    const tasks=Object.fromEntries(Object.entries(taskScores).map(([k,v])=>[k,mean(v)]));
    const quality=Object.entries(rubric.weights).reduce((sum,[k,w])=>sum+tasks[k]*w/100,0);
    reports[candidate]={quality,tasks,schemaPasses:checked.schemaPasses,criticalFlags:[...new Set(criticalFlags)],cases,measuredApiCost:null,measuredApiLatency:null};
  }
  return reports;
}

if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  const dir=path.resolve(process.argv[2]||'data/vision-benchmark/2026-09-20');
  const read=async file=>JSON.parse(await fs.readFile(path.join(dir,file),'utf8'));
  const suite=await read('suite.json'),rubric=await read('rubric.json');
  const reports={};
  for(const file of (await fs.readdir(path.join(dir,'results'))).filter(x=>/^[a-z]\.json$/.test(x)).sort())reports[file.slice(0,-5)]=score(suite,rubric,await read(`results/${file}`));
  await fs.writeFile(path.join(dir,'checks.json'),JSON.stringify(reports,null,2)+'\n');
  let grades;
  try { grades=await read('grading.json'); } catch(e) { if(e.code!=='ENOENT')throw e; }
  if(grades)await fs.writeFile(path.join(dir,'scores.json'),JSON.stringify(aggregate(suite,rubric,reports,grades),null,2)+'\n');
  console.log(JSON.stringify(Object.fromEntries(Object.entries(reports).map(([k,v])=>[k,{schemaPasses:v.schemaPasses,criticalFlags:v.criticalFlags}])) ,null,2));
}
