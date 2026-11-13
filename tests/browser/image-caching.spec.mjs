import { test, expect } from '@playwright/test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

// Unlike the other suites, this one uses the real local API and its image
// delivery, with synthetic files in the isolated data directory the test
// server was started with. It removes them again when it finishes.
const cutout = (color) => sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><path d="M170 90 L225 70 Q256 105 287 70 L342 90 L410 190 L360 228 L328 190 L334 420 H178 L184 190 L152 228 L102 190Z" fill="${color}"/></svg>`)).png().toBuffer();
const photo = (color) => sharp({ create: { width: 512, height: 768, channels: 3, background: color } }).png().toBuffer();
const library = [
  { id: 'top', name: 'Navy blouse', part: 'upperbody', color: '#35495a', tags: [], image: '/api/import/library/top.png', thumbnail: '/api/import/library/top.png' },
  { id: 'bottom', name: 'Stone trousers', part: 'lowerbody', color: '#c5b79a', tags: [], image: '/api/import/library/bottom.png', thumbnail: '/api/import/library/bottom.png' },
  { id: 'shoes', name: 'Tan loafers', part: 'shoes', color: '#a76e58', tags: [], image: '/api/import/library/shoes.png', thumbnail: '/api/import/library/shoes.png' },
];
const collection = { version: 1, outfits: [{ id: 'look', name: 'An easy morning', occasion: ['casual'], garmentIds: ['top', 'bottom', 'shoes'], status: 'accepted', reason: 'Familiar pieces.', image: 'outfit-images/look.png' }] };

test('display images are kept across visits, unchanged lists answer 304 and originals stay on the server', async ({ page, context }, info) => {
  const data = path.resolve(info.project.outputDir, 'fixture-data');
  const manifest = await readFile(path.join(data, 'outfits.json'), 'utf8').catch(() => null);
  const health = { errors: [], failedRequests: [], httpErrors: [] };
  page.on('pageerror', (error) => health.errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') health.errors.push(message.text()); });
  page.on('requestfailed', (request) => { if (!request.failure()?.errorText.includes('ERR_ABORTED')) health.failedRequests.push(request.url()); });
  page.on('response', (response) => { if (response.status() >= 400) health.httpErrors.push(response.url()); });
  try {
    await mkdir(path.join(data, 'imported'), { recursive: true });
    await mkdir(path.join(data, 'outfit-images'), { recursive: true });
    await writeFile(path.join(data, 'imported', 'top.png'), await cutout('#35495a'));
    await writeFile(path.join(data, 'imported', 'bottom.png'), await cutout('#c5b79a'));
    await writeFile(path.join(data, 'imported', 'shoes.png'), await cutout('#a76e58'));
    await writeFile(path.join(data, 'outfit-images', 'look.png'), await photo('#8a7f70'));
    await writeFile(path.join(data, 'library.json'), JSON.stringify(library));
    await writeFile(path.join(data, 'outfits.json'), JSON.stringify(collection));
    await context.addInitScript(() => localStorage.setItem('wardrobe:welcome:v1', 'complete'));

    // Every image request, with what the network actually did for it.
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    const requests = new Map();
    let images = [];
    cdp.on('Network.requestWillBeSent', (event) => {
      const url = new URL(event.request.url);
      if (/\.png$/.test(url.pathname)) requests.set(event.requestId, { path: url.pathname, display: url.searchParams.has('w'), version: url.searchParams.get('v'), cached: false });
    });
    cdp.on('Network.requestServedFromCache', (event) => { const request = requests.get(event.requestId); if (request) request.cached = true; });
    cdp.on('Network.responseReceived', (event) => {
      const request = requests.get(event.requestId);
      if (!request) return;
      if (event.response.fromDiskCache) request.cached = true;
      request.cacheControl = event.response.headers['Cache-Control'] ?? event.response.headers['cache-control'];
      images.push(request);
    });
    const loaded = (selector) => page.waitForFunction((target) => {
      const found = [...document.querySelectorAll(target)];
      return found.length > 0 && found.every((image) => image.complete && image.naturalWidth > 0);
    }, selector);
    const refocus = async () => {
      const [wardrobe, outfits] = await Promise.all([
        page.waitForResponse((response) => new URL(response.url()).pathname === '/api/import/wardrobe'),
        page.waitForResponse((response) => new URL(response.url()).pathname === '/api/outfits'),
        page.evaluate(() => { window.dispatchEvent(new Event('focus')); }),
      ]);
      return { wardrobe: wardrobe.status(), outfits: outfits.status() };
    };
    const sources = () => page.locator('.gallery-item img').evaluateAll((found) => found.map((image) => image.currentSrc));

    await page.goto('/');
    await expect(page.locator('.gallery-item')).toHaveCount(3);
    await loaded('.gallery-item img');
    const first = await sources();
    for (const source of first) expect(source).toMatch(/\/api\/import\/library\/\w+\.png\?format=webp&w=\d+&v=[a-f0-9]{20}$/);
    expect(images.length).toBeGreaterThanOrEqual(3);
    for (const image of images) {
      expect(image).toMatchObject({ display: true, cached: false, cacheControl: 'private, max-age=31536000, immutable' });
    }

    // A later visit shows the same pictures without asking the server for any.
    images = [];
    await page.reload();
    await expect(page.locator('.gallery-item')).toHaveCount(3);
    await loaded('.gallery-item img');
    expect(await sources()).toEqual(first);
    expect(images.length).toBeGreaterThanOrEqual(3);
    expect(images.filter((image) => !image.cached)).toEqual([]);

    // Coming back to the window re-reads both lists; nothing changed, so
    // neither sends a body and nothing on screen is touched.
    await page.waitForLoadState('networkidle');
    await page.locator('.gallery-item').first().evaluate((node) => { node.dataset.kept = 'yes'; });
    await page.evaluate(() => {
      window.loadingNotices = [];
      new MutationObserver(() => {
        const notice = document.body.textContent.match(/Loading wear history|Loading your wardrobe|Loading wardrobe/);
        if (notice) window.loadingNotices.push(notice[0]);
      }).observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    expect(await refocus()).toEqual({ wardrobe: 304, outfits: 304 });
    await expect(page.locator('.gallery-item[data-kept="yes"]')).toHaveCount(1);
    expect(await page.evaluate(() => window.loadingNotices)).toEqual([]);

    // A change made elsewhere arrives in full on the next read.
    await writeFile(path.join(data, 'library.json'), JSON.stringify(library.map((item) => item.id === 'top' ? { ...item, name: 'Ink blouse' } : item)));
    expect(await refocus()).toEqual({ wardrobe: 200, outfits: 304 });
    await expect(page.getByRole('button', { name: 'View Ink blouse', exact: true })).toBeVisible();
    expect(await sources()).toEqual(first);

    // Replacing a picture under the same address gives it a new version, so
    // the kept copy is never shown in its place.
    images = [];
    await writeFile(path.join(data, 'imported', 'top.png'), await cutout('#b0303a'));
    expect((await refocus()).wardrobe).toBe(200);
    await expect.poll(async () => (await sources())[0]).not.toBe(first[0]);
    await loaded('.gallery-item img');
    const replaced = await sources();
    expect(replaced[0]).toMatch(/\/api\/import\/library\/top\.png\?format=webp&w=\d+&v=[a-f0-9]{20}$/);
    expect(replaced.slice(1)).toEqual(first.slice(1));
    expect(images.filter((image) => !image.cached)).toEqual([expect.objectContaining({ path: '/api/import/library/top.png', display: true, cacheControl: 'private, max-age=31536000, immutable' })]);
    const [red, , blue] = await page.locator('.gallery-item img').first().evaluate((image) => {
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const drawing = canvas.getContext('2d');
      drawing.drawImage(image, 0, 0);
      return [...drawing.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data];
    });
    expect(red).toBeGreaterThan(blue + 60);
    await page.screenshot({ path: info.outputPath('image-caching-wardrobe.png'), fullPage: true });

    // Checking that a look's pieces are available uses small display copies.
    images = [];
    await page.getByRole('link', { name: 'Outfits' }).click();
    await expect(page.getByRole('button', { name: 'Choose An easy morning' })).toBeEnabled();
    await loaded('.outfit-card img');
    await page.screenshot({ path: info.outputPath('image-caching-outfits.png'), fullPage: true });
    await page.getByRole('link', { name: 'Wardrobe' }).click();
    await page.getByRole('button', { name: 'View Ink blouse', exact: true }).click();
    const viewer = page.getByRole('dialog', { name: 'Selected wardrobe item' });
    await expect(viewer.getByRole('button', { name: 'View look' })).toBeEnabled();
    await page.waitForLoadState('networkidle');
    expect(images.length).toBeGreaterThan(0);
    expect(images.filter((image) => !image.display)).toEqual([]);
    expect(images.filter((image) => !image.cached && image.cacheControl !== 'private, max-age=31536000, immutable')).toEqual([]);

    await expect(page.locator('vite-error-overlay')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally {
    await writeFile(info.outputPath('browser-health.json'), JSON.stringify(health, null, 2));
    await rm(path.join(data, 'library.json'), { force: true });
    await rm(path.join(data, 'imported'), { recursive: true, force: true });
    await rm(path.join(data, 'outfit-images', 'look.png'), { force: true });
    if (manifest === null) await rm(path.join(data, 'outfits.json'), { force: true });
    else await writeFile(path.join(data, 'outfits.json'), manifest);
  }
  expect(health).toEqual({ errors: [], failedRequests: [], httpErrors: [] });
});
