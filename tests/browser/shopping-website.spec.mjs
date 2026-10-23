import { test as base, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import sharp from 'sharp';

const productUrl = 'https://shop.example/products/linen-jacket?colour=blue';
const source = {
  type: 'website',
  url: productUrl,
  imageUrl: 'https://shop.example/images/linen-jacket-blue.jpg',
  name: 'Blue linen jacket',
  brand: 'Example Studio',
  material: '100% linen',
  color: 'Blue',
};
// Synthetic garment artwork keeps screenshots and uploaded fixtures free of
// private wardrobe photos, retailer assets and paid image generation.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="720" viewBox="0 0 600 720">
  <rect width="600" height="720" fill="#eeebe4"/>
  <path d="M204 126 L257 103 L343 103 L396 126 L462 192 L428 370 L380 348 L390 585 Q300 613 210 585 L220 348 L172 370 L138 192 Z" fill="#547286" stroke="#3b5669" stroke-width="4"/>
  <path d="M257 103 L300 180 L262 230 L234 144 M343 103 L300 180 L338 230 L366 144" fill="#718c9e" stroke="#3b5669" stroke-width="3"/>
  <path d="M300 180 V593 M230 390 H278 V438 H230 Z M322 390 H370 V438 H322 Z" fill="none" stroke="#365264" stroke-width="3"/>
  <g fill="#d2c5a5"><circle cx="309" cy="270" r="5"/><circle cx="309" cy="340" r="5"/><circle cx="309" cy="470" r="5"/><circle cx="309" cy="540" r="5"/></g>
</svg>`;
const png = await sharp(Buffer.from(svg)).png().toBuffer();
const jpeg = await sharp(png).jpeg({ quality: 90 }).toBuffer();
const imageDataUrl = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
const reference = { id: 'fixture-reference', label: 'Reference photo', imageUrl: imageDataUrl };
const wardrobe = ['Everyday trousers', 'White shirt', 'Leather trainers'].map((name, index) => ({
  id: `fixture-${index}`, name, part: index === 0 ? 'lowerbody' : index === 1 ? 'upperbody' : 'shoes',
  color: '#eeeeee', tags: [], image: imageDataUrl, thumbnail: imageDataUrl,
}));
const assessment = {
  assessment: {
    verdict: 'consider', itemName: source.name,
    summary: 'A relaxed layer to wear with your everyday pieces.',
    personalFit: 'Check the fit and sleeve length before deciding.',
    wardrobeFit: 'Pairs with the white shirt and everyday trousers.',
    overlap: 'The wardrobe has no similar blue linen jacket.',
    watchOuts: ['Confirm the colour matches the selected shop variant.'],
    pairings: [{ itemIds: ['fixture-0', 'fixture-1'], reason: 'An easy everyday combination.' }],
  },
  context: { wardrobeCount: 3, modelReferenceLabel: reference.label },
};

const test = base.extend({
  shopping: async ({ page }, use, testInfo) => {
    const health = { pageErrors: [], consoleErrors: [], failedRequests: [], httpErrors: [], unexpectedApi: [] };
    const allowedErrors = new Set();
    const state = { imports: [], analyses: [], importHandler: null };
    page.on('pageerror', error => health.pageErrors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') health.consoleErrors.push(message.text()); });
    page.on('requestfailed', request => {
      const error = request.failure()?.errorText || '';
      if (!error.includes('ERR_ABORTED')) health.failedRequests.push({ url: request.url(), error });
    });
    page.on('response', response => {
      if (response.status() >= 400) health.httpErrors.push(`${new URL(response.url()).pathname}:${response.status()}`);
    });
    await page.addInitScript(() => localStorage.setItem('wardrobe:welcome:v1', 'complete'));
    await page.route('**/api/**', async route => {
    if (new URL(route.request().url()).pathname === '/api/outfits' && route.request().method() === 'GET') return route.fulfill({ json: { outfits: [] } });
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/import/wardrobe') return route.fulfill({ json: wardrobe });
      if (path === '/api/import/jobs' && route.request().method() === 'GET') return route.fulfill({ json: [] });
      if (path === '/api/shopping/config' || path === '/api/import/config') return route.fulfill({ json: {
        ready: true, hasApiKey: true, hasModelReference: true, modelReferences: [reference],
      } });
      if (path === '/api/shopping/import-website') {
        state.imports.push(route.request().postDataJSON());
        if (state.importHandler) return state.importHandler(route);
        return route.fulfill({ json: { imageDataUrl, name: `${source.name}.jpg`, websiteSource: source } });
      }
      if (path === '/api/shopping/analyze') {
        state.analyses.push(route.request().postDataJSON());
        return route.fulfill({ json: assessment });
      }
      health.unexpectedApi.push(path);
      return route.fulfill({ status: 500, json: { error: `Unexpected fixture request: ${path}` } });
    });
    await page.goto('/shopping');
    await expect(page).toHaveTitle('Open Wardrobe');
    await expect(page.getByRole('heading', { name: 'Worth adding?' })).toBeVisible();
    await expect(page.getByText('3 pieces in your wardrobe', { exact: true })).toBeVisible();
    await expect(page.locator('vite-error-overlay')).toHaveCount(0);
    await use({ ...state, state, allowedErrors });
    const healthPath = testInfo.outputPath('browser-health.json');
    await mkdir(dirname(healthPath), { recursive: true });
    await writeFile(healthPath, JSON.stringify(health, null, 2));
    await testInfo.attach('browser-health.json', { path: healthPath, contentType: 'application/json' });
    expect(health.pageErrors).toEqual([]);
    expect(health.unexpectedApi).toEqual([]);
    expect(health.failedRequests).toEqual([]);
    expect(health.httpErrors.filter(error => !allowedErrors.has(error))).toEqual([]);
    const consoleErrors = health.consoleErrors.filter(error => ![...allowedErrors].some(allowed =>
      error === `Failed to load resource: the server responded with a status of ${allowed.split(':').at(-1)} (Unprocessable Entity)`));
    expect(consoleErrors).toEqual([]);
  },
});

async function importProduct(page) {
  await page.getByRole('textbox', { name: 'Product URL', exact: true }).fill(productUrl);
  await page.getByRole('button', { name: 'Import link', exact: true }).click();
  await expect(page.locator('.shopping-product-source a')).toBeVisible();
  await expect(page.locator('.shopping-upload-preview')).toBeVisible();
}

test('imports product details and waits for an explicit assessment', async ({ page, shopping }, testInfo) => {
  await importProduct(page);
  expect(shopping.imports).toEqual([{ websiteUrl: productUrl }]);
  expect(shopping.analyses).toHaveLength(0);
  await expect(page.locator('.shopping-product-source a')).toHaveAttribute('href', productUrl);
  await expect(page.getByText('Example Studio', { exact: true })).toBeVisible();
  await expect(page.getByText('100% linen', { exact: true })).toBeVisible();
  await expect(page.getByText(/Check the photo matches the product and colour/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Check this piece', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.screenshot({ path: testInfo.outputPath('shopping-web-import.png'), fullPage: true });
  await page.getByRole('textbox', { name: /What are you looking for/ }).fill('An everyday layer');
  await page.getByRole('button', { name: 'Check this piece', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Worth considering', exact: true })).toBeVisible();
  expect(shopping.analyses).toHaveLength(1);
  expect(shopping.analyses[0]).toMatchObject({ image: imageDataUrl, websiteSource: source, notes: 'An everyday layer', modelReferenceId: reference.id });
  await page.screenshot({ path: testInfo.outputPath('shopping-web-assessment.png'), fullPage: true });
});

test('shows pending import, recovers from a retailer failure, and retries', async ({ page, shopping }) => {
  let release;
  shopping.state.importHandler = async route => {
    await new Promise(resolve => { release = resolve; });
    await route.fulfill({ status: 422, json: { error: 'The shop blocked this request. Upload a product photo or try another link.' } });
  };
  shopping.allowedErrors.add('/api/shopping/import-website:422');
  await page.getByRole('textbox', { name: 'Product URL', exact: true }).fill(productUrl);
  await page.getByRole('button', { name: 'Import link', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Importing…', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Check this piece', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Cancel import', exact: true })).toBeVisible();
  await expect.poll(() => typeof release).toBe('function');
  release();
  await expect(page.getByRole('alert')).toContainText('The shop blocked this request.');
  await expect(page.getByRole('button', { name: 'Import link', exact: true })).toBeEnabled();
  await expect(page.getByRole('textbox', { name: 'Product URL', exact: true })).toHaveValue(productUrl);
  shopping.state.importHandler = null;
  await page.getByRole('button', { name: 'Import link', exact: true }).click();
  await expect(page.locator('.shopping-product-source a')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(shopping.analyses).toHaveLength(0);
});

test('replacement upload clears retailer details and invalidates the previous result', async ({ page, shopping }) => {
  await importProduct(page);
  await page.getByRole('button', { name: 'Check this piece', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Worth considering', exact: true })).toBeVisible();
  await page.getByLabel('Choose a shopping image', { exact: true }).setInputFiles({ name: 'replacement-jacket.png', mimeType: 'image/png', buffer: png });
  await expect(page.getByText('replacement-jacket.png', { exact: true })).toBeVisible();
  await expect(page.locator('.shopping-product-source a')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Worth considering', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Check this piece', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Worth considering', exact: true })).toBeVisible();
  expect(shopping.analyses).toHaveLength(2);
  expect(shopping.analyses[1].websiteSource).toBeUndefined();
  expect(shopping.analyses[1].image).toMatch(/^data:image\/jpeg;base64,/);
});

test('remove clears imported candidate and the assessment; ordinary upload still works', async ({ page, shopping }) => {
  await importProduct(page);
  await page.getByRole('button', { name: 'Check this piece', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Worth considering', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Remove shopping image', exact: true }).click();
  await expect(page.locator('.shopping-upload-preview')).toHaveCount(0);
  await expect(page.locator('.shopping-product-source a')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Worth considering', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Check this piece', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Choose image', exact: true })).toBeFocused();
  await page.getByLabel('Choose a shopping image', { exact: true }).setInputFiles({ name: 'uploaded-jacket.png', mimeType: 'image/png', buffer: png });
  await expect(page.getByText('uploaded-jacket.png', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Check this piece', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Worth considering', exact: true })).toBeVisible();
  expect(shopping.analyses[1].websiteSource).toBeUndefined();
});

test('rejects an incomplete import without discarding the previous candidate', async ({ page, shopping }) => {
  await importProduct(page);
  shopping.state.importHandler = route => route.fulfill({ json: {
    imageDataUrl, name: 'Incomplete product', websiteSource: { type: 'website' },
  } });
  await page.getByRole('button', { name: 'Import link', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('The product import was incomplete.');
  await expect(page.getByRole('heading', { name: source.name, exact: true })).toBeVisible();
  await expect(page.locator('.shopping-upload-preview')).toHaveAttribute('src', imageDataUrl);
  await expect(page.getByRole('button', { name: 'Check this piece', exact: true })).toBeEnabled();
  expect(shopping.analyses).toHaveLength(0);
});

test('cancel ignores a late response and keeps the previous candidate', async ({ page, shopping }) => {
  await importProduct(page);
  let release;
  let finished = false;
  shopping.state.importHandler = async route => {
    await new Promise(resolve => { release = resolve; });
    await route.fulfill({ json: { imageDataUrl, name: 'Late response', websiteSource: { ...source, name: 'Late response' } } });
    finished = true;
  };
  await page.getByRole('button', { name: 'Import link', exact: true }).click();
  await expect.poll(() => typeof release).toBe('function');
  await page.getByRole('button', { name: 'Cancel import', exact: true }).click();
  release();
  await expect.poll(() => finished).toBe(true);
  await expect(page.getByRole('heading', { name: source.name, exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Late response', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Check this piece', exact: true })).toBeEnabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(shopping.analyses).toHaveLength(0);
});

test('replacement during import ignores the late retailer response', async ({ page, shopping }) => {
  await importProduct(page);
  let release;
  let finished = false;
  shopping.state.importHandler = async route => {
    await new Promise(resolve => { release = resolve; });
    await route.fulfill({ json: { imageDataUrl, name: 'Late response', websiteSource: { ...source, name: 'Late response' } } });
    finished = true;
  };
  await page.getByRole('button', { name: 'Import link', exact: true }).click();
  await expect.poll(() => typeof release).toBe('function');
  await page.getByLabel('Choose a shopping image', { exact: true }).setInputFiles({ name: 'replacement-during-import.png', mimeType: 'image/png', buffer: png });
  await expect(page.getByText('replacement-during-import.png', { exact: true })).toBeVisible();
  release();
  await expect.poll(() => finished).toBe(true);
  await expect(page.locator('.shopping-product-source')).toHaveCount(0);
  await expect(page.getByText('replacement-during-import.png', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Check this piece', exact: true })).toBeEnabled();
  expect(shopping.analyses).toHaveLength(0);
});

test('notes and imported candidate survive navigation between Wardrobe and Shopping', async ({ page, shopping }) => {
  await importProduct(page);
  await page.getByRole('textbox', { name: /What are you looking for/ }).fill('A light summer layer');
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Wardrobe', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Shopping', exact: true }).click();
  await expect(page).toHaveURL(/\/shopping$/);
  await expect(page.getByRole('textbox', { name: /What are you looking for/ })).toHaveValue('A light summer layer');
  await expect(page.getByRole('heading', { name: source.name, exact: true })).toBeVisible();
  expect(shopping.analyses).toHaveLength(0);
});

for (const mode of ['paste', 'drop']) {
  test(`${mode} upload replaces imported source before assessment`, async ({ page, shopping }) => {
    await importProduct(page);
    const filename = `${mode}-jacket.png`;
    await page.evaluate(({ encoded, filename, mode }) => {
      const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], filename, { type: 'image/png' }));
      if (mode === 'paste') document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
      else document.querySelector('.shopping-upload').dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
    }, { encoded: png.toString('base64'), filename, mode });
    await expect(page.getByText(filename, { exact: true })).toBeVisible();
    await expect(page.locator('.shopping-product-source')).toHaveCount(0);
    expect(shopping.analyses).toHaveLength(0);
    await page.getByRole('button', { name: 'Check this piece', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Worth considering', exact: true })).toBeVisible();
    expect(shopping.analyses[0].websiteSource).toBeUndefined();
    expect(shopping.analyses[0].image).toMatch(/^data:image\/jpeg;base64,/);
  });
}
