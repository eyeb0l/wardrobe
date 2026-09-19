export const MODELED_UPLOAD_BYTES = 2 * 1024 * 1024;
export const MODELED_UPLOAD_BODY_BYTES = 3 * 1024 * 1024;

export function modeledDimensionError(width, height, kind) {
  if (!width || !height || width * height > 64e6) return "Use an image up to 64 megapixels.";
  if (kind === "outfit") {
    if (width !== height || width < 512) return "Choose a square outfit photo at least 512 × 512 pixels (1024 × 1024 recommended).";
  } else if (width < 768 || height < 512 || Math.abs(width - height * 1.5) > 1) {
    return "Choose a horizontal 3:2 modeled photo at least 768 × 512 pixels (1536 × 1024 recommended).";
  }
  return null;
}
