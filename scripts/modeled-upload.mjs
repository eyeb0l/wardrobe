import sharp from "sharp";
import { MODELED_UPLOAD_BYTES, modeledDimensionError } from "../shared/modeled-upload.mjs";

const fail = (message, status = 400) => Object.assign(new Error(message), { status });

export async function normalizeModeledUpload(input, kind) {
  const match = typeof input?.imageDataUrl === "string" && input.imageDataUrl.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) throw fail("Choose a JPEG, PNG or WebP photo. HEIC photos must be converted before upload.");
  if (match[2].length > Math.ceil(MODELED_UPLOAD_BYTES / 3) * 4) throw fail("The prepared photo must be 2 MB or smaller.", 413);
  const bytes = Buffer.from(match[2], "base64");
  if (!bytes.length || bytes.length > MODELED_UPLOAD_BYTES) throw fail("The prepared photo must be 2 MB or smaller.", 413);
  try {
    const image = sharp(bytes, { limitInputPixels: 64e6, failOn: "warning" });
    const metadata = await image.metadata();
    if (!["png", "jpeg", "webp"].includes(metadata.format) || (metadata.pages || 1) !== 1) throw fail("Choose a single-frame JPEG, PNG or WebP photo.");
    // EXIF orientations 5–8 exchange the displayed width and height.
    const rotated = metadata.orientation >= 5 && metadata.orientation <= 8;
    const width = rotated ? metadata.height : metadata.width;
    const height = rotated ? metadata.width : metadata.height;
    const error = modeledDimensionError(width, height, kind);
    if (error) throw fail(error);
    // Fully decode before saving; strip metadata and retain full prepared resolution.
    return await image.rotate().toColorspace("srgb").png().toBuffer();
  } catch (error) {
    if (error.status) throw error;
    throw fail("This photo could not be read. Choose a valid image up to 64 megapixels.");
  }
}
