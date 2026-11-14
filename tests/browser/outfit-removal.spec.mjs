import { test, expect } from '@playwright/test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

// Uses the real local API, with synthetic files in the isolated data directory
// the test server was started with, so removal is checked end to end on disk.
const cutout = (color) => sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><path d="M170 90 L225 70 Q256 105 287 70 L342 90 L410 190 L360 228 L328 190 L334 420 H178 L184 190 L152 228 L102 190Z" fill="${color}"/></svg>`)).png().toBuffer();
const photo = (color) => sharp({ create: { width: 512, height: 768, channels: 3, background: color } }).png().toBuffer();
const pieces = [['top', 'Navy blouse', 'upperbody', '#35495a'], ['bottom', 'Stone trousers', 'lowerbody', '#c5b79a'], ['knit', 'Oatmeal knit', 'upperbody', '#c6bba8']];
const library = pieces.map(([id, name, part, color]) => ({ id, name, part, color, tags: [], image: `/api/import/library/${id}.png` }));
const localDay = () => new Date().toLocaleDateString('en-CA');
const wear = { id: '6f1d1b7e-2c3a-4f5b-9a8e-0d1c2b3a4f5e', date: '2026-01-04', garmentIds: ['top', 'bottom'], createdAt: '2026-01-04T18:00:00.000Z' };
const collection = () => ({
  version: 1,
  outfits: [
    { id: 'morning', name: 'An easy morning', occasion: ['casual'], garmentIds: ['top', 'bottom'], status: 'accepted', reason: 'Familiar pieces.', image: 'outfit-images/morning.png', favourite: true, wearHistory: [wear] },
    { id: 'knitwear', name: 'Knit weekend', occasion: ['casual'], garmentIds: ['knit', 'bottom'], status: 'accepted', reason: 'Soft layers.', image: 'outfit-images/knitwear.png' },
  ],
  outfitPlans: [{ date: localDay(), outfitId: 'morning' }],
  outfitPlansRevision: '0b6f4c1e-8d2a-4e3b-9c5d-7a1f2e3d4c5b',
});

test('a saved look can be removed after confirmation, clearing its plan and keeping its wear history', async ({ page, context }, info) => {
  const data = path.resolve(info.project.outputDir, 'fixture-data');
  const health = { errors: [], failedRequests: [], httpErrors: [] };
  page.on('pageerror', (error) => health.errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') health.errors.push(message.text()); });
  page.on('requestfailed', (request) => { if (!request.failure()?.errorText.includes('ERR_ABORTED')) health.failedRequests.push(request.url()); });
  page.on('response', (response) => { if (response.status() >= 400) health.httpErrors.push(response.url()); });
  try {
    await mkdir(path.join(data, 'imported'), { recursive: true });
    await mkdir(path.join(data, 'outfit-images'), { recursive: true });
    for (const [id, , , color] of pieces) await writeFile(path.join(data, 'imported', `${id}.png`), await cutout(color));
    await writeFile(path.join(data, 'outfit-images', 'morning.png'), await photo('#8a7f70'));
    await writeFile(path.join(data, 'outfit-images', 'knitwear.png'), await photo('#9a8c7a'));
    await writeFile(path.join(data, 'library.json'), JSON.stringify(library));
    await writeFile(path.join(data, 'outfits.json'), JSON.stringify(collection()));
    await context.addInitScript(() => localStorage.setItem('wardrobe:welcome:v1', 'complete'));

    await page.goto('/outfits');
    await expect(page.locator('.outfit-card')).toHaveCount(2);
    await expect(page.locator('.outfit-plans')).toContainText('An easy morning');

    await page.getByRole('button', { name: 'View An easy morning' }).click();
    const dialog = page.locator('dialog.outfit-modal');
    await dialog.getByRole('button', { name: 'Remove look' }).click();
    const confirm = dialog.getByRole('group', { name: 'Remove An easy morning' });
    await expect(confirm).toContainText('Remove An easy morning from your collection?');
    await expect(confirm).toContainText("Its 1 logged wear stays in each piece's wear history.");
    await expect(confirm).toContainText(/Its plan for .+ will be cleared\./);
    await confirm.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('remove-confirm.png') });

    // Keeping it changes nothing.
    await confirm.getByRole('button', { name: 'Keep it' }).click();
    await expect(confirm).toHaveCount(0);
    expect(JSON.parse(await readFile(path.join(data, 'outfits.json'), 'utf8')).outfits[0].status).toBe('accepted');

    await dialog.getByRole('button', { name: 'Remove look' }).click();
    const removal = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/outfits/morning/remove');
    await confirm.getByRole('button', { name: 'Remove look' }).click();
    expect((await removal).status()).toBe(200);
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: 'An easy morning was removed from your collection.' })).toBeVisible();
    await expect(page.locator('.outfit-card')).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'View An easy morning' })).toHaveCount(0);
    await expect(page.locator('.outfit-plans')).not.toContainText('An easy morning');
    await page.screenshot({ path: info.outputPath('after-remove.png') });

    await page.reload();
    await expect(page.locator('.outfit-card')).toHaveCount(1);
    await expect(page.locator('.outfit-plans')).not.toContainText('An easy morning');
    const saved = JSON.parse(await readFile(path.join(data, 'outfits.json'), 'utf8'));
    expect(saved.outfits[0]).toMatchObject({ id: 'morning', status: 'removed', image: 'outfit-images/morning.png' });
    expect(saved.outfitPlans).toEqual([]);
    expect(saved.garmentWears).toEqual([wear]);

    // The piece still shows the day it was worn in that look.
    await page.goto('/');
    await page.getByRole('button', { name: 'View Navy blouse' }).click();
    await expect(page.getByRole('region', { name: 'Wear history and ready looks' })).toContainText('1 day logged');
    await writeFile(info.outputPath('browser-health.json'), JSON.stringify(health, null, 2));
    expect(health).toEqual({ errors: [], failedRequests: [], httpErrors: [] });
  } finally {
    await rm(path.join(data, 'outfits.json'), { force: true });
    await rm(path.join(data, 'library.json'), { force: true });
    await rm(path.join(data, 'imported'), { recursive: true, force: true });
    await rm(path.join(data, 'outfit-images'), { recursive: true, force: true });
  }
});
