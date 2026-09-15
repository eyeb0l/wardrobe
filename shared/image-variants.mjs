export const DISPLAY_WIDTHS = [320, 640, 1280];
export const DISPLAY_RECIPE = 'webp-q85-alpha100-v1';

export function displayImageSource(src, width = 640) {
  if (typeof src !== 'string' || !src.startsWith('/api/')) return null;
  const url = new URL(src, 'http://wardrobe.local');
  if (!/^\/api\/(?:import\/(?:library\/[\w.-]+\.(?:png|jpe?g|webp)|assets\/[a-f0-9-]{36}\/[\w.-]+\.(?:png|jpe?g|webp)|model-references\/(?:default|model-reference-[1-9]\d*))|outfits\/(?:images\/[\w.-]+\.png|jobs\/[a-f0-9-]{36}\/assets\/[\w.-]+\.png))$/i.test(url.pathname)) return null;
  url.searchParams.set('format', 'webp');
  url.searchParams.set('w', String(width));
  return url.pathname + url.search;
}

export function requestedDisplayWidth(url) {
  if (!url.searchParams.has('format') && !url.searchParams.has('w')) return null;
  const width = Number(url.searchParams.get('w'));
  if (url.searchParams.get('format') !== 'webp' || !DISPLAY_WIDTHS.includes(width)) {
    throw Object.assign(new Error('Unsupported display image size or format'), { status: 400 });
  }
  return width;
}
