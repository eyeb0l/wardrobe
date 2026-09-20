# Manual modeled photos

Use a manually created photograph when generation fails or you want to supply your own result. Wardrobe does not automatically switch models or call another provider.

## Copy the failed attempt

Choose **Copy prompt** beside the failed generation's retry controls to copy the recorded prompt, including its submitted correction. Copying makes no API call. Older import jobs expose this button after a new generation attempt records a prompt. If clipboard access fails, the app shows selectable text.

Supply the identity and garment images to your chosen image tool in the order described in the prompt. Copied text has no image attachments; an outfit correction prompt may also reference the previous attempt. Review likeness, exact garment details and complete framing before uploading.

## Upload and crop

| Destination | Where to upload | Required crop | Minimum crop | Recommended source |
| --- | --- | --- | --- | --- |
| Wardrobe piece | **Update modelled shot** / **Create modelled shot**, or a failed/completed modeled-generation review | Horizontal 3:2 | 768 × 512 pixels | 1536 × 1024 or larger |
| Outfit | Generation review, beneath retry controls; wait for active collection generation to finish | Square | 512 × 512 pixels | 1024 × 1024 or larger |

Choose **Upload modeled photo**, then drag within the preview or use the zoom/position controls. Arrow keys move the crop when the preview is focused. **Reset crop** restores the widest centered framing; **Cancel crop** leaves the current image untouched. **Use crop** prepares and uploads the selected area. Selecting a file alone uploads nothing.

Portrait, landscape and slightly off-ratio sources work if they contain a crop of the required size. Cropping uses the decoded original with orientation applied, independently of the smaller preview. Output dimensions always match the exact ratio. Zoom stops before the crop is too small; crops are never stretched or upscaled.

Uploads create review candidates. **Approve** / **Accept into collection** saves the candidate; rejecting a replacement preserves the existing wardrobe photo. Opening a review, copying its prompt and uploading a photo make no model calls. Approval and retry controls are disabled while editing a crop.

## Image processing

- Source formats: JPEG, PNG, WebP and HEIC/HEIF, up to 50 MB and 64 megapixels.
- The browser compresses the crop to at most 2 MB and a maximum 2,400-pixel edge while preserving the exact ratio and minimum dimensions.
- The server checks prepared bytes, fully decodes the image, applies EXIF orientation and validates displayed dimensions. It rejects animated, malformed, oversized or incorrectly shaped images.
- The server saves a metadata-free PNG at the prepared resolution without further cropping or stretching. Responsive WebP display copies use the same image pipeline as generated photos; the PNG is retained.

## API and implementation

Send a JSON body with `imageDataUrl` to the appropriate endpoint:

```text
POST /api/import/jobs/:id/stages/modeled/upload
POST /api/outfits/jobs/:jobId/outfits/:outfitId/upload
```

```json
{ "imageDataUrl": "data:image/png;base64,..." }
```

Prepared JPEG and WebP data URLs are also accepted. Prepared bytes are capped at 2 MB and the JSON body at 3 MB. Direct API clients must supply a correctly shaped image; HEIC conversion and crop preparation belong on the client.

Keep these routes inside the existing mutation locks, storage adapter and approval flow. Do not write uploads directly to the saved library or collection. Preserve originals and serve compressed copies through the display-image routes. Prompt copying must use the recorded attempt prompt, not just the editable correction field.

Shared limits live in [`shared/modeled-upload.mjs`](../shared/modeled-upload.mjs), server normalization in [`scripts/modeled-upload.mjs`](../scripts/modeled-upload.mjs), and browser crop preparation in [`src/modeled-crop-image.mjs`](../src/modeled-crop-image.mjs).
