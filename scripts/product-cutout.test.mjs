import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { inspectProductBackground, applyProductMask } from './product-cutout.mjs';

async function fixture(background = '#fff') {
  const item = await sharp({ create: { width: 50, height: 65, channels: 4, background: '#293d52' } }).png().toBuffer();
  return sharp({ create: { width: 100, height: 120, channels: 4, background } }).composite([{ input: item, left: 25, top: 30 }]).png().toBuffer();
}
const transparent = { r: 0, g: 0, b: 0, alpha: 0 };
const url = bytes => `data:image/png;base64,${bytes.toString('base64')}`;

test('detects meaningful transparency, not just an alpha channel', async () => {
  assert.equal((await inspectProductBackground(await fixture(transparent))).transparent, true);
  assert.equal((await inspectProductBackground(await fixture())).transparent, false);
  for (const background of [transparent, '#ffffff', '#777777']) {
    const blank = await sharp({ create: { width: 100, height: 100, channels: 4, background } }).png().toBuffer();
    assert.deepEqual(await inspectProductBackground(blank), { transparent: false, plain: false });
  }
});
test('product backgrounds include uniform grey, off-white and black', async () => {
  for (const color of ['#eeeeea', '#777777', '#000000']) assert.equal((await inspectProductBackground(await fixture(color))).plain, true);
});
test('mask changes only alpha, preserving original colors and dimensions', async () => {
  const original = await fixture();
  const mask = await sharp(await fixture(transparent)).extractChannel(3).png().toBuffer();
  const out = await applyProductMask(original, url(mask));
  const before = await sharp(original).raw().toBuffer();
  const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, 100); assert.equal(info.height, 120);
  for (let i = 0; i < data.length; i += 4) assert.deepEqual(data.subarray(i, i + 3), before.subarray(i, i + 3));
  assert.equal(data[3], 0);
  assert.equal(data[(60 * 100 + 50) * 4 + 3], 255);
});
test('invalid, empty, solid, mismatched and oversized masks fail before saving', async () => {
  const original = await fixture();
  const blank = async (color, width = 100) => sharp({ create: { width, height: 120, channels: 3, background: color } }).png().toBuffer();
  for (const value of ['no mask', url(Buffer.from('not png')), url(await blank('#000')), url(await blank('#fff')), url(await blank('#fff', 80)), `data:image/png;base64,${'a'.repeat(3 * 1024 * 1024)}`]) {
    await assert.rejects(applyProductMask(original, value), error => error.status === 400);
  }
});
