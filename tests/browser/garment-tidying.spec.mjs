import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import sharp from 'sharp';

const image = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="300" height="360"><path d="M100 55 L125 40 Q150 80 175 40 L200 55 L245 220 L205 235 L190 135 L195 295 Q150 310 105 295 L110 135 L95 235 L55 220 Z" fill="#567586"/><path d="M150 75 V290 M115 175 Q145 160 185 185" fill="none" stroke="#344e60" stroke-width="3"/>${[100,135,170,205,240].map(y => `<circle cx="150" cy="${y}" r="3" fill="#d6c8ad"/>`).join('')}</svg>`)).png().toBuffer();
const png = `data:image/png;base64,${image.toString('base64')}`;
const stage = (status, extra = {}) => ({ status, decision: null, attempts: 0, assetUrl: null, error: null, prompt: null, ...extra });

test('upload offers optional gentle tidying and holds the result for review', async ({ page }, info) => {
  const health = { errors: [], failedRequests: [], httpErrors: [] };
  page.on('pageerror', e => health.errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') health.errors.push(m.text()); });
  page.on('requestfailed', r => { if (!r.failure()?.errorText.includes('ERR_ABORTED')) health.failedRequests.push(r.url()); });
  page.on('response', r => { if (r.status() >= 400) health.httpErrors.push(r.url()); });
  const jobs = [];
  const approvals = [];
  const uploads = [];
  await page.addInitScript(() => localStorage.setItem('wardrobe:welcome:v1', 'complete'));
  await page.route('**/api/**', async route => {
    if (new URL(route.request().url()).pathname === '/api/outfits' && route.request().method() === 'GET') return route.fulfill({ json: { outfits: [] } });
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    if (p === '/api/import/wardrobe') return route.fulfill({ json: [] });
    if (p === '/api/import/config') return route.fulfill({ json: { ready: true, hasApiKey: true, hasModelReference: true, modelReferences: [{ id: 'default', label: 'Default', imageUrl: png }] } });
    if (p === '/api/import/jobs') {
      if (req.method() === 'POST') {
        uploads.push(req.postDataJSON());
        const id = `00000000-0000-4000-8000-00000000000${uploads.length}`;
        const job = { id, status: 'active', canUseOriginal: false, metadata: { name: uploads.length === 1 ? 'Blue shirt' : 'Second blue shirt', part: 'upperbody', color: '#567586', tags: [] }, originalAssetUrl: png, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          stages: { crop: stage('review', { assetUrl: png }), garment: stage('pending'), modeled: stage('pending') } };
        jobs.push(job);
        return route.fulfill({ status: 202, json: { jobs: [job] } });
      }
      return route.fulfill({ json: url.searchParams.has('ids') ? { jobs, missing: [] } : jobs });
    }
    const approve = p.match(/\/jobs\/([^/]+)\/stages\/crop\/approve$/);
    if (approve) {
      const body = req.postDataJSON();
      approvals.push(body);
      const job = jobs.find(j => j.id === approve[1]);
      Object.assign(job, { tidyGarment: body.tidyGarment, updatedAt: new Date().toISOString() });
      job.stages.crop.status = 'approved';
      job.stages.garment = stage('review', { assetUrl: png, source: 'generated', attempts: 1 });
      return route.fulfill({ json: job });
    }
    health.errors.push(`Unexpected API ${req.method()} ${p}`);
    return route.fulfill({ status: 500, json: {} });
  });
  await page.goto('/');
  await expect(page).toHaveTitle('Open Wardrobe');
  await expect(page.getByRole('button', { name: 'Add clothes', exact: true })).toBeVisible();
  await page.getByLabel('Choose wardrobe images').setInputFiles({ name: 'shirt.png', mimeType: 'image/png', buffer: image });
  const tidy = page.getByRole('radio', { name: 'Gently tidy garment', exact: false });
  await expect(tidy).toBeVisible();
  await expect(tidy).not.toBeChecked();
  await expect(page.getByRole('radio', { name: 'Extract garment', exact: false })).toBeChecked();
  expect(uploads).toHaveLength(1);
  expect(approvals).toHaveLength(0);
  await tidy.check();
  await expect(page.getByRole('button', { name: 'Tidy & extract garment', exact: true })).toBeEnabled();
  await page.getByRole('radio', { name: 'Use original image', exact: false }).check();
  await expect(tidy).not.toBeChecked();
  await page.getByRole('radio', { name: 'Extract garment', exact: false }).check();
  await expect(tidy).not.toBeChecked();
  await tidy.check();
  expect(approvals).toHaveLength(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.screenshot({ path: info.outputPath('garment-tidying-option.png'), fullPage: true });
  await page.getByRole('button', { name: 'Tidy & extract garment', exact: true }).click();
  await expect(page.getByText('Check the tidied image against your original.', { exact: false })).toBeVisible();
  expect(approvals).toEqual([{ tidyGarment: true }]);
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeEnabled();
  expect(jobs[0].stages.modeled.status).toBe('pending');
  await page.screenshot({ path: info.outputPath('garment-tidying-review.png'), fullPage: true });
  await page.reload();
  await page.getByRole('button', { name: 'Open import progress' }).click();
  await expect(page.getByText('Check the tidied image against your original.', { exact: false })).toBeVisible();
  // Another upload starts with ordinary extraction; tidying is per garment.
  await page.getByLabel('Choose wardrobe images').setInputFiles({ name: 'second-shirt.png', mimeType: 'image/png', buffer: image });
  await page.getByRole('button', { name: 'Review Second blue shirt', exact: true }).click();
  await expect(tidy).not.toBeChecked();
  await expect(page.getByRole('radio', { name: 'Extract garment', exact: false })).toBeChecked();
  await page.getByRole('button', { name: 'Extract garment', exact: true }).click();
  expect(approvals).toEqual([{ tidyGarment: true }, { tidyGarment: false }]);
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  expect(await page.locator('.import-popover').evaluate(e => e.scrollWidth > e.clientWidth)).toBe(false);
  await writeFile(info.outputPath('browser-health.json'), JSON.stringify(health, null, 2));
  expect(health).toEqual({ errors: [], failedRequests: [], httpErrors: [] });
});
