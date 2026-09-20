// Offline matched-case analysis. Repeated calls are averaged within a case;
// family bootstrap retains every correlated view/prompt/repeat together.
import fs from 'node:fs';
import {summary} from './score-vision-api-eval.mjs';
const [scoresPath,suitePath,outputPath,baseline='luna-medium',challenger]=process.argv.slice(2);
if(!challenger)throw Error('SCORES SUITE OUTPUT BASELINE CHALLENGER');
const {rows}=JSON.parse(fs.readFileSync(scoresPath));const suite=JSON.parse(fs.readFileSync(suitePath));
const weights={detection:35,curation:30,shopping:20,scene:10,accessories:5};
const cases=[];
for(const c of suite.cases.filter(c=>c.split==='confirm')){
 const a=rows.filter(r=>r.caseId===c.id&&r.config===baseline),b=rows.filter(r=>r.caseId===c.id&&r.config===challenger);
 const repeats=a.map(x=>x.repeat).filter(n=>b.some(x=>x.repeat===n));
 const aa=a.filter(x=>repeats.includes(x.repeat)),bb=b.filter(x=>repeats.includes(x.repeat));
 if(!repeats.length||[...aa,...bb].some(x=>x.accepted===null))continue;
 const mean=(rs,key)=>rs.reduce((s,x)=>s+Number(x[key]),0)/rs.length;
 cases.push({id:c.id,family:c.family,task:c.task,repeats,baselineAcceptance:mean(aa,'accepted'),challengerAcceptance:mean(bb,'accepted'),baselineQuality:mean(aa,'quality'),challengerQuality:mean(bb,'quality'),acceptanceDifference:mean(bb,'accepted')-mean(aa,'accepted'),qualityDifference:mean(bb,'quality')-mean(aa,'quality')});
}
const completeTaskCoverage=Object.keys(weights).every(t=>cases.some(c=>c.task===t));
let seed=29092026;const rand=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
// Retail cases jointly cluster across detection/shopping. Other task strata retain
// their contexts as whole clusters, including the single shared curation context.
const strata=[['detection','shopping'],['curation'],['scene'],['accessories']].map(tasks=>[...new Set(cases.filter(c=>tasks.includes(c.task)).map(c=>c.family))]);
const delta=(sample,key)=>{const means=Object.keys(weights).map(task=>{const t=sample.filter(c=>c.task===task);return t.length?[weights[task],t.reduce((s,c)=>s+c[key],0)/t.length]:null;}).filter(Boolean);return means.reduce((s,[w,m])=>s+w*m,0)/means.reduce((s,[w])=>s+w,0);};
const samples=[];let discarded=0;
for(let i=0;i<(completeTaskCoverage?10000:0);i++){
 const sampled=strata.flatMap(families=>families.flatMap(()=>{const family=families[Math.floor(rand()*families.length)];return cases.filter(c=>c.family===family);}));
 if(Object.keys(weights).some(t=>cases.some(c=>c.task===t)&&!sampled.some(c=>c.task===t))){discarded++;continue;}
 samples.push({acceptance:delta(sampled,'acceptanceDifference'),quality:delta(sampled,'qualityDifference')});
}
const interval=key=>{const a=samples.map(x=>x[key]).sort((a,b)=>a-b);return a.length?[a[Math.floor(.025*(a.length-1))],a[Math.floor(.975*(a.length-1))]]:null;};
const matchedIds=new Set(cases.map(c=>c.id));const matchedRows=rows.filter(r=>[baseline,challenger].includes(r.config)&&matchedIds.has(r.caseId)&&cases.find(c=>c.id===r.caseId).repeats.includes(r.repeat));
const report={baseline,challenger,matchedCases:cases.length,matchedCalls:matchedRows.length,completeTaskCoverage,callWeightedSummary:summary(matchedRows),caseBalanced:completeTaskCoverage?{baselineAcceptance:delta(cases,'baselineAcceptance'),challengerAcceptance:delta(cases,'challengerAcceptance'),baselineQuality:delta(cases,'baselineQuality'),challengerQuality:delta(cases,'challengerQuality')}:null,differences:completeTaskCoverage?{acceptance:delta(cases,'acceptanceDifference'),quality:delta(cases,'qualityDifference'),acceptance95:interval('acceptance'),quality95:interval('quality')}:null,bootstrap:{draws:samples.length,discarded,seed:29092026,unit:'family, with joint retailer resampling across detection/shopping; other task strata separately',limitations:'Conditional on this frozen wardrobe and model-assisted labels. Curation has one family, so its context variability cannot be estimated; these intervals are exploratory, not universal guarantees.'},cases};
fs.writeFileSync(outputPath,JSON.stringify(report,null,2));console.log(JSON.stringify({...report,cases:undefined},null,2));
