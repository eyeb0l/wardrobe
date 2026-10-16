import { test as base, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import sharp from 'sharp';

const artwork = async (color, bottom = false) => `data:image/png;base64,${(await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="300" height="360"><path d="${bottom ? 'M90 40 H210 L230 320 H165 L150 160 L135 320 H70 Z' : 'M100 55 L125 40 Q150 80 175 40 L200 55 L245 220 L205 235 L190 135 L195 295 Q150 310 105 295 L110 135 L95 235 L55 220 Z'}" fill="${color}" stroke="#191919" stroke-opacity=".2" stroke-width="2"/><path d="M150 75 V290" stroke="#ffffff" stroke-opacity=".2" stroke-width="2"/>${bottom ? '' : [100,135,170,205,240].map(y => `<circle cx="150" cy="${y}" r="3" fill="#bdb5a5"/>`).join('')}</svg>`)).png().toBuffer()).toString('base64')}`;
const items = await Promise.all([
  ['blouse', 'Navy button-front blouse', 'upperbody', '#252e3b'],
  ['knit', 'Oatmeal cable knit', 'upperbody', '#c8baa0'],
  ['trousers', 'Stone wide-leg trousers', 'lowerbody', '#b6a78e'],
  ['jeans', 'Indigo straight-leg jeans', 'lowerbody', '#445f79'],
  ['dress', 'Olive midi dress', 'dresses', '#53604d'],
].map(async ([id, name, part, color]) => ({ id, name, part, color, tags: [], revision: id, image: await artwork(color, part === 'lowerbody') })));
const test = base.extend({
  wardrobe: async ({ page }, use, info) => {
    const health = { errors: [], failedRequests: [], httpErrors: [] };
    const state = { posts: [], unavailable: false, exhausted: false, configDelay: 0 };
    page.on('pageerror', e => health.errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') health.errors.push(m.text()); });
    page.on('requestfailed', r => { if (!r.failure()?.errorText.includes('ERR_ABORTED')) health.failedRequests.push(r.url()); });
    page.on('response', r => { if (r.status() >= 400) health.httpErrors.push(r.url()); });
    await page.addInitScript(() => localStorage.setItem('wardrobe:welcome:v1', 'complete'));
    await page.route('**/api/**', async route => {
      const p = new URL(route.request().url()).pathname;
      if (p === '/api/import/wardrobe') return route.fulfill({ json: items });
      if (p === '/api/import/jobs') return route.fulfill({ json: [] });
      if (p === '/api/import/config') return route.fulfill({ json: { ready: true, hasApiKey: true, hasModelReference: true, modelReferences: [] } });
      if (p === '/api/outfits') return route.fulfill({ json: { outfits: [] } });
      if (p === '/api/outfits/discovery/config') return route.fulfill({ json: { ready: false } });
      if (p === '/api/outfits/config') {
        if (state.configDelay) await new Promise(r => setTimeout(r, state.configDelay));
        return route.fulfill({ json: { ready: true, hasApiKey: true, hasModelReference: true, counts: { upperbody: 2, lowerbody: 2 }, maxCount: 12, availableCombinations: 4, garmentCombinations: { ...(state.unavailable ? {} : { blouse: state.exhausted ? 0 : 2 }), knit: 2, trousers: 2, jeans: 2 }, modelReferences: [{ id: 'default', label: 'Your reference', imageUrl: items[0].image }] } });
      }
      if (p === '/api/outfits/jobs') {
        if (route.request().method() === 'POST') {
          const body = route.request().postDataJSON();
          state.posts.push(body);
          return route.fulfill({ json: { id: 'test-job', ...body, status: 'failed', outfits: [], error: 'Synthetic preview: no AI request was made.', createdAt: new Date().toISOString() } });
        }
        return route.fulfill({ json: { jobs: [] } });
      }
      health.errors.push(`Unexpected API ${p}`);
      return route.fulfill({ status: 500, json: {} });
    });
    await page.goto('/');
    await expect(page).toHaveTitle('Open Wardrobe');
    await expect(page.locator('.gallery-item')).toHaveCount(5);
    await use(state);
    await mkdir(dirname(info.outputPath('browser-health.json')), { recursive: true });
    await writeFile(info.outputPath('browser-health.json'), JSON.stringify(health, null, 2));
    expect(health).toEqual({ errors: [], failedRequests: [], httpErrors: [] });
  },
});
const openPiece = async page => {
  await page.getByRole('button', { name: 'View Navy button-front blouse', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Selected wardrobe item' })).toBeVisible();
};
const openForm = async page => {
  await openPiece(page);
  await page.getByRole('button', { name: 'Style this piece', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Generate outfits', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Piece included in every outfit' })).toBeVisible();
};

test('garment action opens the generator and submits the exact piece only after confirmation', async ({ page, wardrobe }, info) => {
  wardrobe.configDelay = 300;
  await openPiece(page);
  await page.getByRole('button', { name: 'Style this piece' }).focus();
  await page.screenshot({ path: info.outputPath('style-this-piece.png'), fullPage: false });
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/outfits$/);
  const dialog = page.getByRole('dialog', { name: 'Generate outfits', exact: true });
  await expect(dialog.getByText('Navy button-front blouse')).toBeVisible();
  await expect(page.getByLabel('Number of outfits')).toHaveValue('2');
  expect(wardrobe.posts).toHaveLength(0);
  await page.getByLabel('Styling direction').fill('Relaxed dinners');
  await expect(page.getByRole('button', { name: 'Generate 2 outfits', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  expect(await dialog.evaluate(e => e.scrollWidth > e.clientWidth)).toBe(false);
  await page.screenshot({ path: info.outputPath('outfits-with-piece.png'), fullPage: true });
  await page.getByRole('button', { name: 'Generate 2 outfits', exact: true }).click();
  await expect.poll(() => wardrobe.posts.length).toBe(1);
  expect(wardrobe.posts[0]).toEqual({ count: 2, direction: 'Relaxed dinners', modelReferenceId: 'default', requiredGarmentId: 'blouse' });
  await expect(page.getByRole('dialog', { name: '2 outfit ideas' })).toBeVisible();
});

test('remove, cancel, navigation and reopening leave ordinary generation unconstrained', async ({ page, wardrobe }) => {
  await openForm(page);
  await page.getByRole('button', { name: 'Remove required piece' }).click();
  await expect(page.getByRole('region', { name: 'Piece included in every outfit' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Generate 2 outfits', exact: true }).click();
  await expect.poll(() => wardrobe.posts.length).toBe(1);
  expect(wardrobe.posts[0]).not.toHaveProperty('requiredGarmentId');
  await expect(page.getByRole('dialog', { name: '2 outfit ideas' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('link', { name: 'Wardrobe', exact: true }).click();
  await openForm(page);
  await page.keyboard.press('Escape');
  expect(wardrobe.posts).toHaveLength(1);
  await page.getByRole('button', { name: 'Generate outfits', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Piece included in every outfit' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.getByRole('link', { name: 'Wardrobe', exact: true }).click();
  await openForm(page);
  await expect(page.getByText('Included in every outfit')).toBeVisible();
});

for (const mode of ['unavailable', 'exhausted']) test(`${mode} required piece blocks generation and permits removal`, async ({ page, wardrobe }) => {
  wardrobe[mode] = true;
  await openForm(page);
  await expect(page.getByRole('button', { name: /^Generate \d/ })).toBeDisabled();
  expect(wardrobe.posts).toHaveLength(0);
  await page.getByRole('button', { name: 'Remove required piece' }).click();
  await expect(page.getByRole('button', { name: /^Generate \d/ })).toBeEnabled();
});

test('unsaved edits guard styling and unsupported dresses have no action', async ({ page, wardrobe }) => {
  await openPiece(page);
  await page.getByLabel('Name', { exact: true }).fill('Edited blouse');
  await expect(page.getByRole('button', { name: 'Style this piece' })).toBeDisabled();
  await page.reload();
  await page.getByRole('button', { name: 'View Olive midi dress', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Style this piece' })).toHaveCount(0);
  expect(wardrobe.posts).toHaveLength(0);
});
