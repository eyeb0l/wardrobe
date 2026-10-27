# Importing and editing clothes

The importer detects up to eight visible clothing items per photo with the Responses API, then creates product cutouts and modelled previews with the Images API. Review each stage before approval. It supports drag-and-drop, paste, metadata editing, regeneration and manual modelled-photo uploads.

The gallery filters Tops, Dresses, Jackets, Bottoms, Accessories and Shoes. Reclassify existing dresses in the item editor. Open a saved item and choose **Update modelled photo** or **Create modelled photo** to select a reference and optional direction. A replacement remains a review candidate until **Approve**; **Reject** keeps the existing photo.

## Import from a website

Choose **Add clothes → Import from a website** and paste an individual product URL to import a retailer photo and its details. Product structured data (JSON-LD) is preferred, with Open Graph/Twitter image and title tags as a fallback. The importer uses the page's name, description, brand, material and colour alongside the photo to identify the target garment, suggest its category, colours and tags, and enter the usual crop → cutout → modelled-photo review flow. The source link and available product details are saved with the item. Check the selected product and colour before approving, especially on pages with variants.

Website imports read public HTTP(S) pages without logging in or running page JavaScript. Sites that block automated access, require a login, or omit accessible product images may need a photo upload instead. Each import is limited to one product; collection pages with ambiguous product data are rejected. Remote requests have time, size and redirect limits and cannot access private network addresses.

## Difficult detections

For difficult detections, choose **Retry with Sol** in crop review or after a no-clothing result. This paid retry uses Sol at medium effort; review its candidates before replacing the crop. Initial detection uses GPT-6.1 Terra by default ([evaluation](vision-gpt6-detection-evaluation.md)). See [retry behaviour and limits](terra-detection-retry.md).

## Cutouts

New generated cutouts request a transparent PNG from Sunburst, then correct near-opaque garment interiors locally before normal review. Light/dark backgrounds and zoom help inspect edges and details. Older chroma-key jobs retain their automatic and manual edge cleanup controls. Both paths resume from saved bytes without another generation charge; saved wardrobe images are not changed retroactively. See [automatic garment cleanup](automatic-garment-cleanup.md) for checks and recovery behaviour.

### Restarts and interrupted generation

Restarting the local server never sends a paid request again. A cutout or modelled photo that was already requesting an image when the server stopped is marked failed with an interruption message: check provider usage before **Retry**, which starts a new paid request. Stages that had not reached the provider start normally, and cutout cleanup resumes from saved bytes. When Vite restarts inside the same process (for example after editing `.env` or `vite.config.mjs`), a generation that is still running finishes once and its result is kept.

Approving a modelled photo publishes the wardrobe item before the import is marked complete. If that final step is interrupted, the import stays in review and can be approved again; an older import left complete is finished the next time its modelled photo is updated.

### Use original image

For a likely single-item product shot, **Use original image** skips generative extraction. Existing transparency is preserved; opaque backgrounds are removed on the device with a browser worker, then shown against a checkerboard for review. Only a transparency mask is returned to the app: garment colours and dimensions come from the stored original. **Extract garment** remains the default for ordinary photos. If detection gets it wrong, you can manually select **Use original image** after checking that the full original contains one isolated item without a person or other products.

Browser removal uses Transformers.js 4.3.0 (Apache-2.0) and the MIT-licensed [BiRefNet_lite 512 ONNX model](https://huggingface.co/studioludens/birefnet-lite-512), pinned to revision `4a3c40c36c94093cc1e724d9ea428b8fa4b57dc7`. The first opaque photo downloads approximately 175 MiB of weights plus the browser runtime; weights are cached where browser storage permits. Model assets come from Hugging Face; the photograph stays on the device during inference. No generative API request or background-removal service is used. A worker keeps the UI responsive and supports cancellation; failures leave the crop unchanged and never automatically spend credits on extraction. Vercel hosts the JS/WASM files and saves the mask result through the existing authenticated API. Inference is independent of Vercel function execution limits. Mobile speed and memory use vary by device.

## Upload preparation

The file picker, drop and paste accept JPEG, PNG, WebP and HEIC/HEIF sources up to 50 MB and 64 megapixels. Import uploads preserve JPEG/PNG/WebP files of at most 2 MB byte-for-byte, including resolution, transparency and metadata. Larger files are compressed locally to at most 2 MB and a 2,400-pixel edge; PNG/WebP compression preserves transparency. HEIC converts locally to JPEG; a source of at most 2 MB keeps its resolution if the converted result also fits. The server normalises import images to PNG before review.

Modelled-photo uploads follow the [manual modelled photos](MODELED_PHOTOS.md) rules, and Shopping uploads follow the [Shopping](SHOPPING.md#upload-preparation) rules.
