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

test("document base resolves structured and social image URLs even when it follows the metadata", () => {
  const html = ld({ ...product, image: ["images/front.png", { contentUrl: "/back.png" }, "https://images.example/absolute.png"] })
    + '<meta property="og:image" content="social.png"><meta name="twitter:image" content="//images.example/twitter.png">'
    + '<base href="https://cdn.example/catalog/">';
  const result = extractWebsiteProduct(html, url);
  assert.deepEqual(result.imageUrls, ["https://cdn.example/catalog/images/front.png", "https://cdn.example/back.png",
    "https://images.example/absolute.png", "https://cdn.example/catalog/social.png", "https://images.example/twitter.png"]);
  assert.equal(result.source.url, url);
});

test("first valid base wins, resolves against the fetched page, and falls back when absent or invalid", () => {
  const metadata = ld({ ...product, image: "shirt.png" });
  const invalid = '<base target="_blank"><base href="javascript:invalid"><base href="http://[invalid">';
  const result = extractWebsiteProduct(invalid + '<base href="../catalog/"><base href="https://ignored.example/">' + metadata, url);
  assert.deepEqual(result.imageUrls, ["https://shop.example/catalog/shirt.png"]);
  for (const bases of ["", invalid, '<base href=""><base href="https://ignored.example/">']) {
    assert.deepEqual(extractWebsiteProduct(bases + metadata, url).imageUrls, ["https://shop.example/products/shirt.png"]);
  }
});

test("relative product and canonical URLs use the same document base for primary selection and deduplication", () => {
  const base = '<base href="/catalog/">';
  const canonical = "https://shop.example/catalog/shirt";
  for (const [metadata, productUrl] of [
    ['<link rel="canonical" href="shirt">', canonical],
    ['<meta property="og:url" content="shirt">', canonical],
    [`<link rel="canonical" href="${canonical}">`, "shirt"],
  ]) {
    const result = extractWebsiteProduct(base + metadata + ld([
      { ...product, name: "Recommended", url: "other" }, { ...product, url: productUrl, image: "shirt.png" },
    ]), url);
    assert.equal(result.source.name, product.name);
    assert.deepEqual(result.imageUrls, ["https://shop.example/catalog/shirt.png"]);
    assert.equal(result.source.url, url);
  }
  assert.equal(extractWebsiteProduct(base + ld([{ ...product, url: "shirt" }, { ...product, url: canonical }]), url).source.name, product.name);
});

test("import downloads a base-relative image and still rejects private-network bases", async () => {
  const png = await sharp({ create: { width: 80, height: 120, channels: 4, background: "#333333" } }).png().toBuffer();
  for (const base of ["https://cdn.example/catalog/", "http://127.0.0.1/private/"]) {
    const calls = [];
    const imported = importWebsiteProduct(url, { fetchResource: async (value, options) => {
      if (options.kind === "page") return { url: value, bytes: Buffer.from(`<base href="${base}">` + ld({ ...product, image: "shirt.png" })) };
      calls.push(value);
      if (value.startsWith("http://127.")) return fetchWebsiteResource(value, { ...options, request() { assert.fail("Private addresses must not be fetched"); } });
      return { url: value, bytes: png };
    } });
    if (base.startsWith("http://127.")) await assert.rejects(imported, /could not be downloaded or decoded/);
    else {
      const result = await imported;
      assert.equal(result.source.imageUrl, base + "shirt.png");
      assert.equal(result.source.url, url);
    }
    assert.deepEqual(calls, [base + "shirt.png"]);
  }
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

test("duplicate product blocks and same-page variants do not make a page ambiguous", () => {
  for (const records of [
    [product, { ...product }],
    [product, { ...product, image: "/alternate.png", description: "Another view of the same product" }],
    [{ ...product, sku: undefined }, { ...product, sku: undefined }],
    [{ ...product, url }, { ...product, url, sku: "SKU-2", color: "Cream" }],
    [{ ...product, url: "/products/shirt#blue" }, { ...product, "@id": `${url}#cream`, sku: "SKU-2", color: "Cream" }],
  ]) {
    const result = extractWebsiteProduct(records.map(ld).join(""), url);
    assert.equal(result.source.sku, records[0].sku || "");
    assert.equal(result.source.color, "Blue");
    assert.equal(result.imageUrls[0], "https://shop.example/shirt.png");
  }
});

test("tracking parameters and trailing slashes match the primary product ahead of recommendations", () => {
  for (const pageUrl of [url + "/", url + "?utm_source=email&utm_campaign=sale&fbclid=123", url + "/?gclid=123&msclkid=456"]) {
    const result = extractWebsiteProduct(ld([
      { ...product, name: "Recommended", url: "/recommended", image: "/recommended.png" },
      { ...product, url },
    ]), pageUrl);
    assert.equal(result.source.name, product.name);
    assert.equal(result.source.url, pageUrl, "retain the actual source URL");
    assert.deepEqual(result.imageUrls, ["https://shop.example/shirt.png"]);
  }
  const result = extractWebsiteProduct(ld([
    { ...product, url: url + "/?utm_source=email" }, { ...product, url },
  ]), "https://shop.example/alias");
  assert.equal(result.source.name, product.name, "equivalent record URLs also deduplicate");
});

test("same-site canonical and og:url metadata identify product pages served through aliases", () => {
  const pageUrl = "https://shop.example/collections/sale/products/shirt?campaign=summer";
  const records = ld([{ ...product, name: "Recommended", url: "/recommended" }, { ...product, url }]);
  for (const metadata of [
    '<link rel="alternate CANONICAL" href="/products/shirt/">',
    '<meta property="og:url" content="/products/shirt?utm_source=social">',
    '<link rel="canonical" href="javascript:invalid"><meta property="og:url" content="/products/shirt">',
  ]) {
    const result = extractWebsiteProduct(metadata + records, pageUrl);
    assert.equal(result.source.name, product.name);
    assert.equal(result.source.url, pageUrl);
  }
});

test("meaningful product selectors remain distinct and requested variants take priority over canonical metadata", () => {
  const selectedUrl = url + "?variant=blue&size=m";
  const records = ld([
    { ...product, name: "Canonical product", url },
    { ...product, name: "Red shirt", url: url + "?variant=red&size=m" },
    { ...product, url: selectedUrl },
  ]);
  const result = extractWebsiteProduct(`<link rel="canonical" href="${url}">` + records, url + "/?size=m&utm_source=email&variant=blue");
  assert.equal(result.source.name, product.name);
  assert.throws(() => extractWebsiteProduct(records, url + "?variant=green&size=m"), /several products/);
  assert.throws(() => extractWebsiteProduct(ld([
    { ...product, url: "/product?id=1" }, { ...product, url: "/product?id=2" },
  ]), "https://shop.example/product?utm_source=email"), /several products/);
});

test("unrelated pages and invalid or off-site canonical metadata remain ambiguous", () => {
  const records = ld([{ ...product, url }, { ...product, name: "Other", url: "/other" }]);
  for (const metadata of ["", '<link rel="canonical" href="javascript:invalid">', '<meta property="og:url" content="https://elsewhere.example/products/shirt">']) {
    assert.throws(() => extractWebsiteProduct(metadata + records, "https://shop.example/collection?utm_source=email"), /several products/);
  }
  assert.throws(() => extractWebsiteProduct('<link rel="canonical" href="https://elsewhere.example/products/shirt">'
    + ld([{ ...product, url: "https://elsewhere.example/products/shirt" }, { ...product, url: "/other" }]), "https://shop.example/collection"), /several products/);
});

test("URL-less variants with a shared product group retain one consistent primary record", () => {
  for (const group of [{ productGroupID: "shirt" }, { isVariantOf: { "@id": `${url}#group` } }]) {
    const result = extractWebsiteProduct(ld([
      { ...product, ...group },
      { ...product, ...group, color: "Cream", sku: "SKU-2", image: "/cream.png" },
    ]), url);
    assert.equal(result.source.color, "Blue");
    assert.equal(result.source.sku, "SKU-1");
    assert.deepEqual(result.imageUrls, ["https://shop.example/shirt.png"]);
  }
});

test("repeated matching primary records take precedence over recommendations; distinct products still fail", () => {
  const result = extractWebsiteProduct(ld([
    { ...product, name: "Recommended", url: "/recommended" },
    { ...product, url }, { ...product, url },
  ]), url);
  assert.equal(result.source.name, product.name);
  for (const records of [
    [{ ...product, url: "/one" }, { ...product, url: "/two" }],
    [product, { ...product, sku: "DIFFERENT", image: "/different.png" }],
    [{ ...product, productGroupID: "one" }, { ...product, productGroupID: "two" }],
  ]) assert.throws(() => extractWebsiteProduct(ld(records), url), /several products/);
});

test("structured image candidates cannot crowd out deduplicated social fallbacks", () => {
  const html = `<meta property="og:image" content="/social.png"><meta name="twitter:image" content="/social.png"><meta name="twitter:image:src" content="/twitter.png">`;
  assert.deepEqual(extractWebsiteProduct(html + ld({ ...product, image: ["/one.png", "/two.png", "/three.png", "/four.png"] }), url).imageUrls,
    ["https://shop.example/one.png", "https://shop.example/two.png", "https://shop.example/three.png", "https://shop.example/social.png", "https://shop.example/twitter.png"]);
  for (const image of ["data:image/png;base64,AAAA", { unsupported: true }, 42]) {
    assert.deepEqual(extractWebsiteProduct(html + ld({ ...product, image }), url).imageUrls,
      ["https://shop.example/social.png", "https://shop.example/twitter.png"]);
  }
});

test("import falls back to social images after private, unavailable and undecodable structured images", async () => {
  const png = await sharp({ create: { width: 80, height: 120, channels: 4, background: "#333333" } }).png().toBuffer();
  const html = ld({ ...product, image: ["http://127.0.0.1/private.png", "/missing.png", "/corrupt.png"] })
    + '<meta property="og:image" content="/social.png"><meta name="twitter:image" content="/twitter.png">';
  const calls = [];
  const result = await importWebsiteProduct(url, { fetchResource: async (value, options) => {
    if (options.kind === "page") return { url: value, bytes: Buffer.from(html) };
    calls.push(value);
    if (value.startsWith("http://127.")) return fetchWebsiteResource(value, { ...options, request() { assert.fail("Private addresses must not be fetched"); } });
    if (value.endsWith("missing.png") || value.endsWith("social.png")) throw new Error("Unavailable");
    return { url: value, bytes: value.endsWith("corrupt.png") ? Buffer.from("invalid image") : png };
  } });
  assert.deepEqual(calls, ["http://127.0.0.1/private.png", "https://shop.example/missing.png", "https://shop.example/corrupt.png", "https://shop.example/social.png", "https://shop.example/twitter.png"]);
  assert.equal(result.source.imageUrl, "https://shop.example/twitter.png");
  assert.equal(result.source.name, product.name);
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
