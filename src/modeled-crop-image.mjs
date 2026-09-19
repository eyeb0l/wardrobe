import { dataUrl, decodeUploadImage, encode, MAX_UPLOAD_BYTES } from "./image-upload.mjs";
import { modeledCrop } from "./modeled-crop.mjs";

export async function loadCropPhoto(file, kind) {
  const decoded = await decodeUploadImage(file);
  const canvas = document.createElement("canvas");
  try {
    modeledCrop(decoded.width, decoded.height, kind);
    const scale = Math.min(1, 1600 / Math.max(decoded.width, decoded.height));
    canvas.width = Math.round(decoded.width * scale);
    canvas.height = Math.round(decoded.height * scale);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Photo cropping is unavailable in this browser.");
    context.drawImage(decoded.source, 0, 0, canvas.width, canvas.height);
    const url = URL.createObjectURL(await encode(canvas, "image/webp", .9));
    return { ...decoded, url, close: () => { decoded.close(); URL.revokeObjectURL(url); } };
  } catch (error) { decoded.close(); throw error; }
  finally { canvas.width = canvas.height = 1; }
}

export async function encodeModeledCrop(photo, kind, framing) {
  const crop = modeledCrop(photo.width, photo.height, kind, framing);
  const canvas = document.createElement("canvas");
  const unitX = kind === "outfit" ? 1 : 3;
  const unitY = kind === "outfit" ? 1 : 2;
  const minimumUnits = kind === "outfit" ? 512 : 256;
  let units = crop.outputWidth / unitX;
  try {
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Photo cropping is unavailable in this browser.");
    while (true) {
      canvas.width = units * unitX; canvas.height = units * unitY;
      context.drawImage(photo.source, crop.x, crop.y, crop.width, crop.height, 0, 0, canvas.width, canvas.height);
      for (const quality of [.94, .88, .76, .64]) {
        const blob = await encode(canvas, "image/webp", quality);
        if (blob.size <= MAX_UPLOAD_BYTES) return { imageDataUrl: await dataUrl(blob) };
      }
      if (units === minimumUnits) throw new Error("This crop could not be compressed enough. Try a different photo.");
      units = Math.max(minimumUnits, Math.floor(units * .8));
    }
  } finally { canvas.width = canvas.height = 1; }
}
