// Small supported uploads keep their exact bytes; conversion and compression happen locally.
export const MAX_INPUT_BYTES = 50 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
export const IMAGE_ACCEPT = "image/jpeg,image/png,image/webp,image/heic,image/heif,.jpg,.jpeg,.png,.webp,.heic,.heif";
export function isImageUpload(file) {
  return file.type?.startsWith("image/") || /\.(?:jpe?g|png|webp|heic|heif)$/i.test(file.name || "");
}
const MAX_PIXELS = 64_000_000;

export function formatImageBytes(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function imageKind(bytes) {
  const ascii = (start, end) => String.fromCharCode(...bytes.slice(start, end));
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (ascii(1, 4) === "PNG" && bytes[0] === 0x89) return "image/png";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (ascii(4, 8) === "ftyp") {
    const brands = [ascii(8, 12)];
    for (let i = 16; i + 4 <= bytes.length; i += 4) brands.push(ascii(i, i + 4));
    if (brands.some((brand) => ["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"].includes(brand)) && !brands.includes("avif")) return "image/heic";
  }
  throw new Error("Choose a JPEG, PNG, WebP or HEIC photo.");
}

async function nativeImage(blob) {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
    } catch { /* Safari may support a format through an image element instead. */ }
  }
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return { source: image, width: image.naturalWidth, height: image.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

async function decodeImage(file, kind) {
  try { return await nativeImage(file); }
  catch {
    if (kind !== "image/heic") throw new Error("This photo couldn’t be read. Try another photo or a screenshot.");
    try {
      // The HEIC decoder and its worker load only when native decoding fails.
      const { heicTo } = await import("heic-to/csp");
      const bitmap = await heicTo({ blob: file, type: "bitmap" });
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
    } catch {
      throw new Error("This HEIC photo couldn’t be converted. Try a JPEG export or a screenshot.");
    }
  }
}

function encode(canvas, mime, quality) {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("The photo couldn’t be prepared. Try another image.")), mime, quality));
}

function dataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("The photo couldn’t be read. Please choose it again."));
    reader.readAsDataURL(blob);
  });
}

export async function prepareUploadImage(file, { preserveSmall = true, maxEdge = 2400 } = {}) {
  if (!(file instanceof Blob) || !file.size) throw new Error("Choose a photo first.");
  if (file.size > MAX_INPUT_BYTES) throw new Error("Choose a photo smaller than 50 MB, or take a screenshot of it.");
  const kind = imageKind(new Uint8Array(await file.slice(0, 80).arrayBuffer()));
  const decoded = await decodeImage(file.slice(0, file.size, kind), kind);
  const canvas = document.createElement("canvas");
  try {
    if (!decoded.width || !decoded.height || decoded.width * decoded.height > MAX_PIXELS) throw new Error("This photo is too large to prepare. Use a photo up to 64 megapixels or a screenshot.");
    const result = async (blob, width, height, compressed, converted) => ({
      blob, dataUrl: await dataUrl(blob), width, height, originalBytes: file.size,
      bytes: blob.size, name: file.name || "Photo", compressed, converted,
    });
    if (preserveSmall && kind !== "image/heic" && file.size <= MAX_UPLOAD_BYTES) {
      return await result(file.slice(0, file.size, kind), decoded.width, decoded.height, false, false);
    }
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Photo preparation isn’t available in this browser. Try another browser.");
    // WebP keeps transparent PNG/WebP cutouts transparent when reducing them.
    const mime = preserveSmall && ["image/png", "image/webp"].includes(kind) ? "image/webp" : "image/jpeg";
    const draw = (edge) => {
      const scale = Math.min(1, edge / Math.max(decoded.width, decoded.height));
      canvas.width = Math.max(1, Math.round(decoded.width * scale));
      canvas.height = Math.max(1, Math.round(decoded.height * scale));
      if (mime === "image/jpeg") {
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, canvas.width, canvas.height);
      }
      context.drawImage(decoded.source, 0, 0, canvas.width, canvas.height);
    };
    // HEIC needs conversion, but a small converted photo retains its resolution.
    if (preserveSmall && kind === "image/heic" && file.size <= MAX_UPLOAD_BYTES) {
      draw(Math.max(decoded.width, decoded.height));
      const converted = await encode(canvas, mime, .94);
      if (converted.size <= MAX_UPLOAD_BYTES) return await result(converted, canvas.width, canvas.height, false, true);
    }
    let edge = maxEdge;
    let blob;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      draw(edge);
      for (const quality of [.88, .76, .64]) {
        blob = await encode(canvas, mime, quality);
        if (blob.size <= MAX_UPLOAD_BYTES) break;
      }
      if (blob.size <= MAX_UPLOAD_BYTES) break;
      edge = Math.round(edge * .75);
    }
    if (blob.size > MAX_UPLOAD_BYTES) throw new Error("This photo couldn’t be made small enough. Try a screenshot.");
    return await result(blob, canvas.width, canvas.height, true, kind === "image/heic");
  } finally {
    decoded.close();
    canvas.width = canvas.height = 1;
  }
}
