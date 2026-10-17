import test from "node:test";
import assert from "node:assert/strict";
import { assertSameOriginMutation } from "./request-guards.mjs";

const request = (headers, method = "POST", encrypted = false) => ({ method, headers: { host: "wardrobe.test", ...headers }, socket: { encrypted } });
const status = (req, options) => { try { assertSameOriginMutation(req, options); return 200; } catch (error) { return error.status; } };

test("mutations must come from this exact origin", () => {
  const json = { "content-type": "application/json" };
  assert.equal(status(request({ ...json, origin: "http://wardrobe.test", "sec-fetch-site": "same-origin" })), 200);
  assert.equal(status(request({ ...json, origin: "https://wardrobe.test", "x-forwarded-proto": "https,http" })), 200);
  assert.equal(status(request({ ...json, origin: "https://wardrobe.test" }, "POST", true)), 200);
  assert.equal(status(request(json)), 200, "non-browser clients without Origin remain allowed behind authentication");
  for (const headers of [
    { "sec-fetch-site": "same-site" }, { "sec-fetch-site": "cross-site" },
    { origin: "https://wardrobe.test" }, { origin: "http://other.test" }, { origin: "null" }, { origin: "ftp://wardrobe.test" },
    { origin: "http://wardrobe.test", "x-forwarded-proto": "https" },
  ]) assert.equal(status(request({ ...json, ...headers })), 403, JSON.stringify(headers));
});

test("JSON bodies are required where declared and never form-encodable", () => {
  assert.equal(status(request({})), 200, "a bodiless action needs no content type");
  assert.equal(status(request({}), { json: "required" }), 415);
  for (const headers of [{ "content-type": "text/plain" }, { "content-type": "application/jsonp" }, { "content-length": "2" }, { "transfer-encoding": "chunked" }]) {
    assert.equal(status(request(headers)), 415, JSON.stringify(headers));
  }
  assert.equal(status(request({ "content-type": "application/json; charset=utf-8" }), { json: "required" }), 200);
  assert.equal(status(request({ origin: "https://evil.test", "content-type": "text/plain" }, "GET")), 200, "reads are not mutations");
});
