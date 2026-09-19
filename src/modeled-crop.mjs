const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

// Source coordinates and output dimensions share one ratio, without stretching
// or upscaling. Integer multiples also prevent near-3:2 files being rejected.
export function modeledCrop(width, height, kind, { zoom = 1, x = 0.5, y = 0.5 } = {}) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || width * height > 64e6) throw new Error("Choose a valid photo up to 64 megapixels.");
  const [unitX, unitY] = kind === "outfit" ? [1, 1] : [3, 2];
  const minimum = kind === "outfit" ? 512 : 256;
  const units = Math.min(width / unitX, height / unitY);
  if (units < minimum) throw new Error(kind === "outfit" ? "This photo is too small. Choose one at least 512 × 512 pixels." : "This photo is too small. Choose one at least 768 pixels wide and 512 pixels tall.");
  const maxZoom = Math.min(4, units / minimum);
  const scale = clamp(Number.isFinite(zoom) ? zoom : 1, 1, maxZoom);
  const cropWidth = units * unitX / scale;
  const cropHeight = units * unitY / scale;
  const outputUnits = Math.max(minimum, Math.floor(Math.min(units / scale, 2400 / Math.max(unitX, unitY)) + 1e-8));
  return {
    x: clamp(Number.isFinite(x) ? x : 0.5, 0, 1) * (width - cropWidth),
    y: clamp(Number.isFinite(y) ? y : 0.5, 0, 1) * (height - cropHeight),
    width: cropWidth, height: cropHeight, maxZoom,
    outputWidth: outputUnits * unitX, outputHeight: outputUnits * unitY,
  };
}
