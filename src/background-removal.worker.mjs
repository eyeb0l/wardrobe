import { AutoModel, AutoProcessor, RawImage, env } from '@huggingface/transformers';

// Pin both code and weights. The model is downloaded only for opaque originals,
// cached by the browser, and never receives uploaded images over the network.
const MODEL = 'studioludens/birefnet-lite-512';
const REVISION = '4a3c40c36c94093cc1e724d9ea428b8fa4b57dc7';
env.allowLocalModels = false;
env.backends.onnx.wasm.numThreads = 1;
self.onmessage = async ({ data: { blob } }) => {
  let model;
  try {
    const progress_callback = event => {
      if (event.status === 'progress') self.postMessage({ status: 'Downloading background remover', progress: event.progress });
    };
    self.postMessage({ status: 'Loading background remover (first download about 175 MB)' });
    // WASM works without WebGPU or cross-origin isolation, including Safari.
    model = await AutoModel.from_pretrained(MODEL, { revision: REVISION, dtype: 'fp32', device: 'wasm', progress_callback });
    const processor = await AutoProcessor.from_pretrained(MODEL, { revision: REVISION });
    self.postMessage({ status: 'Removing background on this device' });
    const image = await RawImage.fromBlob(blob);
    const { pixel_values } = await processor(image);
    const outputs = await model({ input_image: pixel_values });
    const logits = outputs.logits ?? outputs.output_image;
    const scale = Math.min(1, 2048 / Math.max(image.width, image.height));
    const mask = await RawImage.fromTensor(logits[0].sigmoid().mul(255).to('uint8'))
      .resize(Math.round(image.width * scale), Math.round(image.height * scale));
    self.postMessage({ mask: await mask.toBlob('image/png') });
  } catch (error) {
    self.postMessage({ error: 'Background removal could not finish on this device. Check your connection and retry, or choose Extract garment.', detail: error.message });
  } finally { await model?.dispose(); }
};
