import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import sharp from 'sharp';

const svg = (w, h, fill) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="#c9c4bb"/><rect x="${w * .35}" y="${h * .2}" width="${w * .3}" height="${h * .6}" fill="${fill}"/></svg>`);
const toUrl = async (w, h, fill) => `data:image/png;base64,${(await sharp(svg(w, h, fill)).png().toBuffer()).toString('base64')}`;
const square = await toUrl(1024, 1024, '#2f5d8a');
const replaced = await toUrl(1024, 1024, '#7a3b2e');
const wide = await toUrl(1536, 1024, '#2f5d8a');
const wideAsset = '/api/import/assets/00000000-0000-4000-8000-000000000001/modeled-1.png';
const pngBytes = url => Buffer.from(url.split(',')[1], 'base64');

function healthOf(page) {
  const health = { errors: [], failedRequests: [], httpErrors: [] };
  page.on('pageerror', e => health.errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') health.errors.push(m.text()); });
  page.on('requestfailed', r => { if (!r.failure()?.errorText.includes('ERR_ABORTED')) health.failedRequests.push(r.url()); });
  page.on('response', r => { if (r.status() >= 400) health.httpErrors.push(r.url()); });
  return health;
}

const marker = page => page.getByRole('dialog', { name: 'Mark what to change', exact: true });
async function draw(page) {
  const surface = marker(page).locator('canvas');
  await expect(surface).toBeVisible();
  const box = await surface.boundingBox();
  const at = (x, y) => [box.x + box.width * x, box.y + box.height * y];
  const path = [[.5, .3], [.6, .4], [.6, .6], [.5, .7], [.4, .6], [.4, .4]];
  if (test.info().project.name === 'mobile') {
    // A real touch sequence, so a browser scroll gesture would cancel the stroke.
    const touch = await page.context().newCDPSession(page);
    const send = (type, points) => touch.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y]) => ({ x, y })) });
    await send('touchStart', [at(.4, .4)]);
    for (const [x, y] of path) await send('touchMove', [at(x, y)]);
    await send('touchEnd', []);
    await touch.detach();
    return;
  }
  await page.mouse.move(...at(.4, .4));
  await page.mouse.down();
  for (const [x, y] of path) await page.mouse.move(...at(x, y), { steps: 3 });
  await page.mouse.up();
}
async function surfaceFits(page) {
  const surface = await marker(page).locator('canvas').boundingBox();
  const viewport = page.viewportSize();
  const done = await marker(page).getByRole('button', { name: 'Done', exact: true }).boundingBox();
  expect(surface.x).toBeGreaterThanOrEqual(0);
  expect(surface.x + surface.width).toBeLessThanOrEqual(viewport.width);
  expect(surface.y + surface.height).toBeLessThanOrEqual(done.y);
  expect(done.y + done.height).toBeLessThanOrEqual(viewport.height);
  return surface;
}

async function marksMatch(dataUrl, width, height) {
  expect(dataUrl).toMatch(/^data:image\/png;base64,/);
  const bytes = Buffer.from(dataUrl.split(',')[1], 'base64');
  const metadata = await sharp(bytes).metadata();
  expect([metadata.width, metadata.height, metadata.hasAlpha]).toEqual([width, height, true]);
  const { data } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
  let visible = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] > 128) visible++;
  expect(visible).toBeGreaterThan(50);
  expect(data[3]).toBe(0);
}

test('mark an outfit photo, require a description and send the marks with the retry', async ({ page }, info) => {
  const health = healthOf(page);
  const garments = ['Blue shirt', 'Grey trousers'].map((name, i) => ({ id: `g${i}`, name, part: i ? 'lowerbody' : 'upperbody', image: square, modeledImage: square, color: '#2f5d8a', tags: [] }));
  const outfit = { id: 'look-one', name: 'Linen lunch', occasion: ['casual'], garmentIds: ['g0', 'g1'], status: 'review', source: 'generated', attempts: 1, image: square, reason: 'Clean and calm.', setting: 'A quiet courtyard.' };
  const job = { id: '00000000-0000-4000-8000-0000000000aa', count: 1, status: 'review', outfits: [outfit], createdAt: '2026-11-05T09:00:00.000Z', updatedAt: '2026-11-05T09:00:00.000Z' };
  const retries = [];
  await page.addInitScript(() => localStorage.setItem('wardrobe:welcome:v1', 'complete'));
  await page.route('**/api/**', async route => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (p === '/api/import/wardrobe') return route.fulfill({ json: garments });
    if (p === '/api/import/config') return route.fulfill({ json: { ready: true, hasApiKey: true, hasModelReference: true, modelReferences: [{ id: 'default', label: 'Default', imageUrl: square }] } });
    if (p === '/api/import/jobs') return route.fulfill({ json: [] });
    if (p === '/api/outfits/config') return route.fulfill({ json: { ready: true, hasApiKey: true, hasModelReference: true, modelReferences: [{ id: 'default', label: 'Default', imageUrl: square }], maxCount: 6 } });
    if (p === '/api/outfits/jobs') return route.fulfill({ json: { jobs: [job] } });
    if (p === `/api/outfits/jobs/${job.id}`) return route.fulfill({ json: job });
    if (p === `/api/outfits/jobs/${job.id}/outfits/look-one/retry`) {
      retries.push(req.postDataJSON());
      Object.assign(outfit, { image: replaced, attempts: 2 });
      return route.fulfill({ status: 202, json: job });
    }
    if (p === '/api/outfits') return route.fulfill({ json: { outfits: [] } });
    if (req.method() === 'GET') return route.fulfill({ json: {} });
    health.errors.push(`Unexpected API ${req.method()} ${p}`);
    return route.fulfill({ status: 500, json: {} });
  });
  await page.goto('/outfits');
  const open = page.getByRole('button', { name: /Review outfits/ });
  await expect(open).toBeVisible();
  await open.click();
  const dialog = page.getByRole('dialog', { name: '1 outfit idea', exact: true });
  await expect(dialog.getByRole('heading', { name: 'Linen lunch' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Mark what to change', exact: true })).toHaveCount(1);

  await expect(dialog.getByRole('button', { name: 'Regenerate photo', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Mark what to change', exact: true }).click();
  await expect(marker(page).getByRole('img', { name: /0 marks so far/ })).toBeVisible();
  await expect(marker(page).getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await surfaceFits(page);

  await draw(page);
  await expect(marker(page).getByRole('img', { name: /1 mark so far/ })).toBeVisible();
  await page.screenshot({ path: info.outputPath('outfit-marking.png') });
  await marker(page).getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(marker(page).getByRole('img', { name: /0 marks so far/ })).toBeVisible();
  await draw(page);
  await draw(page);
  await expect(marker(page).getByRole('img', { name: /2 marks so far/ })).toBeVisible();
  await marker(page).getByRole('button', { name: 'Clear marks', exact: true }).click();
  await expect(marker(page).getByRole('img', { name: /0 marks so far/ })).toBeVisible();
  await draw(page);

  // Escape leaves only the marking layer, keeps the marks and keeps the review open.
  await page.keyboard.press('Escape');
  await expect(marker(page)).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Edit marks (1)', exact: true })).toBeVisible();
  await expect(dialog.getByRole('img', { name: 'Your marks on this photo' })).toBeVisible();

  const apply = dialog.getByRole('button', { name: 'Apply marked edit', exact: true });
  await expect(apply).toBeDisabled();
  await dialog.getByRole('button', { name: 'Edit marks (1)', exact: true }).click();
  await expect(marker(page).getByRole('img', { name: /1 mark so far/ })).toBeVisible();
  await marker(page).getByRole('button', { name: 'Done', exact: true }).click();
  await dialog.getByRole('textbox', { name: 'What should change in the marked area?' }).fill('Remove the invented zip.');
  await expect(apply).toBeEnabled();
  await apply.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('outfit-ready.png') });
  await apply.click();

  await expect.poll(() => retries.length).toBe(1);
  expect(retries[0].prompt).toBe('Remove the invented zip.');
  expect(retries[0].baseImage).toBe(square);
  await marksMatch(retries[0].markup, 1024, 1024);
  // The replacement photo starts clean: old marks no longer apply to it.
  await expect(dialog.getByRole('button', { name: 'Regenerate photo', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Mark what to change', exact: true })).toBeVisible();
  await expect(dialog.getByRole('img', { name: 'Your marks on this photo' })).toHaveCount(0);

  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await writeFile(info.outputPath('browser-health.json'), JSON.stringify(health, null, 2));
  expect(health).toEqual({ errors: [], failedRequests: [], httpErrors: [] });
});

test('mark a modelled photo during import and send the marks with the regeneration', async ({ page }, info) => {
  const health = healthOf(page);
  const stage = (status, extra = {}) => ({ status, decision: null, attempts: 1, assetUrl: null, error: null, prompt: null, ...extra });
  const job = { id: '00000000-0000-4000-8000-000000000001', status: 'active', canUseOriginal: false, metadata: { name: 'Blue shirt', part: 'upperbody', color: '#2f5d8a', tags: [] }, originalAssetUrl: wide, modelReferenceId: 'default',
    createdAt: '2026-11-05T09:00:00.000Z', updatedAt: '2026-11-05T09:00:00.000Z',
    stages: { crop: stage('approved', { assetUrl: wide }), garment: stage('approved', { assetUrl: wide, source: 'generated' }), modeled: stage('review', { assetUrl: wideAsset, source: 'generated', setting: 'A quiet courtyard.' }) } };
  const regenerations = [];
  await page.addInitScript(() => localStorage.setItem('wardrobe:welcome:v1', 'complete'));
  await page.route('**/api/**', async route => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    if (p === wideAsset) return route.fulfill({ contentType: 'image/png', body: pngBytes(wide) });
    if (p === '/api/import/wardrobe') return route.fulfill({ json: [] });
    if (p === '/api/import/config') return route.fulfill({ json: { ready: true, hasApiKey: true, hasModelReference: true, modelReferences: [{ id: 'default', label: 'Default', imageUrl: square }] } });
    if (p === '/api/import/jobs') return route.fulfill({ json: url.searchParams.has('ids') ? { jobs: [job], missing: [] } : [job] });
    if (p === `/api/import/jobs/${job.id}/stages/modeled/regenerate`) {
      regenerations.push(req.postDataJSON());
      job.stages.modeled = stage('queued', { assetUrl: wideAsset, source: 'generated' });
      return route.fulfill({ status: 202, json: job });
    }
    if (p === '/api/outfits') return route.fulfill({ json: { outfits: [] } });
    if (req.method() === 'GET') return route.fulfill({ json: {} });
    health.errors.push(`Unexpected API ${req.method()} ${p}`);
    return route.fulfill({ status: 500, json: {} });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Open import progress', exact: true }).click();
  const mark = page.getByRole('button', { name: 'Mark what to change', exact: true });
  const card = page.locator('.import-card-list').getByText('Blue shirt', { exact: true });
  await expect(mark.or(card).first()).toBeVisible();
  if (!await mark.isVisible()) await card.click();
  await expect(mark).toBeVisible();
  await expect(mark).toHaveCount(1);
  await mark.click();
  await surfaceFits(page);
  await draw(page);
  await page.screenshot({ path: info.outputPath('import-marking.png') });
  await page.keyboard.press('Escape');
  await expect(marker(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Edit marks (1)', exact: true })).toBeVisible();
  const apply = page.getByRole('button', { name: 'Apply marked edit', exact: true });
  await expect(apply).toBeDisabled();
  await page.getByRole('textbox', { name: 'What should change in the marked area?' }).fill('Remove the invented zip.');
  await expect(apply).toBeEnabled();
  await page.screenshot({ path: info.outputPath('import-marked.png') });
  await apply.click();
  await expect.poll(() => regenerations.length).toBe(1);
  expect(regenerations[0]).toMatchObject({ prompt: 'Remove the invented zip.', modelReferenceId: 'default', baseImage: wideAsset });
  await marksMatch(regenerations[0].markup, 1536, 1024);

  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await writeFile(info.outputPath('browser-health.json'), JSON.stringify(health, null, 2));
  expect(health).toEqual({ errors: [], failedRequests: [], httpErrors: [] });
});
