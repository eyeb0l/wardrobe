import { test as base, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import sharp from 'sharp';

const artwork = async color => `data:image/png;base64,${(await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="#eee8de"/><path d="M135 70 L175 55 Q200 82 225 55 L265 70 L320 150 L280 180 L255 150 L260 330 H140 L145 150 L120 180 L80 150Z" fill="${color}"/></svg>`)).png().toBuffer()).toString('base64')}`;
const label = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="300"><rect width="600" height="300" fill="#f7f4ee"/><text x="40" y="160" font-size="48" font-family="sans-serif">30 · no bleach</text></svg>')).jpeg().toBuffer();
const initial = [
  { id: 'navy', name: 'Navy blouse', part: 'upperbody', color: '#35495a', image: await artwork('#35495a') },
  { id: 'wool', name: 'Wool jumper', part: 'upperbody', color: '#827455', image: await artwork('#827455'), care: { wash: 'hand', dry: 'flat' } },
].map(item => ({ ...item, tags: [], revision: item.id }));

const test = base.extend({
  wardrobe: async ({ page, context }, use, info) => {
    const state = { items: structuredClone(initial), patches: [], scans: [], scanReply: null };
    const health = { errors: [], failedRequests: [], httpErrors: [] };
    const expected = (status, url) => status === 422 && new URL(url).pathname === '/api/import/care-label/scan';
    page.on('pageerror', e => health.errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error' && !/422 \(Unprocessable/.test(m.text())) health.errors.push(m.text()); });
    page.on('requestfailed', r => { if (!r.failure()?.errorText.includes('ERR_ABORTED')) health.failedRequests.push(r.url()); });
    page.on('response', r => { if (r.status() >= 400 && !expected(r.status(), r.url())) health.httpErrors.push(r.url()); });
    await context.addInitScript(() => localStorage.setItem('wardrobe:welcome:v1', 'complete'));
    await context.route('**/api/**', async route => {
      const p = new URL(route.request().url()).pathname, method = route.request().method();
      if (p === '/api/import/wardrobe') return route.fulfill({ json: state.items });
      if (p === '/api/import/jobs') return route.fulfill({ json: [] });
      if (p === '/api/import/config' || p === '/api/outfits/config') return route.fulfill({ json: { ready: false, hasApiKey: true, modelReferences: [] } });
      if (p === '/api/outfits/discovery/config') return route.fulfill({ json: { ready: false, enabled: false } });
      if (p === '/api/outfits/jobs') return route.fulfill({ json: { jobs: [] } });
      if (p === '/api/outfits') return route.fulfill({ json: { outfits: [] } });
      if (p === '/api/import/care-label/scan' && method === 'POST') {
        const body = route.request().postDataJSON(); state.scans.push(body);
        if (state.scanReply) return route.fulfill(state.scanReply);
        return route.fulfill({ json: { care: { wash: 'machine-30-gentle', bleach: 'no', iron: 'low', notes: 'Wash inside out' } } });
      }
      const edit = p.match(/^\/api\/import\/wardrobe\/([^/]+)$/);
      if (edit && method === 'PATCH') {
        const body = route.request().postDataJSON(), item = state.items.find(i => i.id === edit[1]);
        state.patches.push(body);
        const { care, ...changes } = body.changes;
        Object.assign(item, changes, { revision: crypto.randomUUID() });
        if (care) item.care = Object.fromEntries(Object.entries(care).filter(([, value]) => value)); else delete item.care;
        return route.fulfill({ json: item });
      }
      health.errors.push(`Unexpected API ${method} ${p}`); return route.fulfill({ status: 500, json: {} });
    });
    await page.goto('/'); await expect(page.locator('.gallery-item')).toHaveCount(2);
    await use(state);
    await expect(page.locator('vite-error-overlay')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await writeFile(info.outputPath('browser-health.json'), JSON.stringify(health, null, 2));
    expect(health).toEqual({ errors: [], failedRequests: [], httpErrors: [] });
  },
});

const open = async (page, name) => {
  await page.getByRole('button', { name: `View ${name}`, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Selected wardrobe item' });
  return { dialog, care: dialog.locator('details.care-label') };
};

test('care label: scan fills the draft for review, then saves with the item and survives reload', async ({ page, wardrobe }, info) => {
  const { dialog, care } = await open(page, 'Navy blouse');
  await expect(care.locator('summary')).toContainText('Not added');
  await care.locator('summary').click();
  await expect(care.getByRole('combobox', { name: 'Washing', exact: true })).toHaveValue('');
  await care.locator('input[type=file]').setInputFiles({ name: 'label.jpg', mimeType: 'image/jpeg', buffer: label });
  await expect(care.getByRole('status')).toHaveText('Read 3 instructions from the label. Check them, then save.');
  expect(wardrobe.scans).toHaveLength(1);
  expect(wardrobe.scans[0].imageDataUrl).toMatch(/^data:image\/jpeg;base64,/);
  expect(wardrobe.patches).toHaveLength(0);
  await expect(care.getByRole('combobox', { name: 'Washing', exact: true })).toHaveValue('machine-30-gentle');
  await expect(care.getByRole('combobox', { name: 'Ironing', exact: true })).toHaveValue('low');
  await expect(care.getByRole('textbox', { name: 'Care notes', exact: true })).toHaveValue('Wash inside out');
  // Unsaved care blocks closing like any other edit.
  await dialog.getByRole('button', { name: 'Close viewer', exact: true }).click();
  await expect(dialog.getByText('Save or discard changes before closing.', { exact: true })).toBeVisible();
  await care.getByRole('combobox', { name: 'Tumble drying', exact: true }).selectOption('no');
  await expect(care.locator('summary')).toContainText('Wash at 30°C, gentle · Do not bleach · Do not tumble dry · Iron cool, no steam');
  await care.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('care-label-scanned.png') });
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog.getByText('Changes saved.', { exact: true })).toBeVisible();
  expect(wardrobe.patches[0].changes.care).toEqual({ wash: 'machine-30-gentle', bleach: 'no', iron: 'low', notes: 'Wash inside out', tumble: 'no' });
  await page.reload();
  const reopened = await open(page, 'Navy blouse');
  await expect(reopened.care.locator('summary')).toContainText('Wash at 30°C, gentle');
});

test('care label: manual entry, unreadable scan and clearing', async ({ page, wardrobe }, info) => {
  const { dialog, care } = await open(page, 'Wool jumper');
  await expect(care.locator('summary')).toContainText('Hand wash only · Dry flat');
  await care.locator('summary').click();
  wardrobe.scanReply = { status: 422, json: { error: 'No care instructions could be read. Try a closer, sharper photo of the label in good light.' } };
  await care.locator('input[type=file]').setInputFiles({ name: 'blurry.jpg', mimeType: 'image/jpeg', buffer: label });
  await expect(care.getByRole('alert')).toContainText('closer, sharper photo');
  await expect(care.getByRole('combobox', { name: 'Washing', exact: true })).toHaveValue('hand');
  await expect(dialog.getByRole('button', { name: 'Discard changes', exact: true })).toHaveCount(0);
  await care.getByRole('combobox', { name: 'Ironing', exact: true }).selectOption('no');
  await care.getByRole('textbox', { name: 'Care notes', exact: true }).fill('Reshape while damp');
  await care.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('care-label-manual.png') });
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog.getByText('Changes saved.', { exact: true })).toBeVisible();
  expect(wardrobe.patches.at(-1).changes.care).toEqual({ wash: 'hand', dry: 'flat', iron: 'no', notes: 'Reshape while damp' });
  await care.getByRole('button', { name: 'Clear care label', exact: true }).click();
  await expect(care.locator('summary')).toContainText('Not added');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog.getByText('Changes saved.', { exact: true })).toBeVisible();
  expect(wardrobe.patches.at(-1).changes.care).toBeNull();
  expect(wardrobe.items.find(item => item.id === 'wool').care).toBeUndefined();
});
