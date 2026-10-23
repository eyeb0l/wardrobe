import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import sharp from 'sharp';

const png = `data:image/png;base64,${(await sharp({ create: { width: 64, height: 64, channels: 4, background: '#567586' } }).png().toBuffer()).toString('base64')}`;
const ids = ['00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000b'];
const stage = (status, extra = {}) => ({ status, decision: null, attempts: status === 'pending' ? 0 : 1, assetUrl: null, error: null, prompt: null, ...extra });
const job = (id, name, garment) => ({ id, status: 'active', canUseOriginal: false, createdAt: `2026-10-17T00:00:0${ids.indexOf(id)}.000Z`, updatedAt: new Date().toISOString(),
  metadata: { name, part: 'upperbody', color: '#567586', secondaryColor: null, tags: [] }, modelReferenceId: 'default', originalAssetUrl: png,
  stages: { crop: stage('approved', { assetUrl: png }), garment: garment === 'review' ? stage('review', { assetUrl: png, source: 'generated' }) : stage(garment), modeled: stage('pending') } });

test('import progress polls every active job in one gently paced request', async ({ page }, testInfo) => {
  const health = { errors: [], failedRequests: [], httpErrors: [] };
  page.on('pageerror', error => health.errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') health.errors.push(message.text()); });
  page.on('requestfailed', request => { if (!request.failure()?.errorText.includes('ERR_ABORTED')) health.failedRequests.push(request.url()); });
  page.on('response', response => { if (response.status() >= 400) health.httpErrors.push(response.url()); });
  const jobs = new Map([[ids[0], job(ids[0], 'Blue top', 'processing')], [ids[1], job(ids[1], 'Rose top', 'processing')]]);
  const polls = [], singleReads = [];
  await page.addInitScript(() => localStorage.setItem('wardrobe:welcome:v1', 'complete'));
  await page.route('**/api/**', async route => {
    if (new URL(route.request().url()).pathname === '/api/outfits' && route.request().method() === 'GET') return route.fulfill({ json: { outfits: [] } });
    const url = new URL(route.request().url());
    if (url.pathname === '/api/import/wardrobe') return route.fulfill({ json: [] });
    if (url.pathname === '/api/import/config') return route.fulfill({ json: { ready: true, hasApiKey: true, hasModelReference: true, modelReferences: [{ id: 'default', label: 'Default', imageUrl: png }] } });
    if (url.pathname === '/api/import/jobs' && url.searchParams.has('ids')) {
      const requested = url.searchParams.get('ids').split(',');
      polls.push({ at: Date.now(), ids: requested });
      // Progress arrives on the third poll; the second item finishes later.
      if (polls.length === 3) jobs.set(ids[0], job(ids[0], 'Blue top', 'review'));
      if (polls.length === 5) jobs.set(ids[1], job(ids[1], 'Rose top', 'review'));
      return route.fulfill({ json: { jobs: requested.filter(id => jobs.has(id)).map(id => jobs.get(id)), missing: requested.filter(id => !jobs.has(id)) } });
    }
    if (url.pathname === '/api/import/jobs') return route.fulfill({ json: [...jobs.values()] });
    if (url.pathname.startsWith('/api/import/jobs/')) { singleReads.push(url.pathname); return route.fulfill({ json: jobs.get(url.pathname.split('/').pop()) }); }
    if (url.pathname.startsWith('/api/outfits') || url.pathname.startsWith('/api/shopping')) return route.fulfill({ status: 404, json: {} });
    health.errors.push(`Unexpected API ${url.pathname}`);
    return route.fulfill({ status: 500, json: {} });
  });
  await page.goto('/');
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: 'Open import progress' }).click();
  await expect(page.getByRole('heading', { name: 'Preparing new pieces' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('import-polling-processing.png'), fullPage: true });

  await expect.poll(() => polls.length, { timeout: 15_000 }).toBeGreaterThanOrEqual(4);
  expect(polls.slice(0, 3).map(poll => poll.ids.sort())).toEqual([ids, ids, ids]);
  // The first item left processing on poll 3, so poll 4 asks only for the other one.
  expect(polls[3].ids).toEqual([ids[1]]);
  await expect(page.getByRole('heading', { name: '1 ready for review' })).toBeVisible();
  const [first, second, third] = [polls[1].at - polls[0].at, polls[2].at - polls[1].at, polls[3].at - polls[2].at];
  expect(first).toBeGreaterThanOrEqual(1300);
  expect(second, 'unchanged progress backs off').toBeGreaterThan(first + 400);
  expect(third, 'a new polling set starts promptly').toBeLessThan(second);

  await expect.poll(() => polls.length, { timeout: 15_000 }).toBe(5);
  await expect(page.getByRole('heading', { name: '2 ready for review' })).toBeVisible();
  await page.waitForTimeout(3500);
  expect(polls, 'polling stops once every item awaits review').toHaveLength(5);
  expect(singleReads, 'no per-job progress reads').toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.screenshot({ path: testInfo.outputPath('import-polling-review.png'), fullPage: true });

  const file = testInfo.outputPath('browser-health.json');
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(health, null, 2));
  expect(health).toEqual({ errors: [], failedRequests: [], httpErrors: [] });
});
