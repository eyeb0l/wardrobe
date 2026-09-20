// Private, offline report. Structured predictions are escaped text, never HTML.
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import sharp from 'sharp';
import {summary} from './score-vision-api-eval.mjs';

export const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const number=(value,digits=1)=>finite(value)?value.toFixed(digits):'—';
const percent=value=>finite(value)?`${(value*100).toFixed(1)}%`:'—';
const money=value=>finite(value)?`$${value.toFixed(4)}`:'—';
const costRange=(low,high)=>finite(low)&&finite(high)&&Math.abs(high-low)>0.0000001?`${money(low)}–${money(high)}`:money(high??low);
const seconds=value=>finite(value)?`${(value/1000).toFixed(1)}s`:'—';
const esc=escapeHtml;

// Round-robin configurations, favoring previously unseen cases. Repeat calls
// for the same configuration/case do not crowd other examples out of the gallery.
export function gallerySample(rows,accepted,limit) {
  const groups=new Map(),seenPairs=new Set();
  for(const row of rows.filter(r=>r.task==='detection'&&r.accepted===accepted).sort((a,b)=>String(a.config).localeCompare(String(b.config))||String(a.caseId).localeCompare(String(b.caseId))||a.repeat-b.repeat)) {
    const key=JSON.stringify([row.config,row.caseId]);if(seenPairs.has(key))continue;seenPairs.add(key);
    if(!groups.has(row.config))groups.set(row.config,[]);groups.get(row.config).push(row);
  }
  const selected=[],seenCases=new Set();
  while(selected.length<limit&&[...groups.values()].some(group=>group.length))for(const group of groups.values()){
    if(!group.length||selected.length>=limit)continue;
    const index=group.findIndex(row=>!seenCases.has(row.caseId));
    const [row]=group.splice(index<0?0:index,1);selected.push(row);seenCases.add(row.caseId);
  }
  return selected;
}

function table(summaries) {
  const rows=Object.entries(summaries).sort(([a],[b])=>a.localeCompare(b)).map(([config,s])=>`<tr><th scope="row">${esc(config)}</th><td>${esc(s.attempts)}</td><td>${esc(s.accepted)}/${esc(s.attempts)}${s.pending?` · ${esc(s.pending)} pending`:''}</td><td>${percent(s.weightedAcceptance)}</td><td>${number(s.weightedQuality)}</td><td>${costRange(s.costPerAcceptableLowerUsd,s.costPerAcceptableUpperUsd)}</td><td>${seconds(s.medianLatencyMs)}</td><td>${seconds(s.p95LatencyMs)}</td></tr>`).join('');
  return `<div class="table-wrap"><table><thead><tr><th scope="col">Configuration</th><th scope="col">Calls</th><th scope="col">Accepted calls</th><th scope="col">Weighted acceptance</th><th scope="col">Quality / 100</th><th scope="col">USD / acceptable answer</th><th scope="col">Median</th><th scope="col">p95*</th></tr></thead><tbody>${rows||'<tr><td colspan="8">No scored attempts.</td></tr>'}</tbody></table></div>`;
}
function validBox(box) {return box&&['x','y','width','height'].every(key=>finite(box[key]))&&box.width>0&&box.height>0;}
function boxes(items,reference,width,height) {
  return items.map((item,index)=>{
    const box=reference?item.box:item.boundingBox;if(!validBox(box))return '';
    const x=box.x*width/1000,y=box.y*height/1000,w=box.width*width/1000,h=box.height*height/1000;
    const label=`${reference?'R':'P'}${index+1}`,color=reference?'#007c72':'#a12ca8',font=Math.max(14,width*.021);
    const labelX=Math.max(0,Math.min(width-font*3,reference?x:x+w-font*2.5)),labelY=Math.max(font+3,Math.min(height-font*.3,y+font+3));
    return `<g class="${reference?'reference':'prediction'}"><rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${color}" stroke-width="${Math.max(2,width*.003)}"${reference?'':` stroke-dasharray="${width*.009} ${width*.005}"`}/><text x="${labelX}" y="${labelY}" fill="${color}" stroke="white" stroke-width="${font*.16}" paint-order="stroke" font-size="${font}" font-family="system-ui,sans-serif" font-weight="700">${label}<title>${esc(item.name||item.part||'Item')}</title></text></g>`;
  }).join('');
}
function labels(items,reference) {
  return `<ol>${items.map((item,index)=>`<li><strong>${reference?'R':'P'}${index+1}</strong> ${esc(item.name||item.part||'Unnamed item')}${item.name&&item.part?` · ${esc(item.part)}`:''}${reference&&item.required===false?' · optional':''}${!validBox(reference?item.box:item.boundingBox)?' · invalid/missing box':''}</li>`).join('')||'<li>None</li>'}</ol>`;
}
async function imageSource(c,suitePath,outputPath) {
  const image=c.request?.input?.flatMap(message=>message.content||[]).find(content=>content.type==='input_image');
  if(!image)return null;
  let bytes,href;
  if(typeof image.image_path==='string') {
    const local=path.resolve(path.dirname(suitePath),image.image_path);
    bytes=await fs.readFile(local);
    href=path.relative(path.dirname(outputPath),local).split(path.sep).map(segment=>encodeURIComponent(segment)).join('/');
  } else if(typeof image.image_url==='string'&&/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(image.image_url)) {
    bytes=Buffer.from(image.image_url.split(',')[1],'base64');href=image.image_url;
  } else throw new Error(`Report requires a local raster fixture for ${c.id}; remote images are forbidden`);
  const metadata=await sharp(bytes,{limitInputPixels:64e6}).metadata();
  if(!['png','jpeg','webp'].includes(metadata.format)||!metadata.width||!metadata.height)throw new Error(`Invalid raster fixture for ${c.id}`);
  return {href,width:metadata.width,height:metadata.height};
}

export async function renderReport({suite,ledger,gold,scores,suitePath,outputPath}) {
  const rows=scores.rows||[],summaries=scores.summary||summary(rows),attempts=Object.values(ledger.attempts||{});
  const failures=gallerySample(rows,false,15),successes=gallerySample(rows,true,5),images=new Map();
  async function card(row) {
    const c=suite.cases.find(candidate=>candidate.id===row.caseId);if(!c)throw new Error(`Unknown scored case ${row.caseId}`);
    const attempt=ledger.attempts?.[row.attemptId]||attempts.find(a=>a.caseId===row.caseId&&a.config===row.config&&a.repeat===row.repeat);
    const predicted=Array.isArray(attempt?.response?.parsed?.items)?attempt.response.parsed.items.map(item=>item&&typeof item==='object'&&!Array.isArray(item)?item:{name:'Invalid item record'}):[];
    const annotation=gold.cases?.[c.id];
    const variant=row.detection?.chosenVariant;
    const selected=annotation?.variants?annotation.variants[Number.isInteger(variant)?variant:0]:annotation;
    const references=Array.isArray(selected?.items)?selected.items:[];
    if(!images.has(c.id))images.set(c.id,await imageSource(c,suitePath,outputPath));const image=images.get(c.id);
    const visual=image?`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${image.width} ${image.height}" width="${image.width}" height="${image.height}" role="img" aria-label="Processed input with predicted and reference boxes"><image href="${esc(image.href)}" x="0" y="0" width="${image.width}" height="${image.height}"/>${boxes(references,true,image.width,image.height)}${boxes(predicted,false,image.width,image.height)}</svg>`:'<p>Processed image unavailable.</p>';
    const flags=[...(row.flags||[]),...(row.schemaErrors||[])];
    const predictedClean=attempt?.response?.parsed?.isCleanProductShot;
    const referenceClean=selected?.acceptableClean||annotation?.acceptableClean||[selected?.clean];
    return `<article class="example"><div class="example-heading"><h3>${esc(c.id)}</h3><p>${esc(row.config)} · repeat ${esc(row.repeat)} · ${row.accepted?'accepted':'not accepted'}</p></div><div class="visual">${visual}</div><div class="example-body"><p class="metrics">F1 ${number(row.detection?.f1,2)} · mean IoU ${number(row.detection?.meanIoU,2)} · quality ${number(row.quality)} · ${seconds(row.latencyMs)}</p><p><strong>Flags:</strong> ${flags.length?flags.map(esc).join('; '):'None'}</p>${row.notes?`<p>${esc(row.notes)}</p>`:''}<p class="small">Clean-product flag: predicted ${esc(predictedClean===undefined?'unavailable':predictedClean)}; reference ${esc(referenceClean.filter(v=>v!==undefined).join(' or ')||'unavailable')}.${annotation?.variants?` Frozen interpretation ${Number.isInteger(variant)?variant+1:'1 (unscored default)'} of ${annotation.variants.length}.`:''}</p>${!attempt?.response?.parsed?.items?'<p class="small">No parsed detector item array was recorded.</p>':''}<details><summary>Item labels</summary><div class="label-columns"><div><h4>Reference</h4>${labels(references,true)}</div><div><h4>Prediction</h4>${labels(predicted,false)}</div></div></details></div></article>`;
  }
  const failureCards=[];for(const row of failures)failureCards.push(await card(row));
  const successCards=[];for(const row of successes)successCards.push(await card(row));
  const lower=attempts.reduce((sum,a)=>sum+(a.cost?.lowerNanoUsd||0),0)/1e9;
  const upper=attempts.reduce((sum,a)=>sum+(a.chargedNanoUsd??a.usageUpperNanoUsd??a.reservedNanoUsd??0),0)/1e9;
  const cap=finite(ledger.capNanoUsd)?ledger.capNanoUsd/1e9:null;
  const html=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' file: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>Vision evaluation — private report</title><style>
:root{color-scheme:light;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#202423;background:#f7f8f6}*{box-sizing:border-box}body{margin:0}main{max-width:1320px;margin:auto;padding:38px 26px 64px}h1{font-size:32px;letter-spacing:-.8px;margin:0 0 12px}h2{font-size:23px;margin:34px 0 12px}h3{font-size:16px;margin:0;overflow-wrap:anywhere}h4{font-size:13px;margin:12px 0 6px}p{line-height:1.5;margin:8px 0}.intro{max-width:920px;color:#47504b}.small{font-size:12px;color:#59635d}.table-wrap{overflow:auto;background:white;border:1px solid #d9ded8;margin:24px 0 10px}table{border-collapse:collapse;width:100%;font-size:13px;white-space:nowrap}th,td{padding:13px 12px;border-bottom:1px solid #e6eae4;text-align:right}th:first-child{text-align:left}thead th{font-size:12px;color:#52604f;background:#edf1eb}tbody tr:last-child td,tbody tr:last-child th{border-bottom:0}.legend{display:flex;gap:22px;flex-wrap:wrap;font-size:13px;margin:14px 0}.swatch{display:inline-block;width:28px;height:12px;vertical-align:middle;margin-right:7px;border:3px solid #007c72}.swatch.predicted{border-color:#a12ca8;border-style:dashed}.gallery{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:22px}.example{background:white;border:1px solid #d9ded8;overflow:hidden}.example-heading{padding:16px 18px 10px}.example-heading p{font-size:12px;color:#59635d}.visual{background:#eef0eb;border-top:1px solid #e6eae4;border-bottom:1px solid #e6eae4;text-align:center}.visual svg{display:block;width:100%;height:auto;max-height:620px}.example-body{padding:12px 18px 18px;font-size:13px;overflow-wrap:anywhere}.metrics{color:#47544e}.label-columns{display:grid;grid-template-columns:1fr 1fr;gap:18px}ol{padding-left:20px;margin:6px 0}li{margin:4px 0}details{border-top:1px solid #e5e9e2;padding-top:12px;margin-top:12px}summary{cursor:pointer;font-weight:600}.empty{padding:24px;background:white;border:1px solid #d9ded8}@media(max-width:760px){main{padding:24px 14px}.gallery{grid-template-columns:1fr}.label-columns{grid-template-columns:1fr}h1{font-size:28px}}@media print{main{padding:0}.example{break-inside:avoid}.visual svg{max-height:420px}details{display:block}.table-wrap{overflow:visible}}
</style></head><body><main><h1>Vision evaluation</h1><p class="intro">Private evaluation of the app’s garment identification and styling tasks. Descriptive results below use scored attempts; differing case coverage can make pooled configuration comparisons misleading. Use the matched-case analysis for a model decision.</p><p class="small">${esc(rows.length)} scored calls · ${esc(suite.cases?.length||0)} frozen cases · All-phases ledger API usage / reserved upper bound ${costRange(lower,upper)}${cap!==null?` against ${money(cap)} cap`:''}. Cost intervals include unresolved reservations; they are not necessarily final billed charges.</p>${table(summaries)}<p class="small">Weights: detection 35%, curation 30%, shopping 20%, scene 10%, accessories 5%. Quality is a rubric score, not a probability. Values are attempt-weighted within tasks; missing task weights are renormalized, so compare matched task coverage. Pending reviews withhold summary quality. *p95 is exploratory at this sample size.</p><h2>Detection examples</h2><p class="intro">The image is the actual processed API input. Solid teal boxes show the frozen reference labels; dashed purple boxes show predictions. Samples rotate across configurations and cases, with at most one repeat per configuration/case within each section. These examples illustrate errors and are not additional evaluation samples.</p><div class="legend"><span><i class="swatch"></i>Reference · R</span><span><i class="swatch predicted"></i>Prediction · P</span></div><h2>Not accepted (${failures.length})</h2><div class="gallery">${failureCards.join('')||'<p class="empty">No scored detection failures available.</p>'}</div><h2>Accepted (${successes.length})</h2><div class="gallery">${successCards.join('')||'<p class="empty">No accepted detection examples available.</p>'}</div><p class="small">Generated offline. Labels and subjective reviews are model-assisted; correlated views, repeated calls and the shared wardrobe limit generalization. Source images and this report remain local.</p></main></body></html>`;
  await fs.mkdir(path.dirname(outputPath),{recursive:true});await fs.writeFile(outputPath,html,{mode:0o600});
  return {output:outputPath,scoredCalls:rows.length,failureExamples:failures.length,successExamples:successes.length,bytes:Buffer.byteLength(html)};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const [suitePath,ledgerPath,goldPath,scoresPath,output]=process.argv.slice(2);
 if(!output)throw new Error('Usage: node scripts/render-vision-eval-report.mjs SUITE LEDGER GOLD SCORES OUTPUT_HTML');
 const read=async file=>JSON.parse(await fs.readFile(file,'utf8'));
 const [suite,ledger,gold,scores]=await Promise.all([suitePath,ledgerPath,goldPath,scoresPath].map(read));
 console.log(JSON.stringify(await renderReport({suite,ledger,gold,scores,suitePath:path.resolve(suitePath),outputPath:path.resolve(output)}),null,2));
}
