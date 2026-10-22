import { test as base, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import sharp from 'sharp';

const artwork = async (color, index) => `data:image/png;base64,${(await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="#eee8de"/><path d="${index === 1 || index === 3 ? 'M140 65 H260 L285 345 H220 L200 165 L180 345 H115Z' : 'M135 70 L175 55 Q200 82 225 55 L265 70 L320 150 L280 180 L255 150 L260 330 H140 L145 150 L120 180 L80 150Z'}" fill="${color}"/></svg>`)).png().toBuffer()).toString('base64')}`;
const photos = await Promise.all(['#35495a','#c5b79a','#827455','#a76e58'].map(artwork));
const initial = [
  { id:'navy', name:'Navy blouse', part:'upperbody', color:'#35495a', image:photos[0] },
  { id:'stone', name:'Stone trousers', part:'lowerbody', color:'#c5b79a', image:photos[1] },
  { id:'olive', name:'Olive shirt', part:'upperbody', color:'#827455', image:photos[2], availability:'laundry' },
  { id:'rust', name:'Rust skirt', part:'lowerbody', color:'#a76e58', image:photos[3], availability:'laundry' },
].map(item=>({...item,tags:[],revision:item.id}));
const saved = [
  { id:'navy-look',name:'An easy morning',garmentIds:['navy','stone'],image:photos[0],occasion:['casual'] },
  { id:'olive-look',name:'Olive afternoon',garmentIds:['olive','stone'],image:photos[2],occasion:['casual'] },
  { id:'rust-look',name:'Dinner in rust',garmentIds:['navy','rust'],image:photos[3],occasion:['dinner'] },
].map(outfit=>({...outfit,status:'accepted',reason:'Familiar wardrobe pieces.',favourite:true}));
const test=base.extend({
  wardrobe:async({page,context},use,info)=>{
    const state={items:structuredClone(initial),outfits:structuredClone(saved),updates:[],failWrite:false,failRead:false,conflict:false,plans:[],plansRevision:"initial",posts:[],failCollection:false};
    const health={errors:[],failedRequests:[],httpErrors:[]};
    const expectedStatus=(status,url)=>[409,503].includes(status)&&['/api/import/wardrobe','/api/import/wardrobe/availability','/api/outfits/plans','/api/outfits'].includes(new URL(url).pathname);
    page.on('pageerror',e=>health.errors.push(e.message));
    page.on('console',m=>{if(m.type()==='error'&&!(/409 \(Conflict\)|503 \(Service Unavailable\)/.test(m.text())&&['/api/import/wardrobe','/api/import/wardrobe/availability','/api/outfits/plans','/api/outfits'].includes(new URL(m.location().url||'http://test').pathname)))health.errors.push(m.text());});
    page.on('requestfailed',r=>{if(!r.failure()?.errorText.includes('ERR_ABORTED'))health.failedRequests.push(r.url());});
    page.on('response',r=>{if(r.status()>=400&&!expectedStatus(r.status(),r.url()))health.httpErrors.push(r.url());});
    await page.clock.setFixedTime(new Date('2026-10-22T12:00:00Z'));
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
    await page.goto('/outfits');await expect(page).toHaveTitle('Open Wardrobe');
    await expect(page.getByRole('region',{name:'Your plans'})).toBeVisible();
    await use(state);
    await expect(page.locator('vite-error-overlay')).toHaveCount(0);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await writeFile(info.outputPath('browser-health.json'),JSON.stringify(health,null,2));
    expect(health).toEqual({errors:[],failedRequests:[],httpErrors:[]});
  },
});

const plans=page=>page.getByRole('region',{name:'Your plans'});
const day=(page,tomorrow=false)=>plans(page).getByRole('article',{name:tomorrow?'Tomorrow’s plan':'Today’s plan'});
async function choose(page,id='navy-look',tomorrow=false){
  await day(page,tomorrow).getByRole('button',{name:'Choose look',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:tomorrow?'Plan for tomorrow':'Plan for today',exact:true});
  await dialog.getByRole('combobox',{name:'Saved look'}).selectOption(id);
  await dialog.getByRole('button',{name:'Save plan',exact:true}).click();
  await expect(dialog).not.toBeVisible();
}

test('plan from a saved look, persist, move over another plan, confirm wear and undo independently',async({page,wardrobe},info)=>{
  await page.getByRole('button',{name:'View An easy morning',exact:true}).click();
  await page.getByRole('button',{name:'Plan for tomorrow',exact:true}).click();
  const chooser=page.getByRole('dialog',{name:'Plan for tomorrow',exact:true});
  await expect(chooser.getByRole('combobox',{name:'Saved look'})).toHaveValue('navy-look');
  await chooser.getByRole('button',{name:'Save plan',exact:true}).click();
  await expect(day(page,true).getByRole('heading',{name:'An easy morning'})).toBeVisible();
  expect(wardrobe.outfits.every(o=>!o.wearHistory)).toBe(true);
  await page.reload();
  await expect(day(page,true).getByText('All pieces are ready.',{exact:true})).toBeVisible();
  await choose(page,'olive-look');
  await plans(page).screenshot({path:info.outputPath('daily-plans.png')});
  await page.evaluate(()=>window.scrollTo(0,0));
  await page.screenshot({path:info.outputPath('plans-first-viewport.png')});
  await day(page,true).getByRole('button',{name:'Move to today',exact:true}).click();
  const moving=page.getByRole('dialog',{name:'Plan for today',exact:true});
  await expect(moving.getByText('Saving will replace Olive afternoon in this day’s plan.',{exact:true})).toBeVisible();
  await moving.getByRole('button',{name:'Move plan',exact:true}).click();
  await expect(day(page,true).getByRole('button',{name:'Choose look',exact:true})).toBeVisible();
  expect(wardrobe.plans).toEqual([{date:'2026-10-22',outfitId:'navy-look'}]);
  await day(page).getByRole('button',{name:'Wore this',exact:true}).click();
  const details=page.getByRole('dialog',{name:'An easy morning',exact:true});
  await expect(details.getByRole('button',{name:'Undo',exact:true})).toBeVisible();
  await expect(details.getByText('Send pieces to laundry (optional)',{exact:true})).toBeVisible();
  expect(wardrobe.updates).toHaveLength(0);
  await details.getByRole('button',{name:'Close',exact:true}).click();
  await expect(day(page).getByRole('button',{name:'Wear confirmed',exact:true})).toBeDisabled();
  await day(page).getByRole('button',{name:'View look',exact:true}).click();
  await details.getByRole('button',{name:'Undo',exact:true}).click();
  await details.getByRole('button',{name:'Close',exact:true}).click();
  await expect(day(page).getByRole('button',{name:'Wore this',exact:true})).toBeEnabled();
  await day(page).getByRole('button',{name:'Clear plan',exact:true}).click();
  await expect(day(page).getByRole('button',{name:'Choose look',exact:true})).toBeEnabled();
  expect(wardrobe.plans).toEqual([]);
});

test('availability refresh identifies laundry and missing pieces and recovers from failed reads',async({page,wardrobe},info)=>{
  await choose(page,'navy-look',true);
  wardrobe.items[0].availability='laundry';wardrobe.items[0].revision='new';
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(day(page,true).getByText(/In laundry: Navy blouse/)).toBeVisible();
  await plans(page).screenshot({path:info.outputPath('plan-laundry.png')});
  wardrobe.items=wardrobe.items.filter(i=>i.id!=='navy');
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(day(page,true).getByText(/Unavailable: Piece no longer available/)).toBeVisible();
  wardrobe.failRead=true;
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(day(page,true).getByRole('button',{name:'Change look',exact:true})).toBeDisabled();
  wardrobe.failRead=false;
  await plans(page).getByRole('button',{name:'Refresh plans and wardrobe',exact:true}).click();
  await expect(day(page,true).getByRole('button',{name:'Change look',exact:true})).toBeEnabled();
  await day(page,true).getByRole('button',{name:'Change look',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Plan for tomorrow',exact:true});
  await expect(dialog.getByRole('button',{name:'Save plan',exact:true})).toBeDisabled();
  await dialog.getByRole('combobox',{name:'Saved look'}).selectOption('olive-look');
  await dialog.getByRole('button',{name:'Save plan',exact:true}).click();
  await expect(day(page,true).getByRole('heading',{name:'Olive afternoon'})).toBeVisible();
});

test('failed saves retain the choice and stale device changes are refreshed before retry',async({page,wardrobe})=>{
  await day(page,true).getByRole('button',{name:'Choose look',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Plan for tomorrow',exact:true});
  await dialog.getByRole('combobox',{name:'Saved look'}).selectOption('navy-look');
  wardrobe.failWrite=true;
  await dialog.getByRole('button',{name:'Save plan',exact:true}).click();
  await expect(dialog.getByRole('alert')).toContainText('Could not save your plan');
  await expect(dialog.getByRole('combobox',{name:'Saved look'})).toHaveValue('navy-look');
  wardrobe.failWrite=false;
  wardrobe.plans=[{date:'2026-10-23',outfitId:'olive-look'}];wardrobe.plansRevision='changed';
  await dialog.getByRole('button',{name:'Save plan',exact:true}).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('alert')).toContainText('changed on another device');
  await expect(day(page,true).getByRole('heading',{name:'Olive afternoon'})).toBeVisible();
  await day(page,true).getByRole('button',{name:'Change look',exact:true}).click();
  await dialog.getByRole('combobox',{name:'Saved look'}).selectOption('navy-look');
  await dialog.getByRole('button',{name:'Save plan',exact:true}).click();
  await expect(day(page,true).getByRole('heading',{name:'An easy morning'})).toBeVisible();
  wardrobe.failCollection=true;
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(day(page,true).getByRole('button',{name:'Clear plan',exact:true})).toBeDisabled();
  wardrobe.failCollection=false;
  await plans(page).getByRole('button',{name:'Refresh plans and wardrobe',exact:true}).click();
  await expect(day(page,true).getByRole('button',{name:'Clear plan',exact:true})).toBeEnabled();
});

test('change one piece saves a separate variation and explicitly updates the plan',async({page,wardrobe},info)=>{
  await choose(page,'navy-look',true);
  await day(page,true).getByRole('button',{name:'Change one piece',exact:true}).click();
  const variation=page.getByRole('dialog',{name:'Change one piece',exact:true});
  await variation.getByRole('radio',{name:'Olive shirt',exact:true}).check();
  await variation.getByRole('textbox',{name:'Variation name'}).fill('An olive morning');
  await variation.getByRole('button',{name:'Save variation',exact:true}).click();
  const chooser=page.getByRole('dialog',{name:'Plan for tomorrow',exact:true});
  await expect(chooser.getByRole('combobox',{name:'Saved look'})).toHaveValue('variation-new');
  expect(wardrobe.plans[0].outfitId).toBe('navy-look');
  await expect(chooser.getByText(/In laundry: Olive shirt/)).toBeVisible();
  await chooser.screenshot({path:info.outputPath('plan-variation.png')});
  await chooser.getByRole('button',{name:'Save plan',exact:true}).click();
  await expect(day(page,true).getByRole('heading',{name:'An olive morning'})).toBeVisible();
  expect(wardrobe.outfits.find(o=>o.id==='navy-look').garmentIds).toEqual(['navy','stone']);
});

test('local day rollover preserves unconfirmed plans without inventing wear history',async({page,wardrobe})=>{
  await choose(page);
  await choose(page,'olive-look',true);
  await page.clock.setFixedTime(new Date('2026-10-23T12:00:00Z'));
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(day(page).getByRole('heading',{name:'Olive afternoon'})).toBeVisible();
  await expect(day(page,true).getByRole('button',{name:'Choose look',exact:true})).toBeVisible();
  await plans(page).getByText('Unconfirmed past plans (1)',{exact:true}).click();
  const past=plans(page).getByRole('article').filter({hasText:'Past plan · No wear confirmed.'});
  await expect(past.getByRole('heading',{name:'An easy morning'})).toBeVisible();
  expect(wardrobe.outfits.every(o=>!o.wearHistory)).toBe(true);
  await past.getByRole('button',{name:'Wore this',exact:true}).click();
  await expect(page.getByRole('button',{name:'Undo',exact:true})).toBeVisible();
  expect(wardrobe.outfits[0].wearHistory[0].date).toBe('2026-10-22');
});
