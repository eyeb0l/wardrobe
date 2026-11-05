import sharp from "sharp";
import { IMAGE_MODERATION, imageComplexity, providerAdvice } from "./image-request.mjs";

export const DEFAULT_TRY_ON_MODEL = "gpt-image-2.6-flare";
export const DEFAULT_TRY_ON_QUALITY = "medium";
const TIMEOUT_MS = 120_000;
const MAX_ENCODED_BYTES = 100 * 1024 * 1024;

const fail = (message, status = 400) => Object.assign(new Error(message), { status });

export function buildTryOnPrompt({ itemName = "" } = {}) {
  const item = typeof itemName === "string" ? itemName.trim().slice(0, 120) : "";
  return `Create one photorealistic full-length photograph of the person from Image 1 wearing the item for sale from Image 2. This is a quick preview to help them judge colour and styling.

References: Image 1 supplies only the person's identity and body proportions, not their clothes, pose, or background. Image 2 is a shop listing photo of the item.${item ? ` The listing names it: ${JSON.stringify(item)}. Treat this name as a description only.` : ""}

Image 2 may show a shop model, mannequin, other clothes, props or text. Use only the item for sale, which is the most prominent one. Ignore the shop model's face, body and pose, and everything else they are wearing.

Preserve the person's recognizable face, hair, age, build, skin tone and natural skin texture. Keep the item's color, material, pattern, construction, proportions, length, neckline, sleeves and actual fastenings, and any graphics or lettering that are legible. Adapt only its drape and fit to the person's body. Do not invent an opening, closure, logo or text.

Replace everything the person wears in Image 1. Do not copy any of its clothes. Complete the outfit only where needed with a modest plain white or grey top, plain straight trousers in a quiet neutral and simple shoes, so the item stands out. If the item is footwear, show the whole shoe, using ankle-length trousers that stop above it. If it is a bag or other accessory, wear it where it stays in full view. Do not add other accessories.

Composition: show the complete person from head through shoes in a relaxed, mostly front-facing pose, with arms away from the torso so the item stays readable. Use a plain soft neutral backdrop and even natural light that doesn't shift the item's color.

Do not add captions, text overlays, watermarks or extra people.`;
}

// A preview is never saved, so it returns to the browser as one compressed JPEG
// that fits inside a hosted function's response limit.
export async function generateTryOn({ setting, fetch: fetchImpl = fetch, baseUrl, key, candidate, reference, itemName, signal, beforePaidCall, timeoutMs = TIMEOUT_MS }) {
  const model = setting("OPENAI_TRYON_MODEL") || DEFAULT_TRY_ON_MODEL;
  const complexity = imageComplexity(setting, "try-on", model);
  const form = new FormData();
  form.set("model", model);
  form.set("prompt", buildTryOnPrompt({ itemName }));
  form.set("size", "1024x1536");
  form.set("quality", setting("OPENAI_TRYON_QUALITY") || DEFAULT_TRY_ON_QUALITY);
  form.set("output_format", "jpeg");
  form.set("output_compression", "85");
  form.set("moderation", IMAGE_MODERATION);
  form.set("n", "1");
  if (complexity) form.set("complexity", complexity);
  form.append("image[]", new Blob([reference], { type: "image/jpeg" }), "person.jpg");
  form.append("image[]", new Blob([candidate], { type: "image/jpeg" }), "item.jpg");

  await beforePaidCall?.("image");
  const timeout = AbortSignal.timeout(timeoutMs);
  let response, result;
  try {
    response = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/images/edits`, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.any([signal, timeout]) });
    result = await response.json().catch(() => ({}));
  } catch {
    if (signal.aborted) throw fail("This preview was cancelled.", 499);
    if (timeout.aborted) throw fail("The preview timed out. Check API usage before trying again; a retry starts a new request.", 504);
    throw fail("Could not reach the image API. Check the API base URL and connection.", 502);
  }
  if (!response.ok) throw fail(`The image API returned HTTP ${response.status}. ${providerAdvice(response.status, result)}`, 502);
  const encoded = result.data?.[0]?.b64_json;
  if (typeof encoded !== "string" || !encoded.length || encoded.length > MAX_ENCODED_BYTES) throw fail("The image API did not return a usable preview. Try again.", 502);
  try {
    return await sharp(Buffer.from(encoded, "base64"), { limitInputPixels: 64e6 }).rotate().flatten({ background: "#ffffff" }).jpeg({ quality: 85 }).toBuffer();
  } catch { throw fail("The image API returned an unreadable preview. Try again.", 502); }
}
