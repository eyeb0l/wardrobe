import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import sharp from 'sharp';

const BLUE = [47, 93, 138];
const RUST = [122, 59, 46];
const svg = (w, h, fill, background) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${background ? `<rect width="${w}" height="${h}" fill="${background}"/>` : ''}<rect x="${w * .1}" y="${h * .1}" width="${w * .8}" height="${h * .8}" fill="${fill}"/></svg>`);
const png = (w, h, [r, g, b], background = '#c9c4bb') => sharp(svg(w, h, `rgb(${r},${g},${b})`, background)).png().toBuffer();
const asDataUrl = bytes => `data:image/png;base64,${bytes.toString('base64')}`;

function healthOf(page) {
  const health = { errors: [], failedRequests: [], httpErrors: [] };
  page.on('pageerror', e => health.errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') health.errors.push(m.text()); });
  page.on('requestfailed', r => { if (!r.failure()?.errorText.includes('ERR_ABORTED')) health.failedRequests.push(r.url()); });
  page.on('response', r => { if (r.status() >= 400) health.httpErrors.push(r.url()); });
  return health;
}

async function finish(page, info, health) {
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await writeFile(info.outputPath('browser-health.json'), JSON.stringify(health, null, 2));
  expect(health).toEqual({ errors: [], failedRequests: [], httpErrors: [] });
}

// Reads what is really painted, so a slider that moves without revealing the
// other image fails.
async function colourAt(frame, x, y = .5) {
  const shot = await frame.screenshot({ animations: 'disabled' });
  const { width, height } = await sharp(shot).metadata();
  const { data } = await sharp(shot).extract({ left: Math.round(width * x), top: Math.round(height * y), width: 1, height: 1 }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return [...data];
}
function expectColour(actual, expected) {
  actual.forEach((value, index) => expect(Math.abs(value - expected[index]), `${actual} is near ${expected}`).toBeLessThan(14));
}

async function drag(page, frame, toX) {
  const box = await frame.boundingBox();
  const y = box.y + box.height * .7;
  const [fromPx, toPx] = [box.x + box.width * .5, box.x + box.width * toX];
  if (test.info().project.name === 'mobile') {
    // A real touch drag, so a browser scroll gesture would cancel it.
    const touch = await page.context().newCDPSession(page);
    const send = (type, points) => touch.send('Input.dispatchTouchEvent', { type, touchPoints: points });
    await send('touchStart', [{ x: fromPx, y }]);
    for (let step = 1; step <= 6; step++) await send('touchMove', [{ x: fromPx + (toPx - fromPx) * step / 6, y }]);
    await send('touchEnd', []);
    await touch.detach();
    return;
  }
  await page.mouse.move(fromPx, y);
  await page.mouse.down();
  await page.mouse.move(toPx, y, { steps: 6 });
  await page.mouse.up();
}

async function exerciseSlider(page, root) {
  const frame = root.locator('.image-compare-frame');
  const slider = root.getByRole('slider', { name: 'Compare the previous and new image' });
  await expect(slider).toHaveValue('50');
  await expect.poll(() => root.locator('.image-compare-frame img').evaluateAll(images => images.every(image => image.complete && image.naturalWidth > 0))).toBe(true);
  expectColour(await colourAt(frame, .35), BLUE);
  expectColour(await colourAt(frame, .65), RUST);
  await drag(page, frame, .2);
  await expect.poll(async () => Number(await slider.inputValue())).toBeLessThan(25);
  expectColour(await colourAt(frame, .35), RUST);
  await slider.focus();
  await page.keyboard.press('End');
  await expect(slider).toHaveValue('100');
  expectColour(await colourAt(frame, .8), BLUE);
  await page.keyboard.press('ArrowLeft');
  await expect(slider).toHaveValue('99');
}

const stage = (status, extra = {}) => ({ status, decision: null, attempts: 1, assetUrl: null, error: null, prompt: null, ...extra });

test('compare a regenerated outfit photo with the one it replaces', async ({ page }, info) => {
  const health = healthOf(page);
  const previous = asDataUrl(await png(1024, 1024, BLUE));
  const next = asDataUrl(await png(1024, 1024, RUST));
  const garments = ['Blue shirt', 'Grey trousers'].map((name, i) => ({ id: `g${i}`, name, part: i ? 'lowerbody' : 'upperbody', image: previous, modeledImage: previous, color: '#2f5d8a', tags: [] }));
  const outfit = { id: 'look-one', name: 'Linen lunch', occasion: ['casual'], garmentIds: ['g0', 'g1'], status: 'review', source: 'generated', attempts: 1, image: previous, previousImage: null, reason: 'Clean and calm.', setting: 'A quiet courtyard.' };
  const job = { id: '00000000-0000-4000-8000-0000000000aa', count: 1, status: 'review', outfits: [outfit], createdAt: '2026-11-05T09:00:00.000Z', updatedAt: '2026-11-05T09:00:00.000Z' };
  const references = { ready: true, hasApiKey: true, hasModelReference: true, modelReferences: [{ id: 'default', label: 'Default', imageUrl: previous }] };
  await page.addInitScript(() => localStorage.setItem('wardrobe:welcome:v1', 'complete'));
  await page.route('**/api/**', async route => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (p === '/api/import/wardrobe') return route.fulfill({ json: garments });
    if (p === '/api/import/config') return route.fulfill({ json: references });
    if (p === '/api/import/jobs') return route.fulfill({ json: [] });
    if (p === '/api/outfits/config') return route.fulfill({ json: { ...references, maxCount: 6 } });
    if (p === '/api/outfits/jobs') return route.fulfill({ json: { jobs: [job] } });
    if (p === `/api/outfits/jobs/${job.id}`) return route.fulfill({ json: job });
    if (p === `/api/outfits/jobs/${job.id}/outfits/look-one/retry`) {
      Object.assign(outfit, { image: next, previousImage: previous, attempts: 2 });
      return route.fulfill({ status: 202, json: job });
    }
    if (p === `/api/outfits/jobs/${job.id}/outfits/look-one/approve`) {
      Object.assign(outfit, { status: 'accepted' });
      return route.fulfill({ json: job });
    }
    if (p === '/api/outfits') return route.fulfill({ json: { outfits: [] } });
    if (req.method() === 'GET') return route.fulfill({ json: {} });
    health.errors.push(`Unexpected API ${req.method()} ${p}`);
    return route.fulfill({ status: 500, json: {} });
  });
  await page.goto('/outfits');
  await page.getByRole('button', { name: /Review outfits/ }).click();
  const dialog = page.getByRole('dialog', { name: '1 outfit idea', exact: true });
  await expect(dialog.getByRole('heading', { name: 'Linen lunch' })).toBeVisible();

  // A first attempt has nothing to compare.
  await expect(dialog.locator('.image-compare')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Regenerate photo', exact: true }).click();
  await expect(dialog.locator('.image-compare')).toBeVisible();
  await dialog.locator('.image-compare').scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('outfit-compare.png') });
  await exerciseSlider(page, dialog);
  await page.screenshot({ path: info.outputPath('outfit-compare-moved.png') });

  await expect(dialog).toBeVisible();

  await dialog.getByRole('button', { name: /Accept into collection/ }).click();
  await expect(dialog.locator('.image-compare')).toHaveCount(0);
  await finish(page, info, health);
});

function importRoutes(page, health, job, assets, regenerate) {
  return page.route('**/api/**', async route => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    const asset = Object.values(assets).find(item => item.path === p);
    if (asset) return route.fulfill({ contentType: 'image/png', body: asset.body });
    if (p === '/api/import/wardrobe') return route.fulfill({ json: [] });
    if (p === '/api/import/config') return route.fulfill({ json: { ready: true, hasApiKey: true, hasModelReference: true, modelReferences: [{ id: 'default', label: 'Default', imageUrl: Object.values(assets)[0].path }] } });
    if (p === '/api/import/jobs') return route.fulfill({ json: url.searchParams.has('ids') ? { jobs: [job], missing: [] } : [job] });
    const stageName = p.match(new RegExp(`^/api/import/jobs/${job.id}/stages/(garment|modeled)/regenerate$`))?.[1];
    if (stageName) {
      regenerate(stageName);
      return route.fulfill({ status: 202, json: job });
    }
    if (p === '/api/outfits') return route.fulfill({ json: { outfits: [] } });
    if (req.method() === 'GET') return route.fulfill({ json: {} });
    health.errors.push(`Unexpected API ${req.method()} ${p}`);
    return route.fulfill({ status: 500, json: {} });
  });
}

async function openImportReview(page, action) {
  await page.addInitScript(() => localStorage.setItem('wardrobe:welcome:v1', 'complete'));
  await page.goto('/');
  await page.getByRole('button', { name: 'Open import progress', exact: true }).click();
  const button = page.getByRole('button', { name: action, exact: true });
  const card = page.locator('.import-card-list').getByText('Blue shirt', { exact: true });
  await expect(button.or(card).first()).toBeVisible();
  if (!await button.isVisible()) await card.click();
  await expect(button).toBeVisible();
  return button;
}

const importJob = (stages) => ({ id: '00000000-0000-4000-8000-000000000001', status: 'active', canUseOriginal: false, metadata: { name: 'Blue shirt', part: 'upperbody', color: '#2f5d8a', tags: [] }, originalAssetUrl: stages.crop.assetUrl, modelReferenceId: 'default',
  createdAt: '2026-11-05T09:00:00.000Z', updatedAt: '2026-11-05T09:00:00.000Z', stages });

test('compare a regenerated transparent cutout during import', async ({ page }, info) => {
  const health = healthOf(page);
  const root = '/api/import/assets/00000000-0000-4000-8000-000000000001';
  const assets = {
    previous: { path: `${root}/garment-1.png`, body: await png(800, 800, BLUE, null) },
    next: { path: `${root}/garment-2.png`, body: await png(800, 800, RUST, null) },
  };
  const job = importJob({ crop: stage('approved', { assetUrl: assets.previous.path }), garment: stage('review', { assetUrl: assets.previous.path, source: 'generated' }), modeled: stage('pending') });
  await importRoutes(page, health, job, assets, () => {
    job.stages.garment = stage('review', { attempts: 2, assetUrl: assets.next.path, previousAssetUrl: assets.previous.path, source: 'generated' });
  });
  const regenerate = await openImportReview(page, 'Create new cutout');
  const editor = page.locator('.import-editor');
  await expect(editor.locator('.image-compare')).toHaveCount(0);
  await regenerate.click();
  await expect(editor.locator('.image-compare')).toBeVisible();
  await editor.locator('.image-compare').scrollIntoViewIfNeeded();

  // exerciseSlider reads painted colours, so neither image may show through the other.
  await exerciseSlider(page, editor);
  await page.screenshot({ path: info.outputPath('import-cutout-compare.png') });

  // Zooming pans the viewport, so it leaves the comparison and returns to it.
  await editor.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect(editor.locator('.image-compare')).toHaveCount(0);
  await expect(editor.getByRole('img', { name: 'Garment ready for review' })).toBeVisible();
  await editor.getByRole('button', { name: 'Fit image', exact: true }).click();
  await expect(editor.locator('.image-compare')).toBeVisible();

  // Approval waits for the new image to load, which the comparison must report.
  await expect(editor.getByRole('button', { name: 'Approve', exact: true })).toBeEnabled();
  await finish(page, info, health);
});

test('compare a modelled photo with the saved photo it would replace, even at another shape', async ({ page }, info) => {
  const health = healthOf(page);
  const root = '/api/import/assets/00000000-0000-4000-8000-000000000001';
  const assets = {
    saved: { path: '/api/import/library/import-saved-modeled.png', body: await png(1024, 1024, BLUE) },
    next: { path: `${root}/modeled-1.png`, body: await png(1536, 1024, RUST) },
    garment: { path: `${root}/garment.png`, body: await png(800, 800, BLUE, null) },
  };
  const job = { ...importJob({ crop: stage('approved', { assetUrl: assets.garment.path }), garment: stage('approved', { assetUrl: assets.garment.path }), modeled: stage('failed', { assetUrl: assets.saved.path, error: 'The first attempt failed.' }) }), modeledReplacement: true };
  await importRoutes(page, health, job, assets, () => {
    job.stages.modeled = stage('review', { assetUrl: assets.next.path, previousAssetUrl: assets.saved.path, source: 'generated', setting: 'A quiet courtyard.' });
  });
  const regenerate = await openImportReview(page, 'Try again');
  const editor = page.locator('.import-editor');
  // A failed attempt has no new image yet, so there is nothing to compare.
  await expect(editor.locator('.image-compare')).toHaveCount(0);
  await regenerate.click();
  await expect(editor.locator('.image-compare')).toBeVisible();
  await editor.locator('.image-compare').scrollIntoViewIfNeeded();
  const frame = editor.locator('.image-compare-frame');
  await expect.poll(() => frame.locator('img').evaluateAll(images => images.every(image => image.complete && image.naturalWidth > 0))).toBe(true);
  await page.screenshot({ path: info.outputPath('import-modelled-compare.png') });
  // Both layers fill one frame shaped by the new photo.
  const boxes = await frame.locator('img').evaluateAll(images => images.map(image => { const { width, height } = image.getBoundingClientRect(); return { width, height }; }));
  expect(boxes[0].width).toBeCloseTo(boxes[1].width, 0);
  expect(boxes[0].height).toBeCloseTo(boxes[1].height, 0);
  expect(boxes[0].width / boxes[0].height).toBeCloseTo(1.5, 1);
  expectColour(await colourAt(frame, .35), BLUE);
  expectColour(await colourAt(frame, .65), RUST);
  await finish(page, info, health);
});

test('a previous image that fails to load falls back to the new one alone', async ({ page }, info) => {
  const health = healthOf(page);
  const missing = '/api/import/assets/00000000-0000-4000-8000-000000000001/modeled-1.png';
  const current = '/api/import/assets/00000000-0000-4000-8000-000000000001/modeled-2.png';
  const body = await png(1536, 1024, RUST);
  const job = { id: '00000000-0000-4000-8000-000000000001', status: 'active', canUseOriginal: false, metadata: { name: 'Blue shirt', part: 'upperbody', color: '#2f5d8a', tags: [] }, originalAssetUrl: current, modelReferenceId: 'default',
    createdAt: '2026-11-05T09:00:00.000Z', updatedAt: '2026-11-05T09:00:00.000Z',
    stages: { crop: stage('approved', { assetUrl: current }), garment: stage('approved', { assetUrl: current, source: 'generated' }), modeled: stage('review', { assetUrl: current, previousAssetUrl: missing, source: 'generated', setting: 'A quiet courtyard.' }) } };
  await page.addInitScript(() => localStorage.setItem('wardrobe:welcome:v1', 'complete'));
  await page.route('**/api/**', async route => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    if (p === current) return route.fulfill({ contentType: 'image/png', body });
    if (p === missing) return route.abort('blockedbyclient');
    if (p === '/api/import/wardrobe') return route.fulfill({ json: [] });
    if (p === '/api/import/config') return route.fulfill({ json: { ready: true, hasApiKey: true, hasModelReference: true, modelReferences: [{ id: 'default', label: 'Default', imageUrl: current }] } });
    if (p === '/api/import/jobs') return route.fulfill({ json: url.searchParams.has('ids') ? { jobs: [job], missing: [] } : [job] });
    if (p === '/api/outfits') return route.fulfill({ json: { outfits: [] } });
    return route.fulfill({ json: {} });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Open import progress', exact: true }).click();
  const photo = page.getByRole('button', { name: 'Create new photo', exact: true });
  const card = page.locator('.import-card-list').getByText('Blue shirt', { exact: true });
  await expect(photo.or(card).first()).toBeVisible();
  if (!await photo.isVisible()) await card.click();
  await expect(page.getByRole('img', { name: 'Generated modelled look' })).toBeVisible();
  await expect(page.locator('.import-editor .image-compare')).toHaveCount(0);
  health.failedRequests = health.failedRequests.filter(item => !item.includes(missing));
  health.errors = health.errors.filter(item => !item.includes('ERR_BLOCKED_BY_CLIENT'));
  await finish(page, info, health);
});
