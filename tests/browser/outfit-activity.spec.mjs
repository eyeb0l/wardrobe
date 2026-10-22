import { test as base, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';

const picture = async (top, bottom) => `data:image/png;base64,${(await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600"><rect width="600" height="600" fill="#eee8de"/><path d="M230 76 L268 60 Q300 96 332 60 L370 76 L420 225 L365 244 L346 162 L351 300 Q300 320 249 300 L254 162 L235 244 L180 225Z" fill="${top}"/><path d="M251 325 H349 L375 552 H313 L300 415 L287 552 H225Z" fill="${bottom}"/><path d="M300 103 V287" stroke="#fff" opacity=".18"/><path d="M250 337 H350" stroke="#fff" opacity=".25"/></svg>`)).png().toBuffer()).toString('base64')}`;
const navy = await picture('#303f51', '#bcaf98');
const oat = await picture('#c6bba8', '#4b6079');
const olive = await picture('#65715b', '#413c37');
const items = [
  { id: 'blouse', name: 'Navy blouse', part: 'upperbody', color: '#303f51', image: navy, tags: [] },
  { id: 'trousers', name: 'Stone trousers', part: 'lowerbody', color: '#bcaf98', image: navy, tags: [] },
  { id: 'knit', name: 'Oatmeal knit', part: 'upperbody', color: '#c6bba8', image: oat, tags: [] },
  { id: 'jeans', name: 'Indigo jeans', part: 'lowerbody', color: '#4b6079', image: oat, tags: [] },
];
const initial = [
  { id: 'dinner', name: 'Dinner by the river', occasion: ['dinner', 'smart-casual'], garmentIds: ['blouse', 'trousers'], image: navy },
  { id: 'weekend', name: 'A slow Saturday', occasion: ['casual'], garmentIds: ['knit', 'jeans'], image: oat },
  { id: 'office', name: 'Back to the office', occasion: ['work', 'smart-casual'], garmentIds: ['blouse', 'jeans'], image: olive },
].map(outfit => ({ ...outfit, status: 'accepted', reason: 'Easy proportions and familiar pieces, ready to wear again.' }));

const test = base.extend({
  wardrobe: async ({ page, context }, use, info) => {
    const health = { errors: [], failedRequests: [], httpErrors: [] };
    const state = { outfits: structuredClone(initial), posts: [], failNext: false, failRead: false, delayRead: null };
    page.on('pageerror', e => health.errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error' && !m.text().includes('503 (Service Unavailable)')) health.errors.push(m.text()); });
    page.on('requestfailed', r => { if (!r.failure()?.errorText.includes('ERR_ABORTED')) health.failedRequests.push(r.url()); });
    page.on('response', r => { if (r.status() >= 400 && r.status() !== 503) health.httpErrors.push(r.url()); });
    await context.addInitScript(() => localStorage.setItem('wardrobe:welcome:v1', 'complete'));
    await context.route('**/api/**', async route => {
      const p = new URL(route.request().url()).pathname;
      if (p === '/api/import/wardrobe') return route.fulfill({ json: items });
      if (p === '/api/import/jobs') return route.fulfill({ json: [] });
      if (p === '/api/import/config') return route.fulfill({ json: { ready: false, hasApiKey: false, hasModelReference: false, modelReferences: [] } });
      if (p === '/api/outfits') {
        if (state.failRead) return route.fulfill({ status: 503, json: { error: 'Collection unavailable. Try again.' } });
        const snapshot = structuredClone(state.outfits);
        if (state.delayRead) { const wait = state.delayRead; state.delayRead = null; await wait; }
        return route.fulfill({ json: { outfits: snapshot } });
      }
      if (p === '/api/outfits/discovery/config') return route.fulfill({ json: { ready: false } });
      if (p === '/api/outfits/config') return route.fulfill({ json: { ready: false, hasApiKey: false, modelReferences: [] } });
      if (p === '/api/outfits/jobs') return route.fulfill({ json: { jobs: [] } });
      if (p.endsWith('/accessories')) return route.fulfill({ json: { hasApiKey: false } });
      const match = p.match(/^\/api\/outfits\/([^/]+)\/(favourite|wears|wears\/([^/]+)\/remove)$/);
      if (match && route.request().method() === 'POST') {
        const body = route.request().postDataJSON();
        state.posts.push({ action: match[2], ...body });
        if (state.failNext) { state.failNext = false; return route.fulfill({ status: 503, json: { error: 'Could not save. Try again.' } }); }
        const outfit = state.outfits.find(o => o.id === match[1]);
        if (match[2] === 'favourite') outfit.favourite = body.favourite;
        else if (match[2] === 'wears') {
          outfit.wearHistory ||= [];
          if (!outfit.wearHistory.some(e => e.date === body.date)) outfit.wearHistory.push({ id: randomUUID(), date: body.date, garmentIds: body.garmentIds || outfit.garmentIds, createdAt: new Date().toISOString() });
        } else outfit.wearHistory = (outfit.wearHistory || []).filter(e => e.id !== match[3]);
        return route.fulfill({ json: outfit });
      }
      health.errors.push(`Unexpected API ${p}`);
      return route.fulfill({ status: 500, json: {} });
    });
    await page.goto('/outfits');
    await expect(page).toHaveTitle('Open Wardrobe');
    await expect(page.locator('.outfit-card')).toHaveCount(3);
    await use(state);
    await expect(page.locator('vite-error-overlay')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await mkdir(dirname(info.outputPath('browser-health.json')), { recursive: true });
    await writeFile(info.outputPath('browser-health.json'), JSON.stringify(health, null, 2));
    expect(health).toEqual({ errors: [], failedRequests: [], httpErrors: [] });
  },
});

test('favourites and intersecting filters persist and connect from a wardrobe piece without AI', async ({ page, wardrobe }, info) => {
  await page.getByRole('button', { name: 'Add Dinner by the river to favourites' }).click();
  await expect(page.getByRole('button', { name: 'Remove Dinner by the river from favourites' })).toHaveAttribute('aria-pressed', 'true');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Remove Dinner by the river from favourites' })).toBeVisible();
  await page.getByRole('button', { name: 'Favourites', exact: true }).click();
  await expect(page.locator('.outfit-card')).toHaveCount(1);
  await page.getByRole('combobox', { name: 'Occasion', exact: true }).selectOption('work');
  await expect(page.getByText('No outfits match.')).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await page.getByRole('combobox', { name: 'Occasion', exact: true }).selectOption('smart-casual');
  await page.getByRole('combobox', { name: 'Garment', exact: true }).selectOption('jeans');
  await expect(page.locator('.outfit-card')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'View Back to the office', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await page.screenshot({ path: info.outputPath('outfit-collection.png'), fullPage: true });
  await page.getByRole('link', { name: 'Wardrobe', exact: true }).click();
  await page.getByRole('button', { name: 'View Navy blouse', exact: true }).click();
  await page.getByRole('button', { name: 'View saved outfits with this piece' }).click();
  await expect(page).toHaveURL(/\/outfits$/);
  await expect(page.getByRole('combobox', { name: 'Garment', exact: true })).toHaveValue('blouse');
  await expect(page.locator('.outfit-card')).toHaveCount(2);
  expect(wardrobe.posts).toEqual([{ action: 'favourite', favourite: true }]);
  await page.screenshot({ path: info.outputPath('outfit-filtered.png'), fullPage: true });
});

test('wear today, undo, backdate, choose pieces, reload and remove an entry', async ({ page, wardrobe }, info) => {
  await page.getByRole('button', { name: 'View Dinner by the river', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Dinner by the river', exact: true });
  await expect(dialog.getByText('No wears logged')).toBeVisible();
  await dialog.getByRole('button', { name: 'Wore this today', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Worn today', exact: true })).toBeDisabled();
  const date = await page.evaluate(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; });
  expect(wardrobe.outfits[0].wearHistory[0].date).toBe(date);
  await dialog.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(dialog.getByText('No wears logged')).toBeVisible();
  await dialog.getByText('Log another date or edit history', { exact: true }).click();
  await dialog.getByLabel('Date worn', { exact: true }).fill('2026-01-04');
  await dialog.getByLabel('Stone trousers', { exact: true }).uncheck();
  await dialog.getByRole('button', { name: 'Log wear', exact: true }).click();
  await expect(dialog.getByText(/1 wear logged/)).toBeVisible();
  expect(wardrobe.outfits[0].wearHistory[0].garmentIds).toEqual(['blouse']);
  await expect(dialog.getByRole('button', { name: 'Already logged for this date' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Add Dinner by the river to favourites' }).click();
  await page.reload();
  await page.getByRole('button', { name: 'View Dinner by the river', exact: true }).click();
  await expect(dialog.getByText(/1 wear logged/)).toBeVisible();
  await dialog.getByText('Log another date or edit history', { exact: true }).click();
  await dialog.locator('.outfit-activity').scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('outfit-wear-history.png'), fullPage: false });
  await dialog.getByRole('button', { name: /^Remove wear on/ }).click();
  await expect(dialog.getByText('No wears logged')).toBeVisible();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('button', { name: 'View Dinner by the river', exact: true })).toBeFocused();
});

test('failed saves and failed recovery reads stay visible and can be retried', async ({ page, wardrobe }) => {
  wardrobe.failNext = true;
  wardrobe.failRead = true;
  await page.getByRole('button', { name: 'Add Dinner by the river to favourites' }).click();
  await expect(page.getByText('Could not save. Try again.')).toBeVisible();
  await expect(page.getByText('Collection unavailable. Try again.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add Dinner by the river to favourites' })).toBeEnabled();
  wardrobe.failRead = false;
  await page.getByRole('button', { name: 'Reload collection', exact: true }).click();
  await page.getByRole('button', { name: 'Add Dinner by the river to favourites' }).click();
  await expect(page.getByRole('button', { name: 'Remove Dinner by the river from favourites' })).toBeVisible();
  await page.getByRole('button', { name: 'View Dinner by the river', exact: true }).click();
  wardrobe.failNext = true;
  await page.getByRole('button', { name: 'Wore this today', exact: true }).click();
  await expect(page.getByRole('dialog').getByText('Could not save. Try again.')).toBeVisible();
  await page.getByRole('button', { name: 'Wore this today', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Worn today', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
});

test('a stale focus refresh cannot overwrite a newly saved favourite', async ({ page, wardrobe }) => {
  let release;
  wardrobe.delayRead = new Promise(resolve => { release = resolve; });
  const started = page.waitForRequest(r => new URL(r.url()).pathname === '/api/outfits');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await started;
  await page.getByRole('button', { name: 'Add Dinner by the river to favourites' }).click();
  await expect(page.getByRole('button', { name: 'Remove Dinner by the river from favourites' })).toBeVisible();
  release();
  await page.getByRole('button', { name: 'Favourites', exact: true }).click();
  await expect(page.locator('.outfit-card')).toHaveCount(1);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Remove Dinner by the river from favourites' })).toBeVisible();
});
