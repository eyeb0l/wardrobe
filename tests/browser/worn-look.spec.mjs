import { test as base, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import sharp from 'sharp';

const artwork = async (color, index) => `data:image/png;base64,${(await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="#eee8de"/><path d="${index === 4 ? 'M105 65 Q150 35 185 80 L280 280 L230 340 L145 145 L80 120Z' : index === 5 ? 'M155 55 H245 L255 135 L310 345 H90 L145 135Z' : index === 1 || index === 3 ? 'M140 65 H260 L285 345 H220 L200 165 L180 345 H115Z' : 'M135 70 L175 55 Q200 82 225 55 L265 70 L320 150 L280 180 L255 150 L260 330 H140 L145 150 L120 180 L80 150Z'}" fill="${color}"/></svg>`)).png().toBuffer()).toString('base64')}`;
const photos = await Promise.all(['#35495a','#c5b79a','#827455','#a76e58','#b68d63','#755e69'].map(artwork));
const initial = [
  { id:'navy', name:'Navy blouse', part:'upperbody', color:'#35495a', image:photos[0] },
  { id:'stone', name:'Stone trousers', part:'lowerbody', color:'#c5b79a', image:photos[1] },
  { id:'olive', name:'Olive shirt', part:'upperbody', color:'#827455', image:photos[2], availability:'laundry' },
  { id:'rust', name:'Rust skirt', part:'lowerbody', color:'#a76e58', image:photos[3], availability:'ready' },
  { id:'solo', name:'Silk scarf', part:'accessories_up', color:'#b68d63', image:photos[4] },
  { id:'dress', name:'Plum dress', part:'dresses', color:'#755e69', image:photos[5] },
].map(item=>({...item,tags:[],revision:item.id}));
const saved = [
  { id:'navy-look',name:'An easy morning',garmentIds:['navy','stone'],image:photos[0],occasion:['casual'] },
  { id:'olive-look',name:'Olive afternoon',garmentIds:['olive','stone'],image:photos[2],occasion:['casual'] },
  { id:'rust-look',name:'Dinner in rust',garmentIds:['navy','rust'],image:photos[3],occasion:['dinner'] },
  { id:'navy-variation',name:'Navy for work',garmentIds:['navy','stone'],image:photos[0],imageKind:'cutouts',occasion:['work'] },
].map(outfit=>({...outfit,status:'accepted',reason:'Familiar wardrobe pieces.',favourite:true}));
saved[0].wearHistory=[{id:crypto.randomUUID(),date:'2026-09-01',garmentIds:['navy'],createdAt:'2026-09-01T12:00:00Z'}];
saved[1].wearHistory=[{id:crypto.randomUUID(),date:'2026-09-10',garmentIds:['stone'],createdAt:'2026-09-10T12:00:00Z'}];
saved[3].wearHistory=[{id:crypto.randomUUID(),date:'2026-09-01',garmentIds:['navy'],createdAt:'2026-09-01T12:00:00Z'}];
const test=base.extend({
  wardrobe:async({page,context},use,info)=>{
    const state={items:structuredClone(initial),outfits:structuredClone(saved),updates:[],failWrite:false,failRead:false,conflict:false,plans:[],plansRevision:"initial",posts:[],failCollection:false,garmentWears:[],wearPosts:[],removed:[],loseResponse:false,savePosts:[],failSave:false,loseSaveResponse:false,staleSave:false};
    const health={errors:[],failedRequests:[],httpErrors:[]};
    const expectedStatus=(status,url)=>[409,503].includes(status)&&['/api/import/wardrobe','/api/import/wardrobe/availability','/api/outfits/plans','/api/outfits','/api/outfits/garment-wears','/api/outfits/worn-look'].includes(new URL(url).pathname.replace(/\/garment-wears\/[^/]+\/remove$/, '/garment-wears').replace(/\/garment-wears\/[^/]+\/look$/, '/worn-look'));
    page.on('pageerror',e=>health.errors.push(e.message));
    page.on('console',m=>{if(m.type()==='error'&&!(/409 \(Conflict\)|503 \(Service Unavailable\)/.test(m.text())&&['/api/import/wardrobe','/api/import/wardrobe/availability','/api/outfits/plans','/api/outfits','/api/outfits/garment-wears','/api/outfits/worn-look'].includes(new URL(m.location().url||'http://test').pathname.replace(/\/garment-wears\/[^/]+\/remove$/, '/garment-wears').replace(/\/garment-wears\/[^/]+\/look$/, '/worn-look'))))health.errors.push(m.text());});
    page.on('requestfailed',r=>{if(!r.failure()?.errorText.includes('ERR_ABORTED'))health.failedRequests.push(r.url());});
    page.on('response',r=>{if(r.status()>=400&&!expectedStatus(r.status(),r.url()))health.httpErrors.push(r.url());});
    await page.clock.setFixedTime(new Date('2026-10-23T12:00:00Z'));
    await context.setExtraHTTPHeaders({'Accept-Language':'en-GB'});
    await context.addInitScript(()=>localStorage.setItem('wardrobe:welcome:v1','complete'));
    await context.route('**/api/**',async route=>{
      const p=new URL(route.request().url()).pathname, method=route.request().method();
      if(p==='/api/import/wardrobe')return state.failRead?route.fulfill({status:503,json:{error:'Wardrobe unavailable. Try again.'}}):route.fulfill({json:state.items});
      if(p==='/api/import/jobs')return route.fulfill({json:[]});
      if(p==='/api/import/config'||p==='/api/outfits/config')return route.fulfill({json:{ready:false,hasApiKey:false,modelReferences:[]}});
      if(p==='/api/outfits/discovery/config')return route.fulfill({json:{ready:false,enabled:false}});
      if(p==='/api/outfits/jobs')return route.fulfill({json:{jobs:[]}});
      if(p==='/api/outfits')return state.failCollection?route.fulfill({status:503,json:{error:'Collection unavailable.'}}):route.fulfill({json:{outfits:state.outfits,garmentWears:state.garmentWears,plans:state.plans,plansRevision:state.plansRevision}});
      if(p.match(/^\/api\/outfits\/garment-wears\/[^/]+\/look$/)&&method==='POST'){
        const body=route.request().postDataJSON();state.savePosts.push(body);
        if(state.failSave)return route.fulfill({status:503,json:{error:'Could not save this look. Try again.'}});
        if(state.staleSave)return route.fulfill({status:409,json:{error:'A selected piece changed. Refresh your wardrobe and review the look before saving.'}});
        const source=state.garmentWears.find(entry=>entry.id===p.split('/')[4]);
        if(!source)return route.fulfill({status:409,json:{error:'This wear entry was removed. Refresh your wear history.'}});
        const key=ids=>[...ids].sort().join('|');
        let outfit=state.outfits.find(outfit=>key(outfit.garmentIds)===key(body.garmentIds));
        const created=!outfit;
        if(!outfit){outfit={id:'worn-'+body.requestId,name:body.name,occasion:[body.occasion.trim().toLowerCase().replace(/\s+/g,'-')],garmentIds:body.garmentIds,image:photos[0],imageKind:'cutouts',status:'accepted',garmentWearId:source.id,reason:'Saved from worn pieces.'};state.outfits.push(outfit);}
        if(state.loseSaveResponse)return route.fulfill({status:503,json:{error:'The save response was lost.'}});
        return route.fulfill({json:{outfit,created}});
      }
      if(p.startsWith('/api/outfits/garment-wears')&&method==='POST'){
        const body=route.request().postDataJSON();state.wearPosts.push({path:p,...body});
        if(state.failWrite)return route.fulfill({status:503,json:{error:'Could not save wear. Try again.'}});
        if(p.endsWith('/remove')){
          const id=p.split('/')[4];state.removed.push(id);state.garmentWears=state.garmentWears.filter(e=>e.id!==id);
          return route.fulfill({json:{garmentWears:state.garmentWears,event:null}});
        }
        if(state.removed.includes(body.requestId))return route.fulfill({status:409,json:{error:'This entry was removed. Start a new log.'}});
        const event=state.garmentWears.find(e=>e.id===body.requestId)||{id:body.requestId,date:body.date,garmentIds:body.garmentIds,createdAt:'2026-10-23T12:00:00Z'};
        if(!state.garmentWears.includes(event))state.garmentWears.push(event);
        if(state.loseResponse)return route.fulfill({status:503,json:{error:'The response was lost. Refresh and try again.'}});
        return route.fulfill({json:{garmentWears:state.garmentWears,event}});
      }
      if(p.endsWith('/favourite')&&method==='POST'){
        const outfit=state.outfits.find(outfit=>p===`/api/outfits/${outfit.id}/favourite`);
        outfit.favourite=route.request().postDataJSON().favourite;return route.fulfill({json:outfit});
      }
      if(p==='/api/outfits/plans'&&method==='POST'){
        const body=route.request().postDataJSON();state.posts.push(body);
        if(state.failWrite)return route.fulfill({status:503,json:{error:'Could not save your plan. Try again.'}});
        if(state.conflict||body.revision!==state.plansRevision)return route.fulfill({status:409,json:{error:'Your plans changed on another device. Refresh and try again.'}});
        state.plans=state.plans.filter(plan=>plan.date!==body.date&&plan.date!==body.fromDate);
        if(body.outfitId!==null)state.plans.push({date:body.date,outfitId:body.outfitId});
        state.plansRevision=crypto.randomUUID();
        return route.fulfill({json:{plans:state.plans,plansRevision:state.plansRevision}});
      }
      if(p.endsWith('/variations')&&method==='POST'){
        const body=route.request().postDataJSON(), source=state.outfits.find(o=>p===`/api/outfits/${o.id}/variations`);
        const saved={...source,id:'variation-new',name:body.name,imageKind:'cutouts',garmentIds:source.garmentIds.map(id=>id===body.replacedGarmentId?body.replacementGarmentId:id)};
        state.outfits.push(saved);return route.fulfill({json:saved});
      }
      if(p==='/api/import/library/broken.png')return route.fulfill({contentType:'image/png',body:'invalid image'});
      if(p.endsWith('/accessories'))return route.fulfill({json:{hasApiKey:false}});
      if(p==='/api/import/wardrobe/availability'&&method==='POST'){
        const body=route.request().postDataJSON(); state.updates.push(body);
        if(state.failWrite)return route.fulfill({status:503,json:{error:'Could not save availability. Try again.'}});
        if(state.conflict||body.items.some(piece=>!state.items.some(item=>item.id===piece.id&&item.revision===piece.revision)))return route.fulfill({status:409,json:{error:'This item changed on another device. Refresh and try again.'}});
        const ids=new Set(body.items.map(item=>item.id));
        state.items=state.items.map(item=>ids.has(item.id)?{...item,availability:body.availability,revision:crypto.randomUUID()}:item);
        return route.fulfill({json:state.items.filter(item=>ids.has(item.id))});
      }
      const edit=p.match(/^\/api\/import\/wardrobe\/([^/]+)$/);
      if(edit&&method==='PATCH'){
        const body=route.request().postDataJSON(),item=state.items.find(i=>i.id===edit[1]);
        Object.assign(item,body.changes,{revision:crypto.randomUUID()});return route.fulfill({json:item});
      }
      const wear=p.match(/^\/api\/outfits\/([^/]+)\/wears(?:\/([^/]+)\/remove)?$/);
      if(wear&&method==='POST'){
        const outfit=state.outfits.find(o=>o.id===wear[1]),body=route.request().postDataJSON();
        if(wear[2])outfit.wearHistory=outfit.wearHistory.filter(e=>e.id!==wear[2]);
        else outfit.wearHistory=[...(outfit.wearHistory||[]),{id:crypto.randomUUID(),date:body.date,garmentIds:body.garmentIds||outfit.garmentIds,createdAt:'2026-10-22T12:00:00Z'}];
        return route.fulfill({json:outfit});
      }
      health.errors.push(`Unexpected API ${method} ${p}`);return route.fulfill({status:500,json:{}});
    });
    await page.goto('/');await expect(page).toHaveTitle('Open Wardrobe');
    await expect(page.getByRole('region',{name:'Wear a piece again'})).toBeVisible();
    await use(state);
    await expect(page.locator('vite-error-overlay')).toHaveCount(0);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    expect(await page.locator('dialog[open]').evaluateAll(nodes=>nodes.every(n=>n.scrollWidth<=n.clientWidth+1))).toBe(true);
    await writeFile(info.outputPath('browser-health.json'),JSON.stringify(health,null,2));
    expect(health).toEqual({errors:[],failedRequests:[],httpErrors:[]});
  },
});


test.use({locale:'en-GB'});
const modal=page=>page.getByRole('dialog',{name:'Save what you wore',exact:true});
const bulk=page=>page.getByRole('region',{name:'Select pieces to log wear'});
const nav=(page,name)=>page.getByRole('navigation',{name:'Main navigation'}).getByRole('link',{name,exact:true});
async function logCombination(page,ids=['Navy blouse','Stone trousers','Silk scarf']){
  await page.getByRole('button',{name:'Log wear',exact:true}).click();
  for(const name of ids)await page.locator('.wear-select').getByRole('checkbox',{name,exact:true}).check();
  await bulk(page).getByRole('button',{name:ids.length===1?'Wore this today':'Wore these today',exact:true}).click();
  await expect(bulk(page).getByRole('button',{name:'Undo',exact:true})).toBeVisible();
  await bulk(page).getByRole('button',{name:'Save as a look',exact:true}).click();
  await expect(modal(page)).toBeVisible();
}
async function fillLook(page,name='Everyday with a scarf'){
  await modal(page).getByRole('textbox',{name:'Look name',exact:true}).fill(name);
  await modal(page).getByLabel('Look occasion',{exact:true}).fill('work');
}

test('save a worn combination, favourite it and plan tomorrow; no extra wear or laundry changes',async({page,wardrobe},info)=>{
  const original=structuredClone(wardrobe.outfits);
  await logCombination(page);
  const preview=modal(page).getByRole('region',{name:'Worn look cutout preview'});
  await expect(preview.getByRole('img')).toHaveCount(3);
  await expect.poll(()=>preview.getByRole('img').evaluateAll(images=>images.every(image=>image.complete&&image.naturalWidth>0))).toBe(true);
  await page.screenshot({path:info.outputPath('worn-look-preview.png')});
  await fillLook(page);
  await expect(modal(page).getByRole('button',{name:'Save look',exact:true})).toBeEnabled();
  await modal(page).locator('.worn-look-fields').screenshot({path:info.outputPath('worn-look-controls.png')});
  await modal(page).getByRole('button',{name:'Save look',exact:true}).click();
  await expect(modal(page).getByText('Look saved:',{exact:false})).toBeVisible();
  expect(wardrobe.savePosts[0].garmentIds).toEqual(['navy','stone','solo']);
  expect(wardrobe.garmentWears).toHaveLength(1);expect(wardrobe.updates).toHaveLength(0);
  expect(wardrobe.outfits.slice(0,4)).toEqual(original);
  expect(wardrobe.outfits[4].wearHistory).toBeUndefined();
  await modal(page).getByRole('button',{name:'Open saved look',exact:true}).click();
  const look=page.getByRole('dialog',{name:'Everyday with a scarf',exact:true});
  await expect(look).toBeVisible();
  await expect(look.getByText('Cutout preview',{exact:true})).toBeVisible();
  await expect(look.getByRole('button',{name:'Create modelled photo',exact:true})).toHaveCount(0);
  await look.getByRole('button',{name:'Add Everyday with a scarf to favourites',exact:true}).click();
  await look.getByRole('button',{name:'Plan for tomorrow',exact:true}).click();
  await page.getByRole('dialog',{name:'Plan for tomorrow',exact:true}).getByRole('button',{name:'Save plan',exact:true}).click();
  await page.reload();
  await expect(page.getByRole('article',{name:'Tomorrow’s plan'}).getByRole('heading',{name:'Everyday with a scarf',exact:true})).toBeVisible();
  expect(wardrobe.outfits[4].favourite).toBe(true);
  expect(wardrobe.outfits[4].wearHistory).toBeUndefined();
});

test('exact matching combinations open the existing look without another save; review can choose a subset',async({page,wardrobe})=>{
  await logCombination(page,['Navy blouse','Stone trousers','Silk scarf']);
  await modal(page).getByRole('checkbox',{name:'Silk scarf',exact:true}).uncheck();
  await expect(modal(page).getByText('Already saved:',{exact:false})).toBeVisible();
  await fillLook(page);
  await expect(modal(page).getByRole('button',{name:'Save look',exact:true})).toBeDisabled();
  await modal(page).getByRole('button',{name:'Open saved look',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'An easy morning',exact:true})).toBeVisible();
  expect(wardrobe.savePosts).toHaveLength(0);expect(wardrobe.outfits).toHaveLength(4);
});

test('saving keeps selected laundry and Undo independent; saved look remains and shortlist waits for Ready',async({page,wardrobe})=>{
  await logCombination(page,['Olive shirt','Rust skirt']);await fillLook(page,'Olive and rust');
  await expect(modal(page).getByText('In laundry',{exact:true})).toBeVisible();
  await modal(page).getByRole('button',{name:'Save look',exact:true}).click();
  await expect(modal(page).getByText('Look saved:',{exact:false})).toBeVisible();
  await modal(page).getByRole('button',{name:'Close',exact:true}).click();
  await bulk(page).getByRole('button',{name:'Undo',exact:true}).click();
  expect(wardrobe.garmentWears).toHaveLength(0);expect(wardrobe.outfits).toHaveLength(5);
  expect(wardrobe.items.find(item=>item.id==='olive').availability).toBe('laundry');
  await nav(page,'Outfits').click();
  const shortlist=page.getByRole('region',{name:'What to wear',exact:true});
  await shortlist.getByRole('combobox',{name:'Shortlist occasion',exact:true}).selectOption('work');
  await expect(shortlist.getByRole('button',{name:'Choose Olive and rust',exact:true})).toHaveCount(0);
  wardrobe.items.find(item=>item.id==='olive').availability='ready';
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(shortlist.getByRole('button',{name:'Choose Olive and rust',exact:true})).toBeEnabled();
});

test('failed saves and uncertain responses recover safely; stale revisions refresh before retry',async({page,wardrobe})=>{
  await logCombination(page);await fillLook(page);
  wardrobe.failSave=true;
  await modal(page).getByRole('button',{name:'Save look',exact:true}).click();
  await expect(modal(page).getByRole('alert')).toContainText('Could not save this look');
  expect(wardrobe.outfits).toHaveLength(4);
  wardrobe.failSave=false;wardrobe.staleSave=true;
  await modal(page).getByRole('button',{name:'Save look',exact:true}).click();
  await expect(modal(page).getByRole('alert')).toContainText('A selected piece changed');
  expect(wardrobe.savePosts[0].requestId).toBe(wardrobe.savePosts[1].requestId);
  wardrobe.staleSave=false;wardrobe.loseSaveResponse=true;
  await modal(page).getByRole('button',{name:'Save look',exact:true}).click();
  await expect(modal(page).getByText('Look saved:',{exact:false})).toBeVisible();
  expect(wardrobe.savePosts[2].requestId).not.toBe(wardrobe.savePosts[1].requestId);
  expect(wardrobe.outfits).toHaveLength(5);
});

test('reloaded entries open from garment history; missing cutouts, removed entries and failed reads block saving',async({page,wardrobe})=>{
  await logCombination(page);await modal(page).getByRole('button',{name:'Close',exact:true}).click();
  await page.reload();
  await page.getByRole('button',{name:'View Navy blouse',exact:true}).click();
  const viewer=page.getByRole('dialog',{name:'Selected wardrobe item',exact:true});
  await viewer.getByText('Log another date or edit Wardrobe entries',{exact:true}).click();
  await viewer.getByRole('button',{name:'Save as a look',exact:true}).click();await fillLook(page);
  wardrobe.items.find(item=>item.id==='navy').image='/api/import/library/broken.png';
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(modal(page).getByRole('button',{name:'Retry cutouts',exact:true})).toBeVisible();
  await expect(modal(page).getByRole('button',{name:'Save look',exact:true})).toBeDisabled();
  wardrobe.items.find(item=>item.id==='navy').image=photos[0];
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(modal(page).getByRole('button',{name:'Save look',exact:true})).toBeEnabled();
  wardrobe.failCollection=true;
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(modal(page).getByRole('button',{name:'Save look',exact:true})).toBeDisabled();
  wardrobe.failCollection=false;
  await modal(page).getByRole('button',{name:'Refresh wardrobe and looks',exact:true}).click();
  await expect(modal(page).getByRole('button',{name:'Save look',exact:true})).toBeEnabled();
  wardrobe.garmentWears=[];
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(modal(page).getByText(/This wear entry was removed/)).toBeVisible();
  await expect(modal(page).getByRole('button',{name:'Save look',exact:true})).toBeDisabled();
  await modal(page).getByRole('button',{name:'Close',exact:true}).click();
  await expect(viewer).toBeVisible();
  expect(wardrobe.savePosts).toHaveLength(0);
});

test('review requires one complete look and can save a dress subset while keeping the original logged pieces',async({page,wardrobe})=>{
  await logCombination(page,['Navy blouse','Stone trousers','Plum dress']);
  await fillLook(page,'The plum dress');
  await expect(modal(page).getByText(/Choose one dress or one top and one bottom/)).toBeVisible();
  await expect(modal(page).getByRole('button',{name:'Save look',exact:true})).toBeDisabled();
  await modal(page).getByRole('checkbox',{name:'Navy blouse',exact:true}).uncheck();
  await modal(page).getByRole('checkbox',{name:'Stone trousers',exact:true}).uncheck();
  await expect(modal(page).getByRole('button',{name:'Save look',exact:true})).toBeEnabled();
  await modal(page).getByRole('button',{name:'Save look',exact:true}).click();
  await expect(modal(page).getByText('Look saved:',{exact:false})).toBeVisible();
  expect(wardrobe.outfits[4].garmentIds).toEqual(['dress']);
  expect(wardrobe.garmentWears[0].garmentIds).toEqual(['navy','dress','stone']);
});

test('late focus reads cannot overwrite a newly saved worn look and closing waits for the save',async({page,wardrobe})=>{
  await logCombination(page);await fillLook(page);
  const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
  const posted=deferred(),releasePost=deferred(),read=deferred(),releaseRead=deferred(),finished=deferred();
  await page.route('**/api/outfits/garment-wears/*/look',async route=>{posted.resolve();await releasePost.promise;await route.fallback();});
  await modal(page).getByRole('button',{name:'Save look',exact:true}).click();await posted.promise;
  await expect(modal(page).getByRole('button',{name:'Close',exact:true})).toBeDisabled();
  await page.route('**/api/outfits',async route=>{
    const snapshot=structuredClone({outfits:wardrobe.outfits,garmentWears:wardrobe.garmentWears,plans:wardrobe.plans,plansRevision:wardrobe.plansRevision});
    read.resolve();await releaseRead.promise;try{await route.fulfill({json:snapshot});}finally{finished.resolve();}
  },{times:1});
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await read.promise;
  releasePost.resolve();await expect(modal(page).getByText('Look saved:',{exact:false})).toBeVisible();
  releaseRead.resolve();await finished.promise;
  await modal(page).getByRole('button',{name:'Open saved look',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'Everyday with a scarf',exact:true})).toBeVisible();
  expect(wardrobe.outfits).toHaveLength(5);
});
