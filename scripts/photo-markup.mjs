import sharp from "sharp";

const MARKUP_BYTES = 2 * 1024 * 1024;
const MAX_PIXELS = 16_777_216;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

// The API needs a transparent PNG exactly the size of the photo it annotates,
// after orientation. The browser may have drawn over a smaller display copy,
// so scale the layer here and reject anything that cannot be the same picture.
export async function prepareMarkup(dataUrl, photo) {
  const encoded = typeof dataUrl === "string" && dataUrl.match(/^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/)?.[1];
  if (!encoded) throw fail("Marks must be a transparent PNG.");
  if (encoded.length > Math.ceil(MARKUP_BYTES / 3) * 4) throw fail("The marks must be 2 MB or smaller.", 413);
  try {
    const markup = await sharp(Buffer.from(encoded, "base64"), { limitInputPixels: 64e6 }).metadata();
    if (markup.format !== "png" || (markup.pages || 1) !== 1 || !markup.hasAlpha) throw fail("Marks must be a transparent PNG.");
    const base = await sharp(photo, { limitInputPixels: 64e6 }).metadata();
    const rotated = base.orientation >= 5 && base.orientation <= 8;
    const width = rotated ? base.height : base.width;
    const height = rotated ? base.width : base.height;
    if (width * height > MAX_PIXELS) throw fail("This photo is too large to mark.");
    if (Math.abs(markup.width / markup.height - width / height) > 0.02 * (width / height)) throw fail("The marks don't match this photo. Mark it again.");
    const { data } = await sharp(Buffer.from(encoded, "base64"), { limitInputPixels: 64e6 }).resize(width, height, { fit: "fill" }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let visible = 0, clear = 0;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] >= 128) visible++;
      if (data[i] === 0) clear++;
    }
    if (visible < 16) throw fail("Mark the area you want to change.");
    if (clear < width * height * 0.05) throw fail("Leave part of the photo unmarked.");
    return await sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer();
  } catch (error) {
    if (error.status) throw error;
    throw fail("These marks could not be read. Mark the photo again.");
  }
}
