import { test, expect } from '@playwright/test';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import sharp from 'sharp';

// Exercises the real import API against the isolated fixture data directory
// that playwright.config.mjs gives the dev server. No paid API is configured.
const photo = (width, height, background) => sharp({ create: { width, height, channels: 3, background } }).jpeg({ quality: 90 }).toBuffer();
const file = async (name, width, height, background) => ({ name, mimeType: 'image/jpeg', buffer: await photo(width, height, background) });
const pixel = async (path) => {
  const { data } = await sharp(path).resize(1, 1).raw().toBuffer({ resolveWithObject: true });
  return [...data.subarray(0, 3)];
};
const close = (actual, expected) => actual.every((value, index) => Math.abs(value - expected[index]) <= 6);

test('reference photos can be added, compared, replaced and extended from Setup & guide', async ({ page }, testInfo) => {
  const data = join(testInfo.project.outputDir, 'fixture-data');
  await mkdir(data, { recursive: true });
  for (const name of await readdir(data)) if (name.startsWith('model-reference')) await rm(join(data, name), { force: true });
  const health = { errors: [], failedRequests: [], httpErrors: [] };
  page.on('pageerror', error => health.errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') health.errors.push(message.text()); });
  page.on('requestfailed', request => { if (!request.failure()?.errorText.includes('ERR_ABORTED')) health.failedRequests.push(request.url()); });
  page.on('response', response => { if (response.status() >= 400) health.httpErrors.push(`${response.status()} ${response.url()}`); });
  const shot = (name) => page.screenshot({ path: testInfo.outputPath(`${name}-${testInfo.project.name}.png`), fullPage: true });
  const choose = async (button, upload) => {
    const chooser = page.waitForEvent('filechooser');
    await button.click();
    await (await chooser).setFiles(upload);
  };

  await page.goto('/');
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Explore first' }).click();
  const section = dialog.getByRole('region', { name: 'One photo before your first import' });
  await expect(section).toBeVisible();

  // A low-detail photo is rejected before anything is uploaded.
  await choose(section.getByRole('button', { name: 'Choose a photo' }), await file('tiny.jpg', 300, 400, '#aa5544'));
  await expect(section.getByRole('alert')).toHaveText(/at least 512 pixels/);

  await choose(section.getByRole('button', { name: 'Choose a photo' }), await file('me.jpg', 900, 1200, '#aa5544'));
  await expect(section.getByText('Use this photo as your default reference?')).toBeVisible();
  await section.getByRole('button', { name: 'Save photo' }).click();
  const references = dialog.getByRole('region', { name: 'Reference photos' });
  await expect(references.getByRole('status')).toHaveText('Default reference added.');
  expect(close(await pixel(join(data, 'model-reference.png')), [0xaa, 0x55, 0x44])).toBe(true);
  const thumbnail = references.getByRole('img', { name: 'Default reference', exact: true });
  await expect.poll(() => thumbnail.evaluate(image => image.complete && image.naturalWidth)).toBeGreaterThan(0);
  const firstSource = await thumbnail.getAttribute('src');

  // Replacing shows the current and new photo side by side; cancelling keeps the original.
  await choose(references.getByRole('button', { name: 'Replace Default reference' }), await file('new.jpg', 1000, 1000, '#3366aa'));
  await expect(references.getByRole('img', { name: 'Current Default reference' })).toBeVisible();
  await expect(references.getByRole('img', { name: 'New reference photo' })).toBeVisible();
  await expect.poll(() => references.getByRole('img', { name: 'New reference photo' }).evaluate(image => image.complete && image.naturalWidth)).toBeGreaterThan(0);
  await shot('reference-replace-confirm');
  await references.getByRole('button', { name: 'Cancel' }).click();
  expect(close(await pixel(join(data, 'model-reference.png')), [0xaa, 0x55, 0x44])).toBe(true);

  await choose(references.getByRole('button', { name: 'Replace Default reference' }), await file('new.jpg', 1000, 1000, '#3366aa'));
  await references.getByRole('button', { name: 'Replace photo' }).click();
  await expect(references.getByRole('status')).toHaveText('Default reference replaced. New imports and outfits will use this photo.');
  expect(close(await pixel(join(data, 'model-reference.png')), [0x33, 0x66, 0xaa])).toBe(true);
  await expect(thumbnail).not.toHaveAttribute('src', firstSource);
  await expect.poll(async () => close(await thumbnail.evaluate(image => {
    const canvas = Object.assign(document.createElement('canvas'), { width: 1, height: 1 });
    canvas.getContext('2d').drawImage(image, 0, 0, 1, 1);
    return [...canvas.getContext('2d').getImageData(0, 0, 1, 1).data.slice(0, 3)];
  }), [0x33, 0x66, 0xaa]), { message: 'the open page shows the new photo, not a cached copy' }).toBe(true);

  await choose(references.getByRole('button', { name: 'Add another photo' }), await file('second.jpg', 768, 1024, '#447744'));
  await references.getByRole('button', { name: 'Save photo' }).click();
  await expect(references.getByRole('status')).toHaveText('Reference 2 added.');
  await expect.poll(() => references.getByRole('img', { name: 'Reference 2 reference' }).evaluate(image => image.complete && image.naturalWidth)).toBeGreaterThan(0);
  expect(close(await pixel(join(data, 'model-reference-2.png')), [0x44, 0x77, 0x44])).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await shot('reference-photos-saved');

  const healthFile = testInfo.outputPath('browser-health.json');
  await mkdir(dirname(healthFile), { recursive: true });
  await writeFile(healthFile, JSON.stringify(health, null, 2));
  expect(health).toEqual({ errors: [], failedRequests: [], httpErrors: [] });
});
