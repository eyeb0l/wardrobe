import { prepareUploadImage } from "./image-upload.mjs";

// Shopping’s analysis endpoint expects a normalized JPEG on every request.
export function prepareShoppingImage(file) {
  return prepareUploadImage(file, { preserveSmall: false, maxEdge: 1600 });
}
