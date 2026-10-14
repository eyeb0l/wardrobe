import { test as base, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import sharp from 'sharp';

const artwork = async (color, dress = false) => `data:image/png;base64,${(await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="300" height="360"><path d="${dress ? 'M115 45 L185 45 L190 125 L260 320 L40 320 L110 125 Z' : 'M100 55 L125 40 L175 40 L200 55 L260 115 L220 160 L200 140 L200 290 L100 290 L100 140 L80 160 L40 115 Z'}" fill="${color}"/></svg>`)).png().toBuffer()).toString('base64')}`;
const fixtures = await Promise.all([
  ['a', 'Blue top', 'upperbody', '#567586'], ['b', 'Rose top', 'upperbody', '#b77b81'],
  ['c', 'Cream top', 'upperbody', '#c9b799'], ['d', 'Green dress', 'dresses', '#3c5b46'],
  ['e', 'Plum dress', 'dresses', '#6c4561'],
].map(async ([id, name, part, color]) => ({ id, name, part, color, tags: [], revision: id, image: await artwork(color, part === 'dresses') })));

const test = base.extend({
  wardrobe: async ({ page }, use, testInfo) => {
    const state = { items: structuredClone(fixtures), moves: [], fail: false };
    const health = { errors: [], failedRequests: [], httpErrors: [] };
    page.on('pageerror', error => health.errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error' && !message.text().includes('409 (Conflict)')) health.errors.push(message.text()); });
    page.on('requestfailed', request => { if (!request.failure()?.errorText.includes('ERR_ABORTED')) health.failedRequests.push(request.url()); });
    page.on('response', response => { if (response.status() >= 400 && response.status() !== 409) health.httpErrors.push(response.url()); });
    await page.addInitScript(() => localStorage.setItem('wardrobe:welcome:v1', 'complete'));
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/import/wardrobe') return route.fulfill({ json: state.items });
      if (path === '/api/import/jobs') return route.fulfill({ json: [] });
      if (path === '/api/import/config') return route.fulfill({ json: { ready: true, hasApiKey: true, hasModelReference: true, modelReferences: [] } });
      if (path === '/api/import/wardrobe/reorder') {
        const move = route.request().postDataJSON();
        state.moves.push(move);
        if (state.fail) return route.fulfill({ status: 409, json: { error: 'This category changed on another device. Refresh the wardrobe and try again.' } });
        state.items = state.items.map(item => move.ids.includes(item.id) ? { ...item, sortOrder: move.ids.indexOf(item.id) } : item);
        return route.fulfill({ json: state.items });
      }
      health.errors.push(`Unexpected API ${path}`);
      return route.fulfill({ status: 500, json: {} });
    });
    await page.goto('/');
    await expect(page).toHaveTitle('Open Wardrobe');
    await expect(page.locator('.gallery-item')).toHaveCount(5);
    await expect(page.locator('vite-error-overlay')).toHaveCount(0);
    await use(state);
    const file = testInfo.outputPath('browser-health.json');
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(health, null, 2));
    expect(health).toEqual({ errors: [], failedRequests: [], httpErrors: [] });
  },
});
const order = page => page.locator('.gallery-item').evaluateAll(elements => elements.map(element => element.dataset.testid.replace('wardrobe-item-', '')));
async function drag(page, from, to) {
  const source = await page.getByRole('button', { name: `Rearrange ${from}`, exact: true }).boundingBox();
  const target = await page.getByRole('button', { name: `Rearrange ${to}`, exact: true }).boundingBox();
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 10 });
  await page.mouse.up();
}

test('reorders within categories, persists on reload and keeps filtering and normal viewing', async ({ page, wardrobe, isMobile }, testInfo) => {
  await page.getByRole('button', { name: 'Rearrange', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Move Blue top earlier', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Move Cream top later', exact: true })).toBeDisabled();
  if (isMobile) await page.getByRole('button', { name: 'Move Rose top earlier', exact: true }).tap();
  else await drag(page, 'Rose top', 'Blue top');
  await expect.poll(() => order(page)).toEqual(['b', 'a', 'c', 'd', 'e']);
  await expect(page.getByText(/Order saved/)).toBeVisible();
  await page.getByRole('button', { name: 'Rearrange Rose top', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => order(page)).toEqual(['a', 'b', 'c', 'd', 'e']);
  const moves = wardrobe.moves.length;
  await drag(page, 'Green dress', 'Blue top');
  expect(wardrobe.moves).toHaveLength(moves);
  expect(await order(page)).toEqual(['a', 'b', 'c', 'd', 'e']);
  await page.getByRole('button', { name: 'Move Rose top earlier', exact: true }).click();
  await expect.poll(() => order(page)).toEqual(['b', 'a', 'c', 'd', 'e']);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.screenshot({ path: testInfo.outputPath('wardrobe-rearrange.png'), fullPage: true });
  await page.getByRole('button', { name: 'Tops', exact: true }).click();
  await expect.poll(() => order(page)).toEqual(['b', 'a', 'c']);
  await page.reload();
  await expect.poll(() => order(page)).toEqual(['b', 'a', 'c', 'd', 'e']);
  await page.getByRole('button', { name: 'View Rose top', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Selected wardrobe item' })).toBeVisible();
  await page.getByRole('button', { name: 'Close viewer', exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath('wardrobe-saved-order.png'), fullPage: true });
});

test('failed saves keep the previous order and allow retry', async ({ page, wardrobe }) => {
  wardrobe.fail = true;
  await page.getByRole('button', { name: 'Rearrange', exact: true }).click();
  await page.getByRole('button', { name: 'Move Blue top later', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('changed on another device');
  expect(await order(page)).toEqual(['a', 'b', 'c', 'd', 'e']);
  wardrobe.fail = false;
  await page.getByRole('button', { name: 'Move Blue top later', exact: true }).click();
  await expect.poll(() => order(page)).toEqual(['b', 'a', 'c', 'd', 'e']);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('direct pointer dragging supports touch and canceling a move', async ({ page, wardrobe, isMobile }) => {
  await page.getByRole('button', { name: 'Rearrange', exact: true }).click();
  const source = await page.getByRole('button', { name: 'Rearrange Rose top', exact: true }).boundingBox();
  const target = await page.getByRole('button', { name: 'Rearrange Blue top', exact: true }).boundingBox();
  const from = { x: source.x + source.width / 2, y: source.y + source.height / 2 };
  const to = { x: target.x + target.width / 2, y: target.y + target.height / 2 };
  if (isMobile) {
    const session = await page.context().newCDPSession(page);
    const point = (x, y) => ({ x, y, id: 1 });
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point(from.x, from.y)] });
    for (let step = 1; step <= 8; step++) {
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point(from.x + (to.x - from.x) * step / 8, from.y)] });
    }
    await expect(page.locator('[data-reorder-id="a"]')).toHaveClass(/is-drop-target/);
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(() => order(page)).toEqual(['b', 'a', 'c', 'd', 'e']);
    expect(wardrobe.moves).toHaveLength(1);
    await session.detach();
  } else {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await expect(page.locator('[data-reorder-id="a"]')).toHaveClass(/is-drop-target/);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    expect(wardrobe.moves).toHaveLength(0);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await page.mouse.move(from.x, from.y, { steps: 8 });
    await page.mouse.up();
    expect(wardrobe.moves).toHaveLength(0);
    expect(await order(page)).toEqual(['a', 'b', 'c', 'd', 'e']);
  }
});
