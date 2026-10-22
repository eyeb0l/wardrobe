import { test as base, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import sharp from 'sharp';

const artwork = async color => `data:image/png;base64,${(await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="#eee8de"/><path d="M135 70 L175 55 Q200 82 225 55 L265 70 L320 150 L280 180 L255 150 L260 330 H140 L145 150 L120 180 L80 150Z" fill="${color}"/></svg>`)).png().toBuffer()).toString('base64')}`;
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
    const state={items:structuredClone(initial),outfits:structuredClone(saved),updates:[],failWrite:false,failRead:false,conflict:false};
    const health={errors:[],failedRequests:[],httpErrors:[]};
    const expectedStatus=(status,url)=>[409,503].includes(status)&&['/api/import/wardrobe','/api/import/wardrobe/availability'].includes(new URL(url).pathname);
    page.on('pageerror',e=>health.errors.push(e.message));
    page.on('console',m=>{if(m.type()==='error'&&!(/409 \(Conflict\)|503 \(Service Unavailable\)/.test(m.text())&&['/api/import/wardrobe','/api/import/wardrobe/availability'].includes(new URL(m.location().url||'http://test').pathname)))health.errors.push(m.text());});
    page.on('requestfailed',r=>{if(!r.failure()?.errorText.includes('ERR_ABORTED'))health.failedRequests.push(r.url());});
    page.on('response',r=>{if(r.status()>=400&&!expectedStatus(r.status(),r.url()))health.httpErrors.push(r.url());});
    await page.clock.setFixedTime(new Date('2026-10-22T12:00:00Z'));
    await context.addInitScript(()=>localStorage.setItem('wardrobe:welcome:v1','complete'));
    await context.route('**/api/**',async route=>{
      const p=new URL(route.request().url()).pathname, method=route.request().method();
      if(p==='/api/import/wardrobe')return state.failRead?route.fulfill({status:503,json:{error:'Wardrobe unavailable. Try again.'}}):route.fulfill({json:state.items});
      if(p==='/api/import/jobs')return route.fulfill({json:[]});
      if(p==='/api/import/config'||p==='/api/outfits/config')return route.fulfill({json:{ready:false,hasApiKey:false,modelReferences:[]}});
      if(p==='/api/outfits/discovery/config')return route.fulfill({json:{ready:false,enabled:false}});
      if(p==='/api/outfits/jobs')return route.fulfill({json:{jobs:[]}});
      if(p==='/api/outfits')return route.fulfill({json:{outfits:state.outfits}});
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
    await expect(page.locator('.gallery-item')).toHaveCount(4);
    await use(state);
    await expect(page.locator('vite-error-overlay')).toHaveCount(0);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await writeFile(info.outputPath('browser-health.json'),JSON.stringify(health,null,2));
    expect(health).toEqual({errors:[],failedRequests:[],httpErrors:[]});
  },
});
const nav=(page,name)=>page.getByRole('navigation',{name:'Main navigation'}).getByRole('link',{name,exact:true});
const shortlist=page=>page.getByRole('region',{name:'What to wear'});
const availability=page=>page.locator('.wardrobe-availability').getByRole('combobox',{name:'Availability',exact:true});

test('garment availability saves, survives reload and supports scoped bulk Mark ready',async({page,wardrobe},info)=>{
  await page.getByRole('button',{name:'View Navy blouse',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Selected wardrobe item'});
  await expect(dialog.getByRole('combobox',{name:'Availability',exact:true})).toHaveValue('ready');
  await dialog.getByRole('combobox',{name:'Availability',exact:true}).selectOption('laundry');
  await dialog.getByRole('button',{name:'Save',exact:true}).click();
  await expect(dialog.getByText('Changes saved.',{exact:true})).toBeVisible();
  await dialog.screenshot({path:info.outputPath('garment-availability.png')});
  await dialog.getByRole('button',{name:'Close viewer',exact:true}).click();
  await page.reload();
  await availability(page).selectOption('laundry');
  await expect(page.locator('.gallery-item')).toHaveCount(3);
  await page.getByRole('button',{name:'Tops',exact:true}).click();
  await expect(page.locator('.gallery-item')).toHaveCount(2);
  await page.getByRole('checkbox',{name:'Select all shown',exact:true}).check();
  await expect(page.getByRole('button',{name:'Mark ready (2)',exact:true})).toBeEnabled();
  await page.screenshot({path:info.outputPath('laundry-bulk.png'),fullPage:true});
  await page.getByRole('button',{name:'Mark ready (2)',exact:true}).click();
  await expect(page.getByText('2 pieces are ready to wear.',{exact:true})).toBeVisible();
  expect(wardrobe.items.find(i=>i.id==='rust').availability).toBe('laundry');
  expect(wardrobe.updates[0].items.map(i=>i.id).sort()).toEqual(['navy','olive']);
  await page.getByRole('button',{name:'All',exact:true}).click();
  await expect(page.locator('.gallery-item')).toHaveCount(1);
  await page.reload();await availability(page).selectOption('ready');
  await expect(page.locator('.gallery-item')).toHaveCount(3);
});

test('wear logging leaves availability unchanged until selected pieces are sent to laundry; undo stays separate',async({page,wardrobe},info)=>{
  await nav(page,'Outfits').click();
  await expect(shortlist(page).locator('.outfit-shortlist-name')).toHaveText(['An easy morning']);
  await expect(page.getByRole('button',{name:'View Olive afternoon',exact:true})).toBeVisible();
  await shortlist(page).getByRole('button',{name:'Choose An easy morning'}).click();
  const dialog=page.getByRole('dialog',{name:'An easy morning',exact:true});
  await dialog.getByRole('button',{name:'Wore this today',exact:true}).click();
  await expect(dialog.getByRole('button',{name:'Undo',exact:true})).toBeVisible();
  expect(wardrobe.updates).toHaveLength(0);
  await dialog.getByText('Send pieces to laundry (optional)',{exact:true}).click();
  const pieces=dialog.getByRole('group',{name:'Pieces for laundry'});
  await expect(pieces.getByRole('checkbox',{name:'Navy blouse',exact:true})).not.toBeChecked();
  await expect(dialog.getByRole('button',{name:'Send selected to laundry',exact:true})).toBeDisabled();
  await pieces.getByRole('checkbox',{name:'Navy blouse',exact:true}).check();
  wardrobe.failWrite=true;
  await dialog.getByRole('button',{name:'Send selected to laundry',exact:true}).click();
  await expect(dialog.getByRole('alert')).toContainText('Could not save availability');
  expect(wardrobe.items.find(i=>i.id==='navy').availability).toBeUndefined();
  wardrobe.failWrite=false;
  await dialog.getByRole('button',{name:'Send selected to laundry',exact:true}).click();
  await expect(dialog.getByText('1 piece sent to laundry.',{exact:true})).toBeVisible();
  expect(wardrobe.items.find(i=>i.id==='stone').availability).toBeUndefined();
  await dialog.locator('.outfit-laundry').screenshot({path:info.outputPath('wear-laundry.png')});
  await dialog.getByRole('button',{name:'Undo',exact:true}).click();
  await expect(dialog.getByRole('button',{name:'Wore this today',exact:true})).toBeEnabled();
  expect(wardrobe.items.find(i=>i.id==='navy').availability).toBe('laundry');
  await dialog.getByRole('button',{name:'Close',exact:true}).click();
  await expect(shortlist(page).getByRole('button',{name:/Choose /})).toHaveCount(0);
  await expect(shortlist(page).getByText('3 looks are left out because pieces are in laundry.',{exact:false})).toBeVisible();
  await shortlist(page).screenshot({path:info.outputPath('laundry-shortlist.png')});
  await nav(page,'Wardrobe').click();await availability(page).selectOption('laundry');
  await page.getByRole('checkbox',{name:'Navy blouse',exact:true}).check();
  await page.getByRole('button',{name:'Mark ready (1)',exact:true}).click();
  await expect(page.getByText('1 piece is ready to wear.',{exact:true})).toBeVisible();
  await nav(page,'Outfits').click();
  await expect(shortlist(page).getByRole('button',{name:'Choose An easy morning'})).toBeEnabled();
  await page.reload();
  await expect(shortlist(page).getByRole('button',{name:'Choose An easy morning'})).toBeEnabled();
});

test('bulk conflict and failed refresh preserve selections and recover without partial updates',async({page,wardrobe})=>{
  await availability(page).selectOption('laundry');
  await page.getByRole('checkbox',{name:'Select all shown',exact:true}).check();
  wardrobe.conflict=true;wardrobe.failRead=true;
  await page.getByRole('button',{name:'Mark ready (2)',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('changed on another device');
  await expect(page.getByRole('button',{name:'Mark ready (2)',exact:true})).toBeDisabled();
  expect(wardrobe.items.filter(i=>i.availability==='laundry')).toHaveLength(2);
  wardrobe.conflict=false;wardrobe.failRead=false;
  wardrobe.items.find(i=>i.id==='olive').revision='updated-by-another-device';
  await page.getByRole('button',{name:'Refresh wardrobe availability',exact:true}).click();
  await expect(page.getByRole('button',{name:'Mark ready (2)',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'Mark ready (2)',exact:true}).click();
  await expect(page.getByText('2 pieces are ready to wear.',{exact:true})).toBeVisible();
  expect(wardrobe.updates[1].items.find(i=>i.id==='olive').revision).toBe('updated-by-another-device');
  await expect(page.locator('.gallery-item')).toHaveCount(0);
});

test('discarding garment changes and incoming availability updates preserve wardrobe and saved looks',async({page,wardrobe})=>{
  await page.getByRole('button',{name:'View Navy blouse',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Selected wardrobe item'});
  await dialog.getByRole('combobox',{name:'Availability',exact:true}).selectOption('laundry');
  await dialog.getByRole('button',{name:'Discard changes',exact:true}).click();
  expect(wardrobe.items.find(i=>i.id==='navy').availability).toBeUndefined();
  await nav(page,'Outfits').click();
  await expect(shortlist(page).getByRole('button',{name:'Choose An easy morning'})).toBeEnabled();
  wardrobe.items.find(i=>i.id==='navy').availability='laundry';
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(shortlist(page).getByRole('button',{name:/Choose /})).toHaveCount(0);
  await expect(page.locator('.outfit-card')).toHaveCount(3);
  wardrobe.items.find(i=>i.id==='navy').availability='ready';
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(shortlist(page).getByRole('button',{name:'Choose An easy morning'})).toBeEnabled();
});
