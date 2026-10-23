import { test as base, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import sharp from 'sharp';

const artwork = async (color, index) => `data:image/png;base64,${(await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="#eee8de"/><path d="${index === 1 || index === 3 ? 'M140 65 H260 L285 345 H220 L200 165 L180 345 H115Z' : 'M135 70 L175 55 Q200 82 225 55 L265 70 L320 150 L280 180 L255 150 L260 330 H140 L145 150 L120 180 L80 150Z'}" fill="${color}"/></svg>`)).png().toBuffer()).toString('base64')}`;
const photos = await Promise.all(['#35495a','#c5b79a','#827455','#a76e58'].map(artwork));
const initial = [
  { id:'navy', name:'Navy blouse', part:'upperbody', color:'#35495a', image:photos[0] },
  { id:'stone', name:'Stone trousers', part:'lowerbody', color:'#c5b79a', image:photos[1] },
  { id:'olive', name:'Olive shirt', part:'upperbody', color:'#827455', image:photos[2], availability:'laundry' },
  { id:'rust', name:'Rust skirt', part:'lowerbody', color:'#a76e58', image:photos[3], availability:'ready' },
  { id:'solo', name:'Silk scarf', part:'accessories_up', color:'#a76e58', image:photos[3] },
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
    const state={items:structuredClone(initial),outfits:structuredClone(saved),updates:[],failWrite:false,failRead:false,conflict:false,plans:[],plansRevision:"initial",posts:[],failCollection:false,garmentWears:[],wearPosts:[],removed:[],loseResponse:false};
    const health={errors:[],failedRequests:[],httpErrors:[]};
    const expectedStatus=(status,url)=>[409,503].includes(status)&&['/api/import/wardrobe','/api/import/wardrobe/availability','/api/outfits/plans','/api/outfits','/api/outfits/garment-wears'].includes(new URL(url).pathname.replace(/\/garment-wears\/[^/]+\/remove$/, '/garment-wears'));
    page.on('pageerror',e=>health.errors.push(e.message));
    page.on('console',m=>{if(m.type()==='error'&&!(/409 \(Conflict\)|503 \(Service Unavailable\)/.test(m.text())&&['/api/import/wardrobe','/api/import/wardrobe/availability','/api/outfits/plans','/api/outfits','/api/outfits/garment-wears'].includes(new URL(m.location().url||'http://test').pathname.replace(/\/garment-wears\/[^/]+\/remove$/, '/garment-wears'))))health.errors.push(m.text());});
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
const viewer=page=>page.getByRole('dialog',{name:'Selected wardrobe item'});
const history=page=>viewer(page).getByRole('region',{name:'Wear history and ready looks'});
const controls=page=>viewer(page).getByRole('region',{name:'Log garment wear'});
const bulk=page=>page.getByRole('region',{name:'Select pieces to log wear'});
const nav=(page,name)=>page.getByRole('navigation',{name:'Main navigation'}).getByRole('link',{name,exact:true});
async function openNavy(page){await page.getByRole('button',{name:'View Navy blouse',exact:true}).click();}
async function backdate(region,date){await region.getByText('Log another date or edit Wardrobe entries',{exact:true}).click();await region.getByLabel('Date worn',{exact:true}).fill(date);}

test('individual today and backdated logging updates garment history and survives reload for correction',async({page,wardrobe},info)=>{
  wardrobe.plans=[{date:'2026-10-23',outfitId:'navy-look'}];
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await openNavy(page);
  await controls(page).getByRole('button',{name:'Wore this today',exact:true}).click();
  await expect(history(page).getByText('2 days logged · Last worn 23 Oct 2026',{exact:true})).toBeVisible();
  await expect(controls(page).getByRole('button',{name:'Worn today',exact:true})).toBeDisabled();
  expect(wardrobe.updates).toHaveLength(0);
  expect(wardrobe.outfits[0].wearHistory).toHaveLength(1);
  await backdate(controls(page),'2026-10-21');
  await controls(page).getByRole('button',{name:'Log wear',exact:true}).click();
  await expect(history(page).getByText('3 days logged · Last worn 23 Oct 2026',{exact:true})).toBeVisible();
  await history(page).getByText('Logged dates',{exact:true}).click();
  await expect(history(page).getByRole('time')).toHaveText(['23 Oct 2026','21 Oct 2026','1 Sept 2026']);
  await controls(page).screenshot({path:info.outputPath('garment-wear-individual.png')});
  await history(page).screenshot({path:info.outputPath('garment-wear-history.png')});
  await page.reload();await openNavy(page);
  await expect(history(page).getByText('3 days logged · Last worn 23 Oct 2026',{exact:true})).toBeVisible();
  await controls(page).getByText('Log another date or edit Wardrobe entries',{exact:true}).click();
  await controls(page).getByRole('button',{name:'Remove Wardrobe entry on 21 Oct 2026 for 1 piece',exact:true}).click();
  await expect(history(page).getByText('2 days logged · Last worn 23 Oct 2026',{exact:true})).toBeVisible();
  expect(wardrobe.garmentWears).toHaveLength(1);
  await viewer(page).getByRole('button',{name:'Close',exact:true}).click();await nav(page,'Outfits').click();
  await expect(page.getByRole('article',{name:'Today’s plan'}).getByText('Planned only · No wear confirmed.',{exact:true})).toBeVisible();
  await expect(page.getByRole('article',{name:'Today’s plan'}).getByRole('button',{name:'Wore this',exact:true})).toBeEnabled();
});

test('bulk selection follows category; laundry is explicit and remains separate from Undo',async({page,wardrobe},info)=>{
  await page.getByRole('button',{name:'Log wear',exact:true}).click();
  await expect(bulk(page).getByRole('button',{name:'Wore these today',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'Tops',exact:true}).click();
  await bulk(page).getByRole('checkbox',{name:'Select all shown for wear logging'}).check();
  await bulk(page).getByRole('button',{name:'Wore these today',exact:true}).click();
  await expect(bulk(page).getByRole('button',{name:'Undo',exact:true})).toBeVisible();
  expect(wardrobe.garmentWears[0].garmentIds).toEqual(['navy','olive']);
  expect(wardrobe.updates).toHaveLength(0);
  await bulk(page).getByText('Send pieces to laundry (optional)',{exact:true}).click();
  const laundry=bulk(page).getByRole('group',{name:'Pieces for laundry',exact:true});
  await expect(laundry.getByRole('checkbox',{name:'Navy blouse',exact:true})).not.toBeChecked();
  await expect(laundry.getByRole('checkbox',{name:'Olive shirt · In laundry',exact:true})).toBeDisabled();
  await expect(bulk(page).getByRole('button',{name:'Send selected to laundry'})).toBeDisabled();
  await laundry.getByRole('checkbox',{name:'Navy blouse',exact:true}).check();
  await bulk(page).screenshot({path:info.outputPath('garment-wear-bulk.png')});
  await page.screenshot({path:info.outputPath('garment-wear-wardrobe.png')});
  await bulk(page).getByRole('button',{name:'Send selected to laundry'}).click();
  await expect(bulk(page).getByText('1 piece sent to laundry.',{exact:true})).toBeVisible();
  await bulk(page).getByRole('button',{name:'Undo',exact:true}).click();
  await expect(bulk(page).getByRole('button',{name:'Wore these today',exact:true})).toBeEnabled();
  expect(wardrobe.garmentWears).toHaveLength(0);
  expect(wardrobe.items.find(i=>i.id==='navy').availability).toBe('laundry');
  expect(wardrobe.items.find(i=>i.id==='stone').availability).toBeUndefined();
  await page.getByRole('button',{name:'Bottoms',exact:true}).click();
  await expect(bulk(page).getByText('0 pieces selected',{exact:true})).toBeVisible();
  await page.getByRole('combobox',{name:'Availability',exact:true}).selectOption('laundry');
  await expect(bulk(page)).toHaveCount(0);
  await page.getByRole('button',{name:'All',exact:true}).click();
  await page.getByRole('button',{name:'Log wear',exact:true}).click();
  await bulk(page).getByRole('checkbox',{name:'Select all shown for wear logging'}).check();
  await backdate(bulk(page),'2026-10-20');
  await bulk(page).getByRole('button',{name:'Log wear',exact:true}).click();
  await expect(bulk(page).getByRole('button',{name:'Undo',exact:true})).toBeVisible();
  expect(wardrobe.garmentWears[0].date).toBe('2026-10-20');
  expect(wardrobe.garmentWears[0].garmentIds).toEqual(['navy','olive']);
});

test('outfit and direct logs count once per garment per day and direct Undo preserves outfit history and plans',async({page,wardrobe})=>{
  wardrobe.outfits[0].wearHistory.push({id:crypto.randomUUID(),date:'2026-10-23',garmentIds:['navy'],createdAt:'2026-10-23T12:00:00Z'});
  wardrobe.plans=[{date:'2026-10-23',outfitId:'navy-look'}];
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await openNavy(page);
  await expect(controls(page).getByRole('button',{name:'Worn today',exact:true})).toBeDisabled();
  await viewer(page).getByRole('button',{name:'Close',exact:true}).click();
  await page.getByRole('button',{name:'Log wear',exact:true}).click();
  await page.locator('.wear-select').getByRole('checkbox',{name:'Navy blouse',exact:true}).check();
  await page.locator('.wear-select').getByRole('checkbox',{name:'Stone trousers',exact:true}).check();
  await bulk(page).getByRole('button',{name:'Wore these today',exact:true}).click();
  await page.getByRole('button',{name:'Done selecting',exact:true}).click();await openNavy(page);
  await expect(history(page).getByText('2 days logged · Last worn 23 Oct 2026',{exact:true})).toBeVisible();
  await controls(page).getByText('Log another date or edit Wardrobe entries',{exact:true}).click();
  await controls(page).getByRole('button',{name:'Remove Wardrobe entry on 23 Oct 2026 for 2 pieces',exact:true}).click();
  await expect(history(page).getByText('2 days logged · Last worn 23 Oct 2026',{exact:true})).toBeVisible();
  await expect(controls(page).getByRole('button',{name:'Worn today',exact:true})).toBeDisabled();
  expect(wardrobe.outfits[0].wearHistory).toHaveLength(2);
  expect(wardrobe.plans).toEqual([{date:'2026-10-23',outfitId:'navy-look'}]);
  await viewer(page).getByRole('button',{name:'Close',exact:true}).click();
  await nav(page,'Outfits').click();
  await expect(page.getByRole('article',{name:'Today’s plan'}).getByRole('button',{name:'Wear confirmed',exact:true})).toBeDisabled();
  const shortlist=page.getByRole('region',{name:'What to wear',exact:true});
  await shortlist.getByText('Piece history',{exact:true}).first().click();
  await expect(shortlist.getByText('2 days logged · Last worn 23 Oct 2026',{exact:true}).first()).toBeVisible();
});

test('failed logging and Undo recover, retry the same entry safely, and recover a saved response lost in transit',async({page,wardrobe})=>{
  await openNavy(page);wardrobe.failWrite=true;wardrobe.failCollection=true;
  await controls(page).getByRole('button',{name:'Wore this today',exact:true}).click();
  await expect(controls(page).getByRole('alert')).toContainText('Could not save wear');
  await expect(controls(page).getByRole('button',{name:'Wore this today',exact:true})).toBeDisabled();
  wardrobe.failWrite=false;wardrobe.failCollection=false;
  await controls(page).getByRole('button',{name:'Refresh wear history',exact:true}).click();
  await controls(page).getByRole('button',{name:'Wore this today',exact:true}).click();
  await expect(controls(page).getByRole('button',{name:'Undo',exact:true})).toBeVisible();
  expect(wardrobe.wearPosts[0].requestId).toBe(wardrobe.wearPosts[1].requestId);
  wardrobe.failWrite=true;
  await controls(page).getByRole('button',{name:'Undo',exact:true}).click();
  await expect(controls(page).getByRole('alert')).toContainText('Could not save wear');
  expect(wardrobe.garmentWears).toHaveLength(1);
  wardrobe.failWrite=false;
  await controls(page).getByRole('button',{name:'Undo',exact:true}).click();
  await expect(history(page).getByText('1 day logged · Last worn 1 Sept 2026',{exact:true})).toBeVisible();
  wardrobe.loseResponse=true;
  await controls(page).getByRole('button',{name:'Wore this today',exact:true}).click();
  await expect(controls(page).getByRole('button',{name:'Undo',exact:true})).toBeVisible();
  expect(wardrobe.garmentWears).toHaveLength(1);
  await expect(history(page).getByText('2 days logged · Last worn 23 Oct 2026',{exact:true})).toBeVisible();
});

test('unsaved garment edits and stale history block logging; dates reject future and follow the local day',async({page,wardrobe})=>{
  await openNavy(page);
  await viewer(page).getByRole('textbox',{name:'Name',exact:true}).fill('Edited blouse');
  await expect(controls(page).getByRole('button',{name:'Wore this today',exact:true})).toBeDisabled();
  await viewer(page).getByRole('button',{name:'Discard changes',exact:true}).click();await openNavy(page);
  wardrobe.failRead=true;
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(controls(page).getByText(/Your wardrobe could not be refreshed/)).toBeVisible();
  await expect(controls(page).getByRole('button',{name:'Wore this today',exact:true})).toBeDisabled();
  wardrobe.failRead=false;
  await controls(page).getByRole('button',{name:'Refresh wear history',exact:true}).click();
  await expect(controls(page).getByRole('button',{name:'Wore this today',exact:true})).toBeEnabled();
  await backdate(controls(page),'2026-10-24');
  await expect(controls(page).getByRole('button',{name:'Log wear',exact:true})).toBeDisabled();
  await controls(page).getByLabel('Date worn',{exact:true}).fill('');
  await expect(controls(page).getByRole('button',{name:'Log wear',exact:true})).toBeDisabled();
  wardrobe.failCollection=true;
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(controls(page).getByRole('button',{name:'Wore this today',exact:true})).toBeDisabled();
  wardrobe.failCollection=false;
  wardrobe.garmentWears.push({id:crypto.randomUUID(),date:'2026-10-23',garmentIds:['navy'],createdAt:'2026-10-23T12:00:00Z'});
  await controls(page).getByRole('button',{name:'Refresh wear history',exact:true}).click();
  await expect(controls(page).getByRole('button',{name:'Worn today',exact:true})).toBeDisabled();
  await page.clock.setFixedTime(new Date('2026-10-24T12:00:00Z'));
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(controls(page).getByRole('button',{name:'Wore this today',exact:true})).toBeEnabled();
  await expect(controls(page).getByLabel('Date worn',{exact:true})).toHaveAttribute('max','2026-10-24');
  await controls(page).getByRole('button',{name:'Wore this today',exact:true}).click();
  await expect(history(page).getByText('3 days logged · Last worn 24 Oct 2026',{exact:true})).toBeVisible();
});

test('without saved looks, logging works and a late focus read cannot replace a saved garment entry',async({page,wardrobe})=>{
  wardrobe.outfits=[];
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await openNavy(page);
  await expect(history(page).getByText('No wears logged',{exact:true})).toBeVisible();
  await expect(history(page).getByText(/No saved looks contain this piece yet/)).toBeVisible();
  const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
  const postStarted=deferred(),releasePost=deferred(),readStarted=deferred(),releaseRead=deferred(),readFinished=deferred();
  await page.route('**/api/outfits/garment-wears',async route=>{postStarted.resolve();await releasePost.promise;await route.fallback();});
  await controls(page).getByRole('button',{name:'Wore this today',exact:true}).click();
  await postStarted.promise;
  await page.route('**/api/outfits',async route=>{
    const snapshot=structuredClone({outfits:wardrobe.outfits,garmentWears:wardrobe.garmentWears,plans:wardrobe.plans,plansRevision:wardrobe.plansRevision});
    readStarted.resolve();await releaseRead.promise;
    try{await route.fulfill({json:snapshot});}finally{readFinished.resolve();}
  },{times:1});
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await readStarted.promise;
  releasePost.resolve();
  await expect(controls(page).getByRole('button',{name:'Undo',exact:true})).toBeVisible();
  releaseRead.resolve();await readFinished.promise;
  await expect(history(page).getByText('1 day logged · Last worn 23 Oct 2026',{exact:true})).toBeVisible();
  await expect(controls(page).getByRole('button',{name:'Worn today',exact:true})).toBeDisabled();
});
