import { stat } from "./storage-fs.mjs";

// Reference photos can be replaced in place. Versioning the URL by the file's
// timestamp and size makes an open page load the new photo instead of reusing
// the image it already decoded for the same address.
export async function modelReferenceImageUrl(id, file) {
  const base = `/api/import/model-references/${id}`;
  try {
    const { mtimeMs, size } = await stat(file);
    return Number.isFinite(mtimeMs) && Number.isFinite(size) ? `${base}?v=${Math.trunc(mtimeMs).toString(36)}-${size.toString(36)}` : base;
  } catch { return base; }
}

export const publicModelReferences = (references, editable = () => undefined) => Promise.all(references.map(async (reference) => {
  const value = { id: reference.id, label: reference.label, imageUrl: await modelReferenceImageUrl(reference.id, reference.file ?? reference.path) };
  const canReplace = editable(reference);
  return canReplace === undefined ? value : { ...value, editable: canReplace };
}));
