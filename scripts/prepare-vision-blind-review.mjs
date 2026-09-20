// Local packets contain no candidate model, effort, latency, cost, or usage.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
const [suitePath,ledgerPath,goldPath,rubricPath,outDir,split='screen',excludeGradesPath]=process.argv.slice(2);
if(!outDir)throw Error('SUITE LEDGER GOLD RUBRIC OUTPUT_DIR [screen|confirm]');
const read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const [suite,ledger,gold,rubric]=await Promise.all([suitePath,ledgerPath,goldPath,rubricPath].map(read));
const exclude=excludeGradesPath?await read(excludeGradesPath):{};
await fs.mkdir(outDir,{recursive:true,mode:0o700});
let secret;try{secret=await fs.readFile(path.join(outDir,'blinding-seed'),'utf8');}catch{secret=randomBytes(32).toString('hex');await fs.writeFile(path.join(outDir,'blinding-seed'),secret,{mode:0o600,flag:'wx'});}
const hash=x=>createHash('sha256').update(secret+x).digest('hex');
const mapping={};const groups={detection:[],curation:[],shopping:[],scene:[],accessories:[]};
for(const c of suite.cases.filter(c=>c.split===split)){
 const input=c.request.input.map(m=>({role:m.role,content:m.content.map(v=>v.type==='input_image'?{...v,image_path:path.resolve(path.dirname(suitePath),v.image_path)}:v)}));
 const answers=Object.values(ledger.attempts).filter(a=>!exclude[a.id]&&a.caseId===c.id&&a.response?.parsed&&a.response.apiStatus==='completed'&&!a.operationalFailure&&a.latencyMs<=c.timeoutMs).map(a=>{const answerId='answer-'+hash(a.id).slice(0,16);mapping[answerId]=a.id;return {answerId,value:a.response.parsed};}).sort((a,b)=>a.answerId.localeCompare(b.answerId));
 groups[c.task].push({caseId:c.id,task:c.task,instructions:c.request.instructions,input,gold:gold.cases[c.id],answers});
}
for(const [task,cases]of Object.entries(groups))await fs.writeFile(path.join(outDir,task+'.json'),JSON.stringify({rubric:{...rubric,selectionRule:undefined},inventory:suite.inventory,cases},null,2),{mode:0o600});
await fs.writeFile(path.join(outDir,'mapping-private.json'),JSON.stringify(mapping,null,2),{mode:0o600});
console.log(JSON.stringify(Object.fromEntries(Object.entries(groups).map(([k,cases])=>[k,cases.reduce((s,c)=>s+c.answers.length,0)]))));
