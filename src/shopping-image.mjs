import { prepareUploadImage } from "./image-upload.mjs";

export { formatImageBytes, MAX_INPUT_BYTES as MAX_SHOPPING_INPUT_BYTES, MAX_UPLOAD_BYTES as MAX_SHOPPING_IMAGE_BYTES } from "./image-upload.mjs";

// Shopping’s analysis endpoint expects a normalized JPEG on every request.
export function prepareShoppingImage(file) {
  return prepareUploadImage(file, { preserveSmall: false, maxEdge: 1600 });
}
