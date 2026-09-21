import { dataUrl, decodeUploadImage } from './image-upload.mjs';
import { productBackground } from '../shared/product-background.mjs';

export async function prepareOriginalCutout(url, { onProgress = () => {}, signal } = {}) {
  onProgress('Checking image transparency');
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error('The original image could not be loaded. Please retry.');
  const blob = await response.blob();
  const image = await decodeUploadImage(blob);
  const canvas = document.createElement('canvas');
  let transparent;
  try {
    const scale = Math.min(1, 320 / Math.max(image.width, image.height));
    canvas.width = Math.round(image.width * scale);
    canvas.height = Math.round(image.height * scale);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('This browser cannot prepare the image. Try another browser.');
    ctx.drawImage(image.source, 0, 0, canvas.width, canvas.height);
    transparent = productBackground(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height).transparent;
  } finally { image.close(); canvas.width = canvas.height = 1; }
  signal?.throwIfAborted();
  if (transparent) return {};
  const mask = await new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./background-removal.worker.mjs', import.meta.url), { type: 'module' });
    const finish = (error, value) => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', cancel);
      worker.terminate();
      if (error) reject(error); else resolve(value);
    };
    const cancel = () => finish(new DOMException('Background removal cancelled.', 'AbortError'));
    const timeout = setTimeout(() => finish(new Error('Background removal took too long on this device. Retry or choose Extract garment.')), 240_000);
    signal?.addEventListener('abort', cancel, { once: true });
    worker.onmessage = ({ data }) => {
      if (data.error) finish(new Error(data.error));
      else if (data.mask) finish(null, data.mask);
      else onProgress(`${data.status}${Number.isFinite(data.progress) ? ` — ${Math.round(data.progress)}%` : ''}`);
    };
    worker.onerror = () => finish(new Error('The background remover could not load. Check your connection and retry.'));
    worker.postMessage({ blob });
  });
  signal?.throwIfAborted();
  onProgress('Preparing cutout for review');
  const maskDataUrl = await dataUrl(mask);
  signal?.throwIfAborted();
  return { maskDataUrl };
}
