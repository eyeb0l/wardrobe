import sharp from 'sharp';
import { productBackground } from '../shared/product-background.mjs';

const fail = message => Object.assign(new Error(message), { status: 400 });
export async function inspectProductBackground(bytes) {
  const { data, info } = await sharp(bytes, { limitInputPixels: 64e6 }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return productBackground(data, info.width, info.height);
}

// The browser sends only a mask. Color pixels always come from the stored
// original, never a generated replacement or a user-supplied substitute image.
export async function applyProductMask(original, maskDataUrl) {
  const match = typeof maskDataUrl === 'string' && maskDataUrl.match(/^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match || match[1].length > Math.ceil(2 * 1024 * 1024 / 3) * 4) throw fail('Choose a valid background mask smaller than 2 MB.');
  try {
    const { data, info } = await sharp(original, { limitInputPixels: 64e6 }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const bytes = Buffer.from(match[1], 'base64');
    const maskImage = sharp(bytes, { limitInputPixels: 4096 * 4096, failOn: 'warning' });
    const meta = await maskImage.metadata();
    if (meta.format !== 'png' || (meta.pages || 1) !== 1 || Math.abs(meta.width / meta.height - info.width / info.height) > .01) throw fail('The background mask does not match this image. Try removing the background again.');
    const mask = await maskImage.removeAlpha().greyscale().resize(info.width, info.height, { fit: 'fill' }).raw().toBuffer();
    let clear = 0, visible = 0;
    for (let p = 0; p < mask.length; p++) {
      data[p * 4 + 3] = Math.round(data[p * 4 + 3] * mask[p] / 255);
      if (data[p * 4 + 3] <= 8) clear++;
      if (data[p * 4 + 3] > 32) visible++;
    }
    if (clear / mask.length < .01 || visible / mask.length < .005) throw fail('Background removal could not separate the item. Try another product photo or choose Extract garment.');
    return await sharp(data, { raw: info }).png().toBuffer();
  } catch (error) {
    if (error.status) throw error;
    throw fail('The background mask could not be read. Try removing the background again.');
  }
}
