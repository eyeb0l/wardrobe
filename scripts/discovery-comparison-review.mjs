#!/usr/bin/env node
import http from "node:http";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { atomicJson } from "./outfit-storage.mjs";
import { loadReviewedComparison, validateComparisonManifest } from "./discovery-comparison.mjs";
import { prepareDecisionImage } from "./decision-images.mjs";

const page = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Suitability review</title>
<style>body{margin:0;background:#f6f3ef;color:#25211d;font:16px system-ui}main{max-width:1250px;margin:auto;padding:32px 22px}h1{font-size:30px;margin:0 0 12px}p{line-height:1.5;max-width:850px}.toolbar{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:24px 0}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(245px,1fr));gap:18px}.card{background:white;padding:16px;border-radius:14px;border:1px solid #ded8d0}.photo{width:100%;height:330px;object-fit:contain;background:#f7f5f2}.pieces{display:flex;flex-wrap:wrap}.pieces img{width:90px;height:100px;object-fit:contain}h2{font-size:22px}h3{font-size:16px;line-height:1.4}select,button{font:inherit;padding:10px;border:1px solid #bbb1a5;border-radius:7px;background:white}button{cursor:pointer}label{display:block;margin:14px 0}input{margin-right:8px}#status{font-weight:600}details{margin-top:14px}.note{color:#655e55;font-size:14px}.actions{position:sticky;bottom:0;background:#f6f3ef;padding:14px 0;display:flex;gap:12px;flex-wrap:wrap;border-top:1px solid #ded8d0}</style>
<main><h1>Which looks suit the brief?</h1><p>Grade each look using the photo and garment references, then mark up to three preferred picks. Judge visible suitability rather than exact fit, comfort or fabric you cannot verify. No model results are shown.</p><p class="note">0 = unsuitable · 1 = partly suitable · 2 = good · 3 = excellent · Unknown = cannot judge. Preferred picks must be good or excellent. You can change your choices before finishing.</p><div class="toolbar"><label>Brief <select id="case"></select></label><span id="progress"></span></div><h2 id="brief"></h2><div id="grid" class="grid"></div><label><input type="checkbox" id="none">None of these looks are suitable</label><div class="actions"><button id="save">Save progress</button><button id="finish">Finish review</button><span id="status" role="status"></span></div></main>
<script>let state,selected=0;const element=id=>document.getElementById(id);const status=text=>element('status').textContent=text;
function progress(){const total=state.cases.reduce((n,c)=>n+c.candidates.length,0);const done=state.cases.reduce((n,c)=>n+c.candidates.filter(r=>r.relevance!==null).length,0);element('progress').textContent=done+' / '+total+' graded';}
function render(){const item=state.cases[selected];element('brief').textContent=item.brief;element('none').checked=item.noneSuitable;element('grid').replaceChildren();item.candidates.forEach((row,index)=>{const card=document.createElement('article');card.className='card';const img=document.createElement('img');img.className='photo';img.src='/image/'+selected+'-'+index+'-photo';img.alt=row.name;img.loading='lazy';card.append(img);const title=document.createElement('h3');title.textContent=row.name;card.append(title);const label=document.createElement('label');label.textContent='Suitability ';const select=document.createElement('select');[['','Choose a grade'],['0','0 · Unsuitable'],['1','1 · Partly suitable'],['2','2 · Good'],['3','3 · Excellent'],['unknown','Unknown']].forEach(([value,text])=>{const option=document.createElement('option');option.value=value;option.textContent=text;select.append(option)});select.value=row.relevance===null?'':String(row.relevance);select.onchange=()=>{row.relevance=select.value===''?null:select.value==='unknown'?'unknown':Number(select.value);progress();status('Unsaved changes')};label.append(select);card.append(label);const favorite=document.createElement('label'),check=document.createElement('input');check.type='checkbox';check.checked=row.preferred;check.onchange=()=>{row.preferred=check.checked;status('Unsaved changes')};favorite.append(check,document.createTextNode('Preferred pick'));card.append(favorite);const details=document.createElement('details'),summary=document.createElement('summary'),pieces=document.createElement('div');summary.textContent='Garment references';pieces.className='pieces';row.pieces.forEach((name,piece)=>{const ref=document.createElement('img');ref.src='/image/'+selected+'-'+index+'-piece-'+piece;ref.alt=name;ref.loading='lazy';pieces.append(ref)});details.append(summary,pieces);card.append(details);element('grid').append(card)});progress();}
async function save(complete){status('Saving…');try{const response=await fetch('/labels',{method:'POST',headers:{'Content-Type':'application/json','X-Review-Token':state.token},body:JSON.stringify({complete,cases:state.cases.map(c=>({id:c.id,noneSuitable:c.noneSuitable,candidates:c.candidates.map(({id,relevance,preferred})=>({id,relevance,preferred}))}))})});const result=await response.json();if(!response.ok)throw new Error(result.error);status(result.reviewed?'Review complete. Return to Codex and say Done.':'Progress saved.');}catch(error){status(error.message)}}
element('case').onchange=()=>{selected=Number(element('case').value);render()};element('none').onchange=()=>{state.cases[selected].noneSuitable=element('none').checked;status('Unsaved changes')};element('save').onclick=()=>save(false);element('finish').onclick=()=>save(true);fetch('/state').then(r=>r.json()).then(value=>{state=value;state.cases.forEach((c,i)=>{const option=document.createElement('option');option.value=i;option.textContent=c.id+' · '+c.brief;element('case').append(option)});render()}).catch(()=>status('Could not load the private review.'));</script></html>`;

export async function createComparisonReview(manifestPath) {
  let { manifest, subjects } = await loadReviewedComparison(manifestPath, { reviewed: false });
  const token = randomUUID(), images = new Map();
  const view = { token, cases: manifest.cases.map((item, caseIndex) => ({ id: item.id, brief: item.brief, noneSuitable: item.noneSuitable,
    candidates: item.candidates.map((row, index) => {
      const subject = subjects[caseIndex], candidate = subject.candidates.find(candidate => candidate.id === row.id);
      images.set(`${caseIndex}-${index}-photo`, subject.source.outfitFiles.get(row.id));
      candidate.garments.forEach((piece, pieceIndex) => images.set(`${caseIndex}-${index}-piece-${pieceIndex}`, subject.source.itemFiles.get(piece.id)));
      return { ...row, name: candidate.name, pieces: candidate.garments.map(piece => piece.name) };
    }) })) };
  let saves = Promise.resolve();
  const server = http.createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Content-Type-Options", "nosniff");
    const origin = `http://127.0.0.1:${server.address().port}`;
    const json = (status, value) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    try {
      if (req.headers.host !== new URL(origin).host) return json(403, { error: "Use the private review URL." });
      const url = new URL(req.url, origin);
      if (req.method === "GET" && url.pathname === "/") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(page); return; }
      if (req.method === "GET" && url.pathname === "/state") return json(200, view);
      if (req.method === "GET" && url.pathname.startsWith("/image/")) {
        const file = images.get(url.pathname.slice(7));
        if (!file) return json(404, { error: "Image unavailable." });
        const image = await prepareDecisionImage(file);
        res.writeHead(200, { "Content-Type": "image/jpeg" }); res.end(Buffer.from(image.image_url.split(",")[1], "base64")); return;
      }
      if (req.method !== "POST" || url.pathname !== "/labels") return json(404, { error: "Not found." });
      if (req.headers.origin !== origin || req.headers["x-review-token"] !== token || !req.headers["content-type"]?.startsWith("application/json")) return json(403, { error: "Save from this private review page." });
      let body = "";
      for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 64_000) throw new Error("Too many labels."); }
      const input = JSON.parse(body);
      if (typeof input.complete !== "boolean" || !Array.isArray(input.cases) || input.cases.length !== manifest.cases.length) throw new Error("Invalid review submission.");
      const update = async () => {
        await loadReviewedComparison(manifestPath, { reviewed: false });
        const next = structuredClone(manifest);
        next.cases.forEach((item, index) => {
          const supplied = input.cases[index];
          if (supplied?.id !== item.id || !Array.isArray(supplied.candidates) || supplied.candidates.length !== item.candidates.length) throw new Error("The examples changed. Reload the review.");
          item.noneSuitable = supplied.noneSuitable;
          item.candidates = supplied.candidates.map((row, candidateIndex) => {
            if (row.id !== item.candidates[candidateIndex].id || Object.keys(row).some(key => !["id", "relevance", "preferred"].includes(key))) throw new Error("Invalid review candidate.");
            return { id: row.id, relevance: row.relevance, preferred: row.preferred };
          });
          item.review = { humanReviewed: input.complete, reviewedAt: input.complete ? new Date().toISOString() : null };
        });
        validateComparisonManifest(next, { reviewed: input.complete });
        await atomicJson(manifestPath, next, { mode: 0o600 }); manifest = next;
        view.cases.forEach((item, index) => { item.noneSuitable = next.cases[index].noneSuitable; item.candidates.forEach((row, candidateIndex) => Object.assign(row, next.cases[index].candidates[candidateIndex])); });
      };
      const work = saves.then(update); saves = work.catch(() => {}); await work;
      return json(200, { saved: true, reviewed: input.complete });
    } catch (error) { return json(400, { error: error.message || "Review could not be saved." }); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createComparisonReview(process.argv[2]).then(({ url }) => console.log(`Private suitability review: ${url}`)).catch(() => { console.error("Could not open the private comparison manifest."); process.exitCode = 1; });
}
