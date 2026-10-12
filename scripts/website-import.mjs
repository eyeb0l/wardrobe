import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { createBrotliDecompress, createUnzip } from "node:zlib";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Parser } from "htmlparser2";
import ipaddr from "ipaddr.js";
import sharp from "sharp";

const fail = (message, status = 422) => Object.assign(new Error(message), { status });
const fallback = "Try another product link, or upload a product photo instead.";

export function websiteUrl(value, base) {
  let url;
  try { url = new URL(value, base); } catch { throw fail("Enter a full http:// or https:// product link.", 400); }
  if (typeof value !== "string" || value.length > 4096 || !["https:", "http:"].includes(url.protocol)
    || url.username || url.password || url.port) throw fail("Use a public http:// or https:// product link without a password or custom port.", 400);
  url.hash = "";
  return url;
}

export function isPublicAddress(address) {
  try {
    const parsed = ipaddr.process(address);
    return parsed.range() === "unicast" && (parsed.kind() === "ipv4" || parsed.match(ipaddr.parse("2000::"), 3));
  } catch { return false; }
}

// Validate every resolved address and pin the connection to one of them. A
// second, uncontrolled DNS lookup would allow a public hostname to rebind locally.
export async function publicLookup(hostname, options, callback) {
  try {
    const host = hostname.replace(/^\[|\]$/g, "");
    const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true });
    if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
      throw fail("Website imports can only access public internet addresses.", 400);
    }
    if (options.all) callback(null, [addresses[0]]);
    else callback(null, addresses[0].address, addresses[0].family);
  } catch (error) { callback(error); }
}

const limitStream = (limit) => {
  let size = 0;
  return new Transform({ transform(chunk, encoding, callback) {
    size += chunk.length;
    callback(size > limit ? fail(`That website or image is too large. ${fallback}`) : null, chunk);
  } });
};

export async function fetchWebsiteResource(value, { kind, signal, request = (url, options, callback) => (url.protocol === "https:" ? https : http).get(url, options, callback) } = {}) {
  let url = websiteUrl(value);
  for (let redirect = 0; redirect <= 4; redirect++) {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    // Node skips lookup for IP literals, so these need a separate check.
    if (isIP(host) && !isPublicAddress(host)) throw fail("Website imports can only access public internet addresses.", 400);
    const result = await new Promise((resolve, reject) => {
      const req = request(url, {
        agent: false, lookup: publicLookup, signal: signal || AbortSignal.timeout(15_000),
        headers: { "User-Agent": "Wardrobe/1.0 (product import)", Accept: kind === "image" ? "image/*" : "text/html,application/xhtml+xml", "Accept-Encoding": "gzip, deflate, br" },
      }, async (response) => {
        try {
          if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
            response.destroy();
            if (!response.headers.location) throw fail(`That website returned an invalid redirect. ${fallback}`);
            return resolve({ location: response.headers.location });
          }
          if (response.statusCode !== 200) throw fail(`The website could not be read (${response.statusCode}). ${fallback}`);
          const type = (response.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
          if (kind === "image" ? !/^image\/(jpeg|png|webp|avif)$/.test(type) : !["text/html", "application/xhtml+xml"].includes(type)) {
            throw fail(`That link did not return a supported ${kind === "image" ? "product image" : "web page"}. ${fallback}`);
          }
          const limit = (kind === "image" ? 12 : 2) * 1024 * 1024;
          const encoding = (response.headers["content-encoding"] || "identity").toLowerCase();
          if (!["identity", "gzip", "deflate", "br"].includes(encoding)) throw fail(`That website uses an unsupported response format. ${fallback}`);
          const chunks = [];
          const streams = [response, limitStream(limit)];
          if (encoding !== "identity") streams.push(encoding === "br" ? createBrotliDecompress() : createUnzip(), limitStream(limit));
          await pipeline(...streams, async (source) => { for await (const chunk of source) chunks.push(chunk); });
          resolve({ bytes: Buffer.concat(chunks), url: url.href });
        } catch (error) { response.destroy(); reject(error); }
      });
      req.on("error", reject);
    }).catch(error => { throw error.status ? error : fail(`The website could not be reached or took too long. ${fallback}`); });
    if (!result.location) return result;
    url = websiteUrl(result.location, url);
  }
  throw fail(`That website redirected too many times. ${fallback}`);
}

function plain(value, max = 500) {
  if (Array.isArray(value)) value = value.filter(v => typeof v === "string").join(", ");
  if (typeof value !== "string") return "";
  let text = "";
  new Parser({ ontext(chunk) { text += chunk; } }).end(value);
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

function comparablePageUrl(value, pageUrl) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = websiteUrl(value, pageUrl);
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    // Compare page identities without changing download URLs. Keep meaningful
    // selectors such as product IDs, colours and variants distinct.
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_.*|gclid|dclid|fbclid|msclkid|gbraid|wbraid)$/i.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return url.href;
  } catch { return null; }
}

function productPage(product, pageUrl) {
  return comparablePageUrl(product.url || product["@id"], pageUrl);
}

function productIdentity(product, pageUrl) {
  const page = productPage(product, pageUrl);
  if (page) return `page:${page}`;
  const group = product.productGroupID || product.isVariantOf?.productGroupID || product.isVariantOf?.["@id"] || product.isVariantOf?.url
    || (typeof product.isVariantOf === "string" ? product.isVariantOf : "");
  if (typeof group === "string" && group.trim()) return `group:${group.trim()}`;
  // Without a shared page/group, require matching identifying details. Names
  // alone can describe unrelated products on a collection page.
  const name = plain(product.name);
  const brand = plain(typeof product.brand === "object" ? product.brand?.name : product.brand);
  const identifier = plain(product.productID || product.sku || product.mpn);
  if (identifier) return `item:${JSON.stringify([name, brand, identifier])}`;
  return JSON.stringify([
    name, brand,
    plain(product.color), plain(product.material), plain(product.description, 2000), product.image,
  ]);
}

export function extractWebsiteProduct(html, pageUrl) {
  const meta = new Map();
  const documents = [];
  let script = null, title = "", inTitle = false, canonicalUrl = null, documentBase = null;
  new Parser({
    onopentag(tag, attrs) {
      if (tag === "meta") {
        const key = (attrs.property || attrs.name || "").toLowerCase();
        if (attrs.content && !meta.has(key)) meta.set(key, attrs.content);
      }
      if (tag === "base" && documentBase === null && typeof attrs.href === "string") {
        try { documentBase = websiteUrl(attrs.href, pageUrl).href; } catch { /* Keep looking for a valid HTTP(S) base. */ }
      }
      if (tag === "link" && !canonicalUrl && attrs.rel?.toLowerCase().split(/\s+/).includes("canonical")) canonicalUrl = attrs.href;
      if (tag === "script" && attrs.type?.split(";")[0].trim().toLowerCase() === "application/ld+json") script = "";
      if (tag === "title") inTitle = true;
    },
    ontext(text) { if (script !== null) script += text; if (inTitle) title += text; },
    onclosetag(tag) {
      if (tag === "title") inTitle = false;
      if (tag === "script" && script !== null) {
        try { documents.push(JSON.parse(script)); } catch { /* Try other structured data or social tags. */ }
        script = null;
      }
    },
  }).end(html);
  // Resolve metadata only after parsing, so even URLs preceding <base> use the
  // first valid document base. Keep pageUrl as the source and requested page.
  const metadataBase = documentBase || pageUrl;
  const products = [];
  const queue = [...documents];
  // Iterative and bounded: retailer JSON can be deeply nested or contain lists
  // of related products. Prefer the product whose URL matches the requested page.
  for (let visited = 0; visited < queue.length && visited < 10_000; visited++) {
    const node = queue[visited];
    if (!node || typeof node !== "object") continue;
    if ([node["@type"]].flat().some(type => typeof type === "string" && /(?:^|\/)Product$/.test(type))) products.push(node);
    for (const value of Object.values(node)) {
      if (queue.length >= 10_000) break;
      if (value && typeof value === "object") queue.push(value);
    }
  }
  // Prefer the requested variant over a retailer's generic canonical product.
  // Same-site metadata also connects collection-path aliases to their product.
  const pageOrigin = new URL(pageUrl).origin;
  const pageIdentities = [pageUrl, canonicalUrl, meta.get("og:url")]
    .map(value => comparablePageUrl(value, metadataBase))
    .filter(value => value && new URL(value).origin === pageOrigin);
  const matching = pageIdentities.map(identity => products.filter(product => productPage(product, metadataBase) === identity))
    .find(matches => matches.length) || [];
  const identities = new Set(products.map(product => productIdentity(product, metadataBase)));
  if (!matching.length && identities.size > 1) throw fail(`This page lists several products. Open an individual product page. ${fallback}`);
  const imageCandidates = values => [...new Set(values.filter(Boolean).flatMap(value => {
    try { return [websiteUrl(value, metadataBase).href]; } catch { return []; }
  }))].slice(0, 3);
  // Duplicate blocks can be incomplete. Prefer a record with usable image URLs,
  // then the most details, keeping its images first and using its metadata.
  const ranked = (matching.length ? matching : products).map(product => ({
    product,
    images: imageCandidates([product.image].flat().map(image => typeof image === "string" ? image : image?.contentUrl || image?.url)),
    details: [product.name, product.description, typeof product.brand === "object" ? product.brand?.name : product.brand,
      product.material, product.color, product.category, product.sku].filter(value => plain(value)).length,
  }));
  ranked.sort((a, b) => Number(b.images.length > 0) - Number(a.images.length > 0) || b.details - a.details);
  const { product = {}, images: structuredImages = [] } = ranked[0] || {};
  // Reuse duplicate photos, but never pair a known different variant's image
  // with the selected record's metadata. Missing fields can be complementary.
  const duplicateImages = imageCandidates(ranked.slice(1).filter(({ product: other }) =>
    ["sku", "productID", "mpn", "color", "size"].every(field =>
      !plain(product[field]) || !plain(other[field]) || plain(product[field]) === plain(other[field])))
    .flatMap(({ images }) => images).filter(image => !structuredImages.includes(image)));
  // Bound each source separately so a full structured-image list cannot crowd
  // out social fallbacks when those preferred images fail to load or decode.
  const socialImages = imageCandidates([meta.get("og:image"), meta.get("twitter:image"), meta.get("twitter:image:src")]);
  const imageUrls = [...new Set([...structuredImages, ...duplicateImages, ...socialImages])];
  if (!imageUrls.length) throw fail(`No product photo was found on this page. ${fallback}`);
  const name = plain(product.name || meta.get("og:title") || meta.get("twitter:title") || title, 120);
  if (!name) throw fail(`No product details were found on this page. ${fallback}`);
  return {
    source: { type: "website", url: pageUrl, name,
      description: plain(product.description || meta.get("og:description") || meta.get("description"), 2000),
      brand: plain(typeof product.brand === "object" ? product.brand?.name : product.brand, 120),
      material: plain(product.material, 200), color: plain(product.color, 120),
      category: plain(product.category, 120), sku: plain(product.sku, 120),
    }, imageUrls,
  };
}

export async function importWebsiteProduct(value, { fetchResource = fetchWebsiteResource } = {}) {
  const url = websiteUrl(value);
  const signal = AbortSignal.timeout(30_000);
  const page = await fetchResource(url.href, { kind: "page", signal });
  const { source, imageUrls } = extractWebsiteProduct(page.bytes.toString("utf8"), page.url);
  for (const imageUrl of imageUrls) {
    try {
      const image = await fetchResource(imageUrl, { kind: "image", signal });
      const input = sharp(image.bytes, { limitInputPixels: 64_000_000 });
      const metadata = await input.metadata();
      if (!["jpeg", "png", "webp", "avif", "heif"].includes(metadata.format) || metadata.pages > 1) continue;
      const data = await input.rotate().resize({ width: 2400, height: 2400, fit: "inside", withoutEnlargement: true }).toColorspace("srgb").png().toBuffer();
      return { data, source: { ...source, imageUrl: image.url } };
    } catch { /* Another image of this same product may be usable. */ }
  }
  throw fail(`The product photo could not be downloaded or decoded. ${fallback}`);
}
