import { test as base, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';

const picture = async (top, bottom) => `data:image/png;base64,${(await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="500" height="500"><rect width="500" height="500" fill="#eee8de"/><path d="M185 55 L220 40 Q250 75 280 40 L315 55 L360 180 L310 195 L290 130 L295 250 H205 L210 130 L190 195 L140 180Z" fill="${top}"/><path d="M205 275 H295 L320 460 H265 L250 350 L235 460 H180Z" fill="${bottom}"/></svg>`)).png().toBuffer()).toString('base64')}`;
const pictures = await Promise.all([['#36495c','#baa98a'],['#a39a85','#424b59'],['#737c60','#c6bca7'],['#ad6f57','#453f39'],['#b7ab95','#6e7780'],['#a3aaa0','#747066']].map(([top,bottom])=>picture(top,bottom)));
const items = pictures.flatMap((image,i)=>[
  { id:`top-${i}`,name:['Navy blouse','Oatmeal knit','Olive shirt','Rust knit','Cream tee','Sage shirt'][i],part:'upperbody',image,tags:[] },
  { id:`bottom-${i}`,name:['Stone trousers','Charcoal trousers','Ecru jeans','Black skirt','Blue jeans','Linen trousers'][i],part:'lowerbody',image,tags:[] },
]);
const event = (date,garmentIds)=>({id:randomUUID(),date,garmentIds,createdAt:`${date}T12:00:00Z`});
const look = (i,name,extra={})=>({id:`look-${i}`,name,occasion:['casual'],garmentIds:[`top-${i}`,`bottom-${i}`],image:pictures[i],status:'accepted',reason:'Familiar pieces with easy proportions.',...extra});
const initial=[
  look(0,'An autumn favourite',{favourite:true,wearHistory:[event('2026-09-01',['top-0','bottom-0'])]}),
  look(0,'An autumn variation',{id:'variation',favourite:true,imageKind:'cutouts',variationOf:'look-0'}),
  look(1,'Back to the office',{occasion:['work'],favourite:true,wearHistory:[event('2026-10-21',['top-0'])]}),
  look(2,'A walk in the park',{wearHistory:[event('2026-09-15',['top-2','bottom-2'])]}),
  look(3,'Dinner in rust',{favourite:true,imageKind:'cutouts',variationOf:'another-look',occasion:['casual','dinner'],wearHistory:[event('2026-10-01',['top-3','bottom-3'])]}),
  look(4,'A fresh start',{occasion:['casual','travel']}),
  look(5,'Linen afternoon',{wearHistory:[event('2026-10-05',['top-5'])]}),
  look(2,'An unavailable look',{id:'missing',garmentIds:['missing','bottom-2'],wearHistory:[event('2026-09-15',['top-2'])]}),
];
const test=base.extend({
  wardrobe:async({page,context},use,info)=>{
    const health={errors:[],failedRequests:[],httpErrors:[]};
    const state={outfits:structuredClone(initial),posts:[],failRead:false,failWardrobe:false};
    await page.clock.setFixedTime(new Date('2026-10-22T12:00:00Z'));
    page.on('pageerror',e=>health.errors.push(e.message));
    page.on('console',m=>{if(m.type()==='error'&&!m.text().includes('503 (Service Unavailable)'))health.errors.push(m.text());});
    page.on('requestfailed',r=>{if(!r.failure()?.errorText.includes('ERR_ABORTED'))health.failedRequests.push(r.url());});
    page.on('response',r=>{if(r.status()>=400&&r.status()!==503)health.httpErrors.push(r.url());});
    await context.addInitScript(()=>localStorage.setItem('wardrobe:welcome:v1','complete'));
    await context.route('**/api/**',async route=>{
      const p=new URL(route.request().url()).pathname;
      if(p==='/api/import/wardrobe')return state.failWardrobe?route.fulfill({status:503,json:{error:'Wardrobe unavailable. Try again.'}}):route.fulfill({json:items});
      if(p==='/api/import/jobs')return route.fulfill({json:[]});
      if(p==='/api/import/config'||p==='/api/outfits/config')return route.fulfill({json:{ready:false,hasApiKey:false,modelReferences:[]}});
      if(p==='/api/outfits/discovery/config')return route.fulfill({json:{ready:false,enabled:false}});
      if(p==='/api/outfits/jobs')return route.fulfill({json:{jobs:[]}});
      if(p==='/api/outfits')return state.failRead?route.fulfill({status:503,json:{error:'Collection unavailable. Try again.'}}):route.fulfill({json:{outfits:state.outfits}});
      if(p.endsWith('/accessories'))return route.fulfill({json:{hasApiKey:false}});
      const match=p.match(/^\/api\/outfits\/([^/]+)\/(favourite|wears|wears\/([^/]+)\/remove)$/);
      if(match&&route.request().method()==='POST'){
        const body=route.request().postDataJSON();state.posts.push({path:p,body});
        const outfit=state.outfits.find(o=>o.id===match[1]);
        if(match[2]==='favourite')outfit.favourite=body.favourite;
        else if(match[2]==='wears'){
          outfit.wearHistory ||= [];
          if(!outfit.wearHistory.some(e=>e.date===body.date))outfit.wearHistory.push(event(body.date,body.garmentIds||outfit.garmentIds));
        }else outfit.wearHistory=outfit.wearHistory.filter(e=>e.id!==match[3]);
        return route.fulfill({json:outfit});
      }
      health.errors.push(`Unexpected API ${p}`);return route.fulfill({status:500,json:{}});
    });
    await page.goto('/outfits');
    await expect(page).toHaveTitle('Open Wardrobe');
    await expect(page.getByRole('region',{name:'What to wear'})).toBeVisible();
    await use(state);
    await expect(page.locator('vite-error-overlay')).toHaveCount(0);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await writeFile(info.outputPath('browser-health.json'),JSON.stringify(health,null,2));
    expect(health).toEqual({errors:[],failedRequests:[],httpErrors:[]});
  },
});
test.use({ locale: 'en-GB' });
const panel=page=>page.getByRole('region',{name:'What to wear'});
const names=page=>panel(page).locator('.outfit-shortlist-name');

test('occasion and mode give three distinct saved choices with accurate cross-outfit piece history',async({page,wardrobe},info)=>{
  await panel(page).getByRole('combobox',{name:'Shortlist occasion'}).selectOption('casual');
  await expect(names(page)).toHaveText(['A walk in the park','Dinner in rust','Linen afternoon']);
  await expect(panel(page).getByText('1 of 2 pieces has no wears logged.')).toBeVisible();
  await expect(panel(page).getByText('Cutout preview · casual · dinner')).toBeVisible();
  await panel(page).locator('summary').first().click();
  await expect(panel(page).getByText('1 day logged · Last worn 15 Sept 2026')).toHaveCount(2);
  await panel(page).locator('summary').first().click();
  await panel(page).scrollIntoViewIfNeeded();
  await panel(page).screenshot({path:info.outputPath('shortlist-recent.png')});
  await panel(page).getByRole('radio',{name:'Favourites',exact:true}).check();
  await expect(names(page)).toHaveText(['Dinner in rust','An autumn favourite']);
  const autumn=panel(page).getByRole('article').filter({hasText:'An autumn favourite'});
  await expect(autumn.getByText('Most recent piece wear: 21 Oct 2026.')).toBeVisible();
  await autumn.locator('summary').click();
  await expect(autumn.getByText('2 days logged · Last worn 21 Oct 2026')).toBeVisible();
  await expect(autumn.getByText('1 day logged · Last worn 1 Sept 2026')).toBeVisible();
  await panel(page).screenshot({path:info.outputPath('shortlist-favourites.png')});
  await panel(page).getByRole('combobox',{name:'Shortlist occasion'}).selectOption('work');
  await expect(names(page)).toHaveText(['Back to the office']);
  await expect(panel(page).getByText('No wears logged for these pieces.')).toBeVisible();
  expect(wardrobe.posts).toHaveLength(0);
});

test('choosing, logging, undoing and favouriting refresh the shortlist and survive reload',async({page,wardrobe})=>{
  await panel(page).getByRole('combobox',{name:'Shortlist occasion'}).selectOption('casual');
  await panel(page).getByRole('button',{name:'Choose A walk in the park'}).click();
  const dialog=page.getByRole('dialog',{name:'A walk in the park',exact:true});
  await dialog.getByRole('button',{name:'Wore this today',exact:true}).click();
  await expect(dialog.getByRole('button',{name:'Undo',exact:true})).toBeVisible();
  await dialog.getByRole('button',{name:'Undo',exact:true}).click();
  await dialog.getByRole('button',{name:'Close',exact:true}).click();
  await expect(names(page)).toHaveText(['A walk in the park','Dinner in rust','Linen afternoon']);
  await panel(page).getByRole('button',{name:'Choose A walk in the park'}).click();
  await dialog.getByRole('button',{name:'Wore this today',exact:true}).click();
  await expect(dialog.getByRole('button',{name:'Undo',exact:true})).toBeVisible();
  await dialog.getByRole('button',{name:'Close',exact:true}).click();
  await expect(names(page)).toHaveText(['Dinner in rust','Linen afternoon','An autumn favourite']);
  await page.reload();
  await panel(page).getByRole('combobox',{name:'Shortlist occasion'}).selectOption('casual');
  await expect(names(page)).toHaveText(['Dinner in rust','Linen afternoon','An autumn favourite']);
  await panel(page).getByRole('radio',{name:'Favourites',exact:true}).check();
  await panel(page).getByRole('button',{name:'Choose Dinner in rust'}).click();
  const dinner=page.getByRole('dialog',{name:'Dinner in rust',exact:true});
  await dinner.getByRole('button',{name:'Remove Dinner in rust from favourites'}).click();
  await expect(dinner.getByRole('button',{name:'Add Dinner in rust to favourites'})).toBeVisible();
  await dinner.getByRole('button',{name:'Change one piece',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'Change one piece',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await dinner.getByRole('button',{name:'Close',exact:true}).click();
  await expect(names(page)).toHaveText(['An autumn favourite']);
  expect(wardrobe.posts).toHaveLength(4);
});

test('empty favourites, unknown history and failed collection refresh have honest recoverable states',async({page,wardrobe},info)=>{
  await panel(page).getByRole('combobox',{name:'Shortlist occasion'}).selectOption('travel');
  await expect(names(page)).toHaveText(['A fresh start']);
  await expect(panel(page).getByText('No wears logged for these pieces.')).toBeVisible();
  await panel(page).getByRole('radio',{name:'Favourites',exact:true}).check();
  await expect(panel(page).getByRole('button',{name:/Choose /})).toHaveCount(0);
  await expect(panel(page).getByText('No available favourites for this occasion.',{exact:false})).toBeVisible();
  await panel(page).screenshot({path:info.outputPath('shortlist-empty.png')});
  wardrobe.failRead=true;
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(panel(page).getByText('The shortlist is unavailable until your collection can be refreshed.')).toBeVisible();
  await panel(page).getByRole('radio',{name:'Not worn lately'}).check();
  await expect(panel(page).getByRole('button',{name:/Choose /})).toHaveCount(0);
  wardrobe.failRead=false;
  await page.getByRole('button',{name:'Reload collection',exact:true}).click();
  await expect(names(page)).toHaveText(['A fresh start']);
  wardrobe.failWardrobe=true;
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(panel(page).getByText('Your wardrobe could not be refreshed. Refresh it before choosing a look.')).toBeVisible();
  await expect(panel(page).getByRole('button',{name:/Choose /})).toHaveCount(0);
  wardrobe.failWardrobe=false;
  await panel(page).getByRole('button',{name:'Refresh wardrobe',exact:true}).click();
  await expect(names(page)).toHaveText(['A fresh start']);
  expect(wardrobe.posts).toHaveLength(0);
});
