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
    const state={items:structuredClone(initial),outfits:structuredClone(saved),updates:[],failWrite:false,failRead:false,conflict:false,plans:[],plansRevision:"initial",posts:[],failCollection:false};
    const health={errors:[],failedRequests:[],httpErrors:[]};
    const expectedStatus=(status,url)=>[409,503].includes(status)&&['/api/import/wardrobe','/api/import/wardrobe/availability','/api/outfits/plans','/api/outfits'].includes(new URL(url).pathname);
    page.on('pageerror',e=>health.errors.push(e.message));
    page.on('console',m=>{if(m.type()==='error'&&!(/409 \(Conflict\)|503 \(Service Unavailable\)/.test(m.text())&&['/api/import/wardrobe','/api/import/wardrobe/availability','/api/outfits/plans','/api/outfits'].includes(new URL(m.location().url||'http://test').pathname)))health.errors.push(m.text());});
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
      if(p==='/api/outfits')return state.failCollection?route.fulfill({status:503,json:{error:'Collection unavailable.'}}):route.fulfill({json:{outfits:state.outfits,plans:state.plans,plansRevision:state.plansRevision}});
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

const panel=page=>page.getByRole('region',{name:'Wear a piece again'});
const viewer=page=>page.getByRole('dialog',{name:'Selected wardrobe item'});
const history=page=>viewer(page).getByRole('region',{name:'Wear history and ready looks'});
const nav=(page,name)=>page.getByRole('navigation',{name:'Main navigation'}).getByRole('link',{name,exact:true});
async function openNavy(page){
  await panel(page).getByRole('button',{name:'Wear Navy blouse',exact:true}).click();
  await expect(history(page).getByText('1 day logged · Last worn 1 Sept 2026',{exact:true})).toBeVisible();
}

test('Ready garments have accurate cross-look history and category filtering; unknown history stays explicit',async({page,wardrobe},info)=>{
  await expect(panel(page).locator('strong')).toHaveText(['Navy blouse','Stone trousers','Rust skirt']);
  await expect(panel(page).getByText('1 day logged · Last worn 10 Sept 2026',{exact:true})).toBeVisible();
  await panel(page).screenshot({path:info.outputPath('rediscovery-pieces.png')});
  await page.screenshot({path:info.outputPath('rediscovery-first-viewport.png')});
  await page.getByRole('button',{name:'Tops',exact:true}).click();
  await expect(panel(page).locator('strong')).toHaveText(['Navy blouse']);
  await page.getByRole('button',{name:'Accessories',exact:true}).click();
  await expect(panel(page).getByText('No wears logged',{exact:true})).toBeVisible();
  await panel(page).getByRole('button',{name:'Wear Silk scarf',exact:true}).click();
  await expect(history(page).getByText('No saved looks contain this piece yet.',{exact:false})).toBeVisible();
  await expect(history(page).getByRole('button',{name:'Plan for tomorrow'})).toHaveCount(0);
  expect(wardrobe.posts).toHaveLength(0);
});

test('matching Ready looks filter by occasion and directly open today or tomorrow planning',async({page,wardrobe},info)=>{
  await openNavy(page);
  await history(page).getByText('Logged dates',{exact:true}).click();
  await expect(history(page).getByRole('time')).toHaveText(['1 Sept 2026']);
  await expect(history(page).getByRole('article')).toHaveCount(3);
  await history(page).getByRole('combobox',{name:'Look occasion',exact:true}).selectOption('work');
  const look=history(page).getByRole('article',{name:'Navy for work',exact:true});
  await expect(look.getByRole('button',{name:'Plan for tomorrow',exact:true})).toBeEnabled();
  await history(page).screenshot({path:info.outputPath('rediscovery-ready-looks.png')});
  await look.getByRole('button',{name:'Plan for tomorrow',exact:true}).click();
  const chooser=page.getByRole('dialog',{name:'Plan for tomorrow',exact:true});
  await expect(chooser.getByRole('combobox',{name:'Saved look'})).toHaveValue('navy-variation');
  await chooser.getByRole('button',{name:'Save plan',exact:true}).click();
  expect(wardrobe.plans).toEqual([{date:'2026-10-24',outfitId:'navy-variation'}]);
  await nav(page,'Wardrobe').click();await openNavy(page);
  await history(page).getByRole('article',{name:'An easy morning',exact:true}).getByRole('button',{name:'Plan for today',exact:true}).click();
  await page.getByRole('dialog',{name:'Plan for today',exact:true}).getByRole('button',{name:'Save plan',exact:true}).click();
  expect(wardrobe.plans).toHaveLength(2);
  await page.reload();
  await expect(page.getByRole('article',{name:'Today’s plan'}).getByRole('heading',{name:'An easy morning'})).toBeVisible();
});

test('logging and undo update garment history immediately; laundry excludes matching looks and can be restored',async({page,wardrobe})=>{
  await openNavy(page);
  await history(page).getByRole('article',{name:'An easy morning',exact:true}).getByRole('button',{name:'View look',exact:true}).click();
  const look=page.getByRole('dialog',{name:'An easy morning',exact:true});
  await look.getByRole('button',{name:'Wore this today',exact:true}).click();
  await expect(look.getByRole('button',{name:'Undo',exact:true})).toBeVisible();
  await look.getByRole('button',{name:'Close',exact:true}).click();await nav(page,'Wardrobe').click();
  await page.getByRole('button',{name:'View Navy blouse',exact:true}).click();
  await expect(history(page).getByText('2 days logged · Last worn 23 Oct 2026',{exact:true})).toBeVisible();
  await history(page).getByRole('article',{name:'An easy morning',exact:true}).getByRole('button',{name:'View look',exact:true}).click();
  await look.getByRole('button',{name:'Undo',exact:true}).click();
  await look.getByRole('button',{name:'Close',exact:true}).click();await nav(page,'Wardrobe').click();await openNavy(page);
  wardrobe.items.find(i=>i.id==='stone').availability='laundry';
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(history(page).getByRole('article')).toHaveCount(1);
  await expect(history(page).getByText(/2 left out for laundry/)).toBeVisible();
  wardrobe.items.find(i=>i.id==='stone').availability='ready';
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(history(page).getByRole('article')).toHaveCount(3);
});

test('collection and wardrobe refresh failures hide stale choices and recover; dirty edits block planning',async({page,wardrobe})=>{
  wardrobe.failCollection=true;
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(panel(page).getByRole('button',{name:/Wear /})).toHaveCount(0);
  await expect(panel(page).getByText(/Wear history and saved looks could not be refreshed/)).toBeVisible();
  wardrobe.failCollection=false;
  await panel(page).getByRole('button',{name:'Refresh rediscovery',exact:true}).click();await openNavy(page);
  await viewer(page).getByRole('textbox',{name:'Name',exact:true}).fill('Edited blouse');
  await expect(history(page).getByRole('button',{name:'Plan for today'}).first()).toBeDisabled();
  await viewer(page).getByRole('button',{name:'Discard changes',exact:true}).click();
  await openNavy(page);
  await expect(history(page).getByRole('button',{name:'Plan for today'}).first()).toBeEnabled();
  wardrobe.failRead=true;
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(history(page).getByRole('article')).toHaveCount(0);
  wardrobe.failRead=false;
  await history(page).getByRole('button',{name:'Refresh rediscovery',exact:true}).click();
  await expect(history(page).getByRole('article')).toHaveCount(3);
});

test('broken cutouts and look previews are excluded, retryable, and never enabled for planning',async({page,wardrobe})=>{
  wardrobe.items.find(i=>i.id==='navy').image='/api/import/library/broken.png';
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(panel(page).getByRole('button',{name:'Wear Navy blouse',exact:true})).toHaveCount(0);
  await expect(panel(page).getByRole('button',{name:'Retry cutouts',exact:true})).toBeVisible();
  wardrobe.items.find(i=>i.id==='navy').image=photos[0];
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await openNavy(page);
  wardrobe.outfits.find(o=>o.id==='navy-variation').image='/api/import/library/broken.png';
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(history(page).getByRole('article',{name:'Navy for work',exact:true})).toHaveCount(0);
  await expect(history(page).getByRole('button',{name:'Retry look images',exact:true})).toBeVisible();
  wardrobe.outfits.find(o=>o.id==='navy-variation').image=photos[0];
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(history(page).getByRole('article',{name:'Navy for work',exact:true}).getByRole('button',{name:'Plan for tomorrow',exact:true})).toBeEnabled();
});
