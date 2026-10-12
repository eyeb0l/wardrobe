import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import sharp from "sharp";
import { extractWebsiteProduct, fetchWebsiteResource, importWebsiteProduct, isPublicAddress, publicLookup, websiteUrl } from "./website-import.mjs";

const url = "https://shop.example/products/shirt";
const ld = value => `<script type="application/ld+json">${JSON.stringify(value)}</script>`;
const product = { "@type": "Product", name: "Blue & cream shirt", image: "/shirt.png", brand: { name: "Example" }, material: "Linen", color: "Blue", category: "Shirts", sku: "SKU-1", description: "<p>A linen shirt.</p>" };

test("extracts JSON-LD graph product details, image objects and relative URLs", () => {
  const result = extractWebsiteProduct(ld({ "@graph": [{ "@type": "Organization", name: "Shop" }, { ...product, image: [{ "@type": "ImageObject", contentUrl: "//cdn.example/shirt.png" }] }] }), url);
  assert.deepEqual(result.imageUrls, ["https://cdn.example/shirt.png"]);
  assert.deepEqual(result.source, { type: "website", url, name: product.name, description: "A linen shirt.", brand: "Example", material: "Linen", color: "Blue", category: "Shirts", sku: "SKU-1" });
});

test("falls back to social metadata, decoding HTML entities and ignoring malformed JSON-LD", () => {
  const result = extractWebsiteProduct(`<script type="application/ld+json">broken</script><meta content='Blue &amp; cream shirt' property='og:title'><meta name='twitter:image' content='/shirt.png?a=1&amp;b=2'><meta name='description' content='Soft &amp; light'>`, url);
  assert.equal(result.source.name, product.name);
  assert.equal(result.source.description, "Soft & light");
  assert.equal(result.imageUrls[0], "https://shop.example/shirt.png?a=1&b=2");
});

test("prefers product data over site social tags and refuses ambiguous collection pages", () => {
  const html = `<meta property="og:title" content="Shop"><meta property="og:image" content="/logo.png">`;
  assert.equal(extractWebsiteProduct(html + ld(product), url).imageUrls[0], "https://shop.example/shirt.png");
  assert.throws(() => extractWebsiteProduct(ld([product, { ...product, name: "Other" }]), url), /several products/);
  const matched = extractWebsiteProduct(ld([{ ...product, url }, { ...product, name: "Other", url: "/other" }]), url);
  assert.equal(matched.source.name, product.name);
  assert.throws(() => extractWebsiteProduct("<title>Shop</title>", url), /No product photo/);
  assert.throws(() => extractWebsiteProduct(ld({ ...product, image: "data:image/png;base64,AAAA" }), url), /No product photo/);
});

test("rejects unsafe URLs and non-public IP address forms", async () => {
  for (const value of [null, 1, "no url", "file:///etc/passwd", "ftp://shop.example/a", "https://user:pass@shop.example", "https://shop.example:8443"]) assert.throws(() => websiteUrl(value));
  for (const address of ["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.100.100.100", "0.0.0.0", "224.0.0.1", "::1", "::", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "2001:db8::1", "2002:7f00:1::", "64:ff9b::7f00:1"]) assert.equal(isPublicAddress(address), false, address);
  for (const address of ["93.184.216.34", "2606:4700:4700::1111"]) assert.equal(isPublicAddress(address), true, address);
  await assert.rejects(new Promise((resolve, reject) => publicLookup("localhost", {}, (error, value) => error ? reject(error) : resolve(value))), /public internet/);
  for (const value of ["http://127.1", "http://2130706433", "http://0x7f000001", "http://[::ffff:127.0.0.1]"]) {
    await assert.rejects(fetchWebsiteResource(value, { kind: "page", request() { assert.fail("Must reject before connecting"); } }), /public internet/);
  }
});

function mockRequest(responses, calls = []) {
  return (requestUrl, options, callback) => {
    calls.push({ url: requestUrl.href, options });
    const req = new EventEmitter();
    queueMicrotask(() => {
      const next = responses.shift();
      if (next instanceof Error) return req.emit("error", next);
      const response = Readable.from([next.bytes || Buffer.from("<title>Product</title>")]);
      Object.assign(response, { statusCode: 200, headers: { "content-type": "text/html" }, ...next });
      callback(response);
    });
    return req;
  };
}

test("rechecks redirect URLs, pins DNS lookup, sends no credentials and handles gzip", async () => {
  const calls = [];
  const result = await fetchWebsiteResource(url, { kind: "page", request: mockRequest([
    { statusCode: 302, headers: { location: "/new" } },
    { headers: { "content-type": "text/html; charset=utf-8", "content-encoding": "gzip" }, bytes: gzipSync("product html") },
  ], calls) });
  assert.equal(result.url, "https://shop.example/new");
  assert.equal(result.bytes.toString(), "product html");
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.options.lookup, publicLookup);
    assert.equal(call.options.agent, false);
    assert.equal(call.options.headers.Authorization, undefined);
    assert.equal(call.options.headers.Cookie, undefined);
  }
  const addresses = await new Promise((resolve, reject) => publicLookup("93.184.216.34", { all: true }, (error, values) => error ? reject(error) : resolve(values)));
  assert.deepEqual(addresses, [{ address: "93.184.216.34", family: 4 }]);
  await assert.rejects(fetchWebsiteResource(url, { kind: "page", request: mockRequest([{ statusCode: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } }]) }), /public internet/);
  await assert.rejects(fetchWebsiteResource(url, { kind: "page", request: mockRequest(Array.from({ length: 5 }, () => ({ statusCode: 302, headers: { location: "/loop" } }))) }), /too many times/);
});

test("bounds downloads and decompression and reports blocked/invalid/timed-out responses", async () => {
  for (const [response, pattern, kind = "page"] of [
    [{ statusCode: 403 }, /403/],
    [{ headers: { "content-type": "application/pdf" } }, /web page/],
    [{ headers: { "content-type": "image/svg+xml" } }, /product image/, "image"],
    [{ bytes: Buffer.alloc(2 * 1024 * 1024 + 1) }, /too large/],
    [{ headers: { "content-type": "text/html", "content-encoding": "gzip" }, bytes: gzipSync(Buffer.alloc(2 * 1024 * 1024 + 1)) }, /too large/],
    [new Error("ETIMEDOUT"), /took too long/],
  ]) await assert.rejects(fetchWebsiteResource(url, { kind, request: mockRequest([response]) }), pattern);
});

test("downloads a decodable product image with bounded fallback and retains provenance", async () => {
  const image = await sharp({ create: { width: 80, height: 120, channels: 4, background: "#333333" } }).png().toBuffer();
  const calls = [];
  const result = await importWebsiteProduct(url, { fetchResource: async (value, options) => {
    calls.push({ value, options });
    return { url: value, bytes: options.kind === "page" ? Buffer.from(ld({ ...product, image: ["/bad.png", "/shirt.png"] })) : value.endsWith("bad.png") ? Buffer.from("invalid image") : image };
  } });
  assert.equal(calls.length, 3);
  assert.equal(result.source.imageUrl, "https://shop.example/shirt.png");
  assert.equal((await sharp(result.data).metadata()).format, "png");
  assert.equal(result.source.material, "Linen");
  await assert.rejects(importWebsiteProduct(url, { fetchResource: async (value, options) => ({ url: value, bytes: Buffer.from(options.kind === "page" ? ld(product) : "bad") }) }), /could not be downloaded or decoded/);
});
