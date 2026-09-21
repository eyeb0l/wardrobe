import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { processChromaBackground, removeChromaBackground, frameTransparentGarment } from './import-job-api.mjs';

const size = 96;
const rgb = (hex) => [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
async function raster(pixel, dimension = size) {
  const data = Buffer.alloc(dimension * dimension * 4);
  for (let y = 0; y < dimension; y += 1) for (let x = 0; x < dimension; x += 1) data.set(pixel(x, y), 4 * (y * dimension + x));
  return sharp(data, { raw: { width: dimension, height: dimension, channels: 4 } }).png().toBuffer();
}
async function pixels(bytes) { return sharp(bytes).ensureAlpha().raw().toBuffer(); }
async function sameFramed(actual, expected, tolerance = 0) {
  const a = await pixels(actual);
  const b = await pixels(await frameTransparentGarment(expected));
  assert.equal(a.length, b.length);
  let worst = 0;
  // RGB in fully transparent pixels is irrelevant. Compare visible RGB and all alpha.
  for (let i = 0; i < a.length; i += 4) {
    worst = Math.max(worst, Math.abs(a[i + 3] - b[i + 3]));
    if (a[i + 3] > 8 && b[i + 3] > 8) for (let c = 0; c < 3; c += 1) {
      const difference = tolerance === 0 ? Math.abs(a[i + c] - b[i + c]) : Math.abs(a[i + c] * a[i + 3] / 255 - b[i + c] * b[i + 3] / 255);
      worst = Math.max(worst, difference);
    }
  }
  assert.ok(worst <= tolerance, `Largest visible channel difference ${worst} exceeds ${tolerance}`);
}

for (const [key, color] of [['#00ffff', [30, 52, 69]], ['#00ff00', [30, 69, 52]], ['#ff00ff', [69, 30, 52]]]) {
  test(`no key background: ${key} preserves legitimate opaque channel dominance`, async () => {
    const source = await raster(() => [...color, 255]);
    const result = await processChromaBackground(source, key);
    await sameFramed(result.bytes, source);
    const output = await pixels(result.bytes);
    assert.deepEqual([...output.subarray(4 * (512 * 1024 + 512), 4 * (512 * 1024 + 512) + 4)], [...color, 255]);
    assert.deepEqual(result.verification, { contaminatedPixels: 0, maxSpill: 0 });
  });

  test(`${key}: opaque interior next to key and enclosed handle hole retain original color`, async () => {
    const shape = (x, y) => x >= 16 && x < 80 && y >= 16 && y < 80 && !(x >= 32 && x < 64 && y >= 32 && y < 64);
    const source = await raster((x, y) => shape(x, y) ? [...color, 255] : [...rgb(key), 255]);
    const expected = await raster((x, y) => shape(x, y) ? [...color, 255] : [0, 0, 0, 0]);
    const result = await processChromaBackground(source, key);
    await sameFramed(result.bytes, expected);
    assert.equal(result.verification.contaminatedPixels, 0);
    const output = await pixels(result.bytes);
    assert.equal(output[4 * (512 * 1024 + 512) + 3], 0, 'enclosed handle opening is transparent');
  });

  test(`${key}: two-pixel antialiased edge is unmixed against nearby foreground`, async () => {
    const background = rgb(key);
    const coverage = (x, y) => {
      const depth = Math.min(x - 19, 76 - x, y - 19, 76 - y);
      return depth <= 0 ? 0 : depth === 1 ? 0.35 : depth === 2 ? 0.7 : 1;
    };
    const source = await raster((x, y) => [...color.map((value, c) => Math.round(value * coverage(x, y) + background[c] * (1 - coverage(x, y)))), 255]);
    const expected = await raster((x, y) => [...color, Math.round(255 * coverage(x, y))]);
    const result = await processChromaBackground(source, key);
    // Quantized input blending followed by alpha-aware resizing can differ by
    // a few RGB levels at very faint edge pixels. Compare premultiplied RGB
    // (the visible contribution) and alpha; opaque interiors remain exact.
    await sameFramed(result.bytes, expected, 4);
    assert.equal(result.verification.contaminatedPixels, 0);
  });
}

test('existing transparent cutout keeps opaque key-colored details and partial alpha', async () => {
  const source = await raster((x, y) => {
    if (x < 15 || x > 80 || y < 15 || y > 80) return [0, 0, 0, 0];
    if (x < 30) return [0, 255, 255, 255];
    if (x > 65) return [30, 52, 69, 128];
    return [30, 52, 69, 255];
  });
  const result = await processChromaBackground(source, '#00ffff');
  await sameFramed(result.bytes, source);
  assert.equal(result.verification.contaminatedPixels, 0);
});

test('partially transparent garment pixels are preserved even with an opaque keyed exterior', async () => {
  const shape = (x, y) => x >= 20 && x < 76 && y >= 20 && y < 76;
  const source = await raster((x, y) => shape(x, y) ? [30, 52, 69, 128] : [0, 255, 255, 255]);
  const expected = await raster((x, y) => shape(x, y) ? [30, 52, 69, 128] : [0, 0, 0, 0]);
  const result = await processChromaBackground(source, '#00ffff');
  await sameFramed(result.bytes, expected);
  assert.equal(result.verification.contaminatedPixels, 0);
});

test('near-key foreground patch is not erased or neutralized', async () => {
  const shape = (x, y) => x >= 16 && x < 80 && y >= 16 && y < 80;
  const color = (x, y) => x >= 32 && x < 64 && y >= 32 && y < 64 ? [5, 240, 235, 255] : [30, 52, 69, 255];
  const source = await raster((x, y) => shape(x, y) ? color(x, y) : [0, 255, 255, 255]);
  const expected = await raster((x, y) => shape(x, y) ? color(x, y) : [0, 0, 0, 0]);
  const result = await processChromaBackground(source, '#00ffff');
  await sameFramed(result.bytes, expected);
  assert.equal(result.verification.contaminatedPixels, 0);
});

test('ambiguous near-key edge is preserved and strict cleanup requires review', async () => {
  const shape = (x, y) => x >= 20 && x < 76 && y >= 20 && y < 76;
  const source = await raster((x, y) => shape(x, y) ? [5, 240, 235, 255] : [0, 255, 255, 255]);
  const expected = await raster((x, y) => shape(x, y) ? [5, 240, 235, 255] : [0, 0, 0, 0]);
  const result = await processChromaBackground(source, '#00ffff');
  await sameFramed(result.bytes, expected);
  assert.ok(result.verification.contaminatedPixels > 1);
  await assert.rejects(removeChromaBackground(source, '#00ffff'), /chroma-contaminated/);
  await sameFramed(await removeChromaBackground(source, '#00ffff', { strict: false }), expected);
});

test('all-key and fully transparent images cannot become empty accepted garments', async () => {
  await assert.rejects(removeChromaBackground(await raster(() => [0, 255, 255, 255]), '#00ffff'), /visible garment/);
  await assert.rejects(removeChromaBackground(await raster(() => [0, 0, 0, 0]), '#00ffff'), /visible garment/);
});

test('antialiased enclosed handle opening uses surrounding garment color, not channel neutralization', async () => {
  const color = [30, 52, 69];
  const background = [0, 255, 255];
  const coverage = (x, y) => {
    if (x < 16 || x >= 80 || y < 16 || y >= 80) return 0;
    const distance = Math.max(32 - x, x - 63, 32 - y, y - 63, 0);
    return distance === 0 ? 0 : distance === 1 ? 0.35 : distance === 2 ? 0.7 : 1;
  };
  const source = await raster((x, y) => [...color.map((value, c) => Math.round(value * coverage(x, y) + background[c] * (1 - coverage(x, y)))), 255]);
  const expected = await raster((x, y) => [...color, Math.round(255 * coverage(x, y))]);
  const result = await processChromaBackground(source, '#00ffff');
  await sameFramed(result.bytes, expected, 4);
  assert.equal(result.verification.contaminatedPixels, 0);
});

test('soft textured product edges clean without changing the opaque textured body', async () => {
  const background = [0, 255, 255];
  const coverage = (x, y) => Math.max(0, Math.min(1, Math.min(x - 79, 560 - x, y - 59, 580 - y) / 4));
  const color = (x, y) => { const texture = (x * 13 + y * 7) % 71; return [90 + texture, 60 + texture, 50 + texture]; };
  const source = await raster((x, y) => [...color(x, y).map((value, c) => Math.round(value * coverage(x, y) + background[c] * (1 - coverage(x, y)))), 255], 640);
  const expected = await raster((x, y) => [...color(x, y), Math.round(coverage(x, y) * 255)], 640);
  const result = await processChromaBackground(source, '#00ffff');
  assert.equal(result.verification.contaminatedPixels, 0);
  const actualPixels = await pixels(result.bytes);
  const expectedPixels = await pixels(await frameTransparentGarment(expected));
  for (let y = 256; y < 768; y += 1) for (let x = 256; x < 768; x += 1) {
    const i = 4 * (y * 1024 + x);
    assert.deepEqual(actualPixels.subarray(i, i + 4), expectedPixels.subarray(i, i + 4), 'opaque interior texture and alpha are preserved');
  }
  let error = 0;
  for (let i = 0; i < actualPixels.length; i += 4) for (let c = 0; c < 3; c += 1) {
    error += Math.abs(actualPixels[i + c] * actualPixels[i + 3] / 255 - expectedPixels[i + c] * expectedPixels[i + 3] / 255);
  }
  assert.ok(error / (1024 * 1024 * 3) < 1, 'whole-image premultiplied RGB error stays below one level per channel');
});

test('distinct opaque border color is preserved beside a differently colored interior', async () => {
  const shape = (x, y) => x >= 16 && x < 80 && y >= 16 && y < 80;
  const color = (x, y) => Math.min(x - 16, 79 - x, y - 16, 79 - y) < 2 ? [75, 100, 130, 255] : [30, 52, 69, 255];
  const source = await raster((x, y) => shape(x, y) ? color(x, y) : [0, 255, 255, 255]);
  const expected = await raster((x, y) => shape(x, y) ? color(x, y) : [0, 0, 0, 0]);
  const result = await processChromaBackground(source, '#00ffff');
  await sameFramed(result.bytes, expected);
  assert.equal(result.verification.contaminatedPixels, 0);
});

test('opaque edge gradient is not made translucent merely because a darker anchor fits', async () => {
  const shape = (x, y) => x >= 16 && x < 80 && y >= 16 && y < 80;
  const color = (x, y) => {
    const depth = Math.min(x - 16, 79 - x, y - 16, 79 - y);
    return depth === 0 ? [35, 70, 90, 255] : depth === 1 ? [33, 61, 80, 255] : [30, 52, 69, 255];
  };
  const source = await raster((x, y) => shape(x, y) ? color(x, y) : [0, 255, 255, 255]);
  const expected = await raster((x, y) => shape(x, y) ? color(x, y) : [0, 0, 0, 0]);
  const result = await processChromaBackground(source, '#00ffff');
  await sameFramed(result.bytes, expected);
  assert.equal(result.verification.contaminatedPixels, 0);
});

test('transparent exterior protects key-colored garment touching the canvas border', async () => {
  const source = await raster((x, y) => {
    if (x > 71 || y < 12 || y > 83) return [0, 0, 0, 0];
    return x < 24 ? [0, 255, 255, 255] : [30, 52, 69, 255];
  });
  const result = await processChromaBackground(source, '#00ffff');
  await sameFramed(result.bytes, source);
  assert.deepEqual(result.verification, { contaminatedPixels: 0, maxSpill: 0 });
});

for (const key of ['#ff00ff', '#00ffff', '#00ff00']) {
  test(`${key}: noisy bright edge blends are cleaned automatically without changing the body`, async () => {
    const background = rgb(key);
    const color = [28, 32, 30];
    const source = await raster((x, y) => {
      const depth = Math.min(x - 19, 76 - x, y - 19, 76 - y);
      if (depth <= 0) return [...background, 255];
      if (depth > 2) return [...color, 255];
      const alpha = depth === 1 ? 0.2 : 0.55;
      return [...color.map((v, c) => Math.min(255, Math.round(v * alpha + background[c] * (1 - alpha) + 45))), 255];
    });
    const result = await processChromaBackground(source, key);
    assert.equal(result.verification.contaminatedPixels, 0);
    const output = await pixels(result.bytes);
    let visible = 0;
    for (let i = 0; i < output.length; i += 4) {
      if (output[i + 3] <= 8) continue;
      visible++;
      assert.ok((Math.max(...output.subarray(i, i + 3)) - Math.min(...output.subarray(i, i + 3))) * output[i + 3] / 255 < 12, `no visible saturated edge remains: ${[...output.subarray(i, i + 4)]}`);
    }
    assert.ok(visible > 1000);
    assert.deepEqual([...output.subarray(4 * (512 * 1024 + 512), 4 * (512 * 1024 + 512) + 4)], [...color, 255]);
  });
}

test('isolated near-key dust is removed while detached contrasting details survive', async () => {
  const source = await raster((x, y) => {
    if (x >= 20 && x < 76 && y >= 20 && y < 76) return [25, 25, 25, 255];
    if (x === 8 && y === 8) return [247, 18, 247, 255];
    if (x === 84 && y === 84) return [240, 220, 30, 255];
    return [255, 0, 255, 255];
  });
  const expected = await raster((x, y) => {
    if (x >= 20 && x < 76 && y >= 20 && y < 76) return [25, 25, 25, 255];
    if (x === 84 && y === 84) return [240, 220, 30, 255];
    return [0, 0, 0, 0];
  });
  await sameFramed((await processChromaBackground(source, '#ff00ff')).bytes, expected);
});
