import { test as base, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import sharp from 'sharp';

const image = async (shape, color) => `data:image/png;base64,${(await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="#f4f0e8"/><path d="${shape}" fill="${color}"/><path d="M200 90 V300" stroke="#fff" opacity=".12"/></svg>`)).png().toBuffer()).toString('base64')}`;
const shirt = 'M140 65 L170 55 Q200 85 230 55 L260 65 L315 170 L265 195 L247 145 L252 335 Q200 350 148 335 L153 145 L135 195 L85 170Z';
const pants = 'M140 65 H260 L285 345 H220 L200 165 L180 345 H115Z';
const navy = await image(shirt, '#354556'), knit = await image(shirt, '#c4b59b'), trouser = await image(pants, '#b8ab90');
const collage = `data:image/png;base64,${(await sharp({create:{width:800,height:800,channels:4,background:'#f4f0e8'}}).composite(await Promise.all([knit,trouser].map(async (url,index) => ({input:await sharp(Buffer.from(url.split(',')[1],'base64')).resize(400,600,{fit:'contain',background:'#f4f0e8'}).toBuffer(),left:index*400,top:100})))).png().toBuffer()).toString('base64')}`;
const items = [
  { id:'blouse', name:'Navy blouse', part:'upperbody', color:'#354556',image:navy,tags:[] },
  { id:'trousers', name:'Stone trousers', part:'lowerbody',color:'#b8ab90',image:trouser,tags:[] },
  { id:'knit', name:'Oatmeal knit', part:'upperbody',color:'#c4b59b',image:knit,tags:[] },
];
const original = { id:'dinner', name:'Dinner by the river', occasion:['dinner','smart-casual'], garmentIds:['blouse','trousers'], image:navy, status:'accepted',reason:'Soft contrasts for a relaxed evening.' };
const test = base.extend({
  wardrobe: async ({page,context},use,info) => {
    const health = { errors:[], failedRequests:[], httpErrors:[] };
    const state = {outfits:[structuredClone(original)],jobs:[],posts:[], failSave:false, connected:true};
    page.on('pageerror',e=>health.errors.push(e.message));
    page.on('console',m=>{if(m.type()==='error'&&!m.text().includes('503 (Service Unavailable)'))health.errors.push(m.text());});
    page.on('requestfailed',r=>{if(!r.failure()?.errorText.includes('ERR_ABORTED'))health.failedRequests.push(r.url());});
    page.on('response',r=>{if(r.status()>=400&&r.status()!==503)health.httpErrors.push(r.url());});
    await context.addInitScript(()=>localStorage.setItem('wardrobe:welcome:v1','complete'));
    await context.route('**/api/**',async route=>{
      const p=new URL(route.request().url()).pathname, post=route.request().method()==='POST';
      const body=post?route.request().postDataJSON():null;
      if(post) state.posts.push({path:p,body});
      if(p==='/api/import/wardrobe')return route.fulfill({json:items});
      if(p==='/api/import/jobs')return route.fulfill({json:[]});
      if(p==='/api/import/config')return route.fulfill({json:{ready:false,modelReferences:[]}});
      if(p==='/api/outfits')return route.fulfill({json:{outfits:state.outfits}});
      if(p==='/api/outfits/discovery/config')return route.fulfill({json:{ready:false}});
      if(p==='/api/outfits/config')return route.fulfill({json:{ready:false,availableCombinations:0,hasApiKey:state.connected,hasModelReference:true,modelReferences:[{id:'default',label:'My reference',imageUrl:navy}]}});
      if(p==='/api/outfits/jobs')return route.fulfill({json:{jobs:state.jobs}});
      if(p.endsWith('/accessories'))return route.fulfill({json:{hasApiKey:false}});
      if(p.endsWith('/variations')&&post){
        if(state.failSave){state.failSave=false;return route.fulfill({status:503,json:{error:'Could not save. Try again.'}});}
        const source=state.outfits.find(o=>p===`/api/outfits/${o.id}/variations`);
        const saved={...source,id:`variation-${body.requestId}`,name:body.name,image:collage,imageKind:'cutouts',variationOf:source.id,garmentIds:source.garmentIds.map(id=>id===body.replacedGarmentId?body.replacementGarmentId:id),reason:`A variation of ${source.name}, replacing Navy blouse with Oatmeal knit.`};
        if(!state.outfits.some(o=>o.id===saved.id))state.outfits.push(saved);
        return route.fulfill({json:saved});
      }
      if(p.endsWith('/photo')&&post){
        const target=state.outfits.find(o=>p===`/api/outfits/${o.id}/photo`);
        const stamp=new Date().toISOString();
        const job={id:body.requestId,targetOutfitId:target.id,count:1,direction:body.direction,status:'review',createdAt:stamp,updatedAt:stamp,outfits:[{...target,id:`photo-${body.requestId}`,imageKind:'modelled',image:collage,status:'review'}]};
        state.jobs.push(job);return route.fulfill({status:202,json:job});
      }
      const action=p.match(/^\/api\/outfits\/jobs\/([^/]+)\/outfits\/([^/]+)\/(approve|reject|retry)$/);
      if(action&&post){
        const job=state.jobs.find(j=>j.id===action[1]),outfit=job.outfits[0];
        outfit.status=action[3]==='approve'?'accepted':action[3]==='reject'?'rejected':'review';
        job.status=outfit.status==='review'?'review':'complete';job.updatedAt=new Date(Date.now()+100).toISOString();
        if(action[3]==='approve')Object.assign(state.outfits.find(o=>o.id===job.targetOutfitId),{imageKind:'modelled',image:collage});
        return route.fulfill({status:action[3]==='retry'?202:200,json:job});
      }
      health.errors.push(`Unexpected API ${p}`);return route.fulfill({status:500,json:{}});
    });
    await page.goto('/outfits');
    await expect(page.getByRole('button',{name:'View Dinner by the river',exact:true})).toBeVisible();
    await use(state);
    await expect(page.locator('vite-error-overlay')).toHaveCount(0);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    expect(await page.locator('dialog[open]').evaluateAll(nodes=>nodes.every(n=>n.scrollWidth<=n.clientWidth+1))).toBe(true);
    await writeFile(info.outputPath('browser-health.json'),JSON.stringify(health,null,2));
    expect(health).toEqual({errors:[],failedRequests:[],httpErrors:[]});
  }
});
async function editor(page){
  await page.getByRole('button',{name:'View Dinner by the river',exact:true}).click();
  await page.getByRole('button',{name:'Change one piece',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'Change one piece',exact:true})).toBeVisible();
}
async function save(page){
  await editor(page);
  await page.getByRole('radio',{name:'Oatmeal knit',exact:true}).check();
  await page.getByRole('textbox',{name:'Variation name'}).fill('An oatmeal evening');
  await page.getByRole('button',{name:'Save variation',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'An oatmeal evening',exact:true})).toBeVisible();
}

test('replace, preview, save and reload a separate look without AI; photo remains optional',async({page,wardrobe},info)=>{
  wardrobe.connected=false;
  await editor(page);
  await expect(page.getByRole('button',{name:'Save variation',exact:true})).toBeDisabled();
  await page.getByRole('combobox',{name:'Piece to replace'}).selectOption('trousers');
  await expect(page.getByText('No other available pieces in this category.',{exact:false})).toBeVisible();
  await page.getByRole('combobox',{name:'Piece to replace'}).selectOption('blouse');
  await page.getByRole('radio',{name:'Oatmeal knit',exact:true}).check();
  const preview=page.getByRole('region',{name:'Variation cutout preview'});
  await expect(preview.getByRole('img',{name:'Oatmeal knit'})).toBeVisible();
  await expect(preview.getByRole('img',{name:'Navy blouse'})).toHaveCount(0);
  await page.getByRole('textbox',{name:'Variation name'}).fill('An oatmeal evening');
  await page.getByRole('dialog').evaluate(n=>n.scrollTop=0);
  await page.screenshot({path:info.outputPath('variation-preview.png'),fullPage:false});
  await page.getByRole('button',{name:'Save variation',exact:true}).scrollIntoViewIfNeeded();
  await page.screenshot({path:info.outputPath('variation-controls.png'),fullPage:false});
  await page.getByRole('button',{name:'Save variation',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'An oatmeal evening',exact:true})).toBeVisible();
  await expect(page.getByText('Cutout preview',{exact:true})).toBeVisible();
  expect(wardrobe.posts).toHaveLength(1);
  expect(wardrobe.outfits[0]).toEqual(original);
  await page.getByRole('dialog').evaluate(n=>n.scrollTop=0);
  await page.screenshot({path:info.outputPath('variation-saved.png'),fullPage:false});
  await page.getByRole('button',{name:'Create modelled photo',exact:true}).click();
  await expect(page.getByRole('button',{name:'Generate modelled photo'})).toBeDisabled();
  await page.reload();
  await expect(page.locator('.outfit-card')).toHaveCount(2);
  await page.getByRole('button',{name:'View An oatmeal evening',exact:true}).click();
  await expect(page.getByText('Cutout preview',{exact:true})).toBeVisible();
  expect(wardrobe.posts).toHaveLength(1);
});

test('optional photo works with no unused combinations and requires review before replacing the cutouts',async({page,wardrobe},info)=>{
  await save(page);
  await page.getByRole('button',{name:'Create modelled photo',exact:true}).click();
  await expect(page.getByRole('button',{name:'Generate modelled photo',exact:true})).toBeEnabled();
  expect(wardrobe.posts).toHaveLength(1);
  await page.getByRole('button',{name:'Generate modelled photo',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'Modelled photo',exact:true})).toBeVisible();
  expect(wardrobe.outfits[1].imageKind).toBe('cutouts');
  await page.getByRole('button',{name:'Reject',exact:true}).click();
  await expect(page.getByText('Photo rejected. Your cutout variation is still saved.')).toBeVisible();
  expect(wardrobe.outfits[1].imageKind).toBe('cutouts');
  await page.getByRole('button',{name:'Regenerate photo',exact:true}).click();
  await page.getByRole('button',{name:'Use this photo',exact:true}).scrollIntoViewIfNeeded();
  await page.screenshot({path:info.outputPath('variation-photo-review.png'),fullPage:false});
  await page.getByRole('button',{name:'Use this photo',exact:true}).click();
  await expect(page.getByText('Photo added to your variation.',{exact:true})).toBeVisible();
  expect(wardrobe.outfits).toHaveLength(2);
  expect(wardrobe.outfits[0]).toEqual(original);
  expect(wardrobe.outfits[1].imageKind).toBe('modelled');
  await page.reload();
  await page.getByRole('button',{name:'View An oatmeal evening',exact:true}).click();
  await expect(page.getByText('Cutout preview',{exact:true})).toHaveCount(0);
});

test('cancel leaves the collection untouched and a failed save retains the preview and request identity',async({page,wardrobe})=>{
  await editor(page);
  await page.getByRole('radio',{name:'Oatmeal knit',exact:true}).check();
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  expect(wardrobe.outfits).toHaveLength(1);expect(wardrobe.posts).toHaveLength(0);
  await page.getByRole('button',{name:'Change one piece',exact:true}).click();
  await page.getByRole('radio',{name:'Oatmeal knit',exact:true}).check();
  wardrobe.failSave=true;
  await page.getByRole('button',{name:'Save variation',exact:true}).click();
  await expect(page.getByRole('alert')).toHaveText('Could not save. Try again.');
  await expect(page.getByRole('radio',{name:'Oatmeal knit',exact:true})).toBeChecked();
  expect(wardrobe.outfits).toHaveLength(1);
  await page.getByRole('button',{name:'Save variation',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'Dinner by the river · variation',exact:true})).toBeVisible();
  expect(wardrobe.posts[0].body.requestId).toBe(wardrobe.posts[1].body.requestId);
  expect(wardrobe.outfits).toHaveLength(2);
});
