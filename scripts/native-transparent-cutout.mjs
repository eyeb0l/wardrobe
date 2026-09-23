import sharp from "sharp";

export const NATIVE_TRANSPARENCY_RECIPE = "native-transparent-opaque-interior-v1";

function invalidCutout(message) {
  return Object.assign(new Error(message), { code: "EINVALIDCUTOUT" });
}

// The image API has returned otherwise opaque fabric at alpha 253–254. Only
// correct pixels safely inside an already near-opaque region; leave every
// boundary, opening, sheer detail, and RGB value exactly as the model made it.
export async function normalizeGeneratedTransparency(bytes) {
  const metadata = await sharp(bytes).metadata();
  if (metadata.format !== "png" || !metadata.hasAlpha) {
    throw invalidCutout("The generated cutout has no transparent PNG background. The raw result was saved; regenerate the garment for review.");
  }
  const { data: before, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const after = Buffer.from(before);
  let transparentPixels = 0;
  let visiblePixels = 0;
  let correctedPixels = 0;
  for (let i = 3; i < before.length; i += 4) {
    if (before[i] <= 8) transparentPixels++;
    if (before[i] >= 128) visiblePixels++;
  }
  const area = width * height;
  if (transparentPixels < area * 0.01 || visiblePixels < area * 0.001) {
    throw invalidCutout("The generated cutout has no usable transparent background or visible garment. The raw result was saved; regenerate it for review.");
  }

  for (let y = 2; y < height - 2; y++) {
    for (let x = 2; x < width - 2; x++) {
      const alpha = (y * width + x) * 4 + 3;
      if (before[alpha] < 250 || before[alpha] === 255) continue;
      let interior = true;
      for (let dy = -2; dy <= 2 && interior; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          if (before[((y + dy) * width + x + dx) * 4 + 3] < 250) {
            interior = false;
            break;
          }
        }
      }
      if (interior) { after[alpha] = 255; correctedPixels++; }
    }
  }
  return {
    bytes: await sharp(after, { raw: { width, height, channels: 4 } }).png().toBuffer(),
    diagnostics: { width, height, transparentPixels, visiblePixels, correctedPixels },
  };
}
