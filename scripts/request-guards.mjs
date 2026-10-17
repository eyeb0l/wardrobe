// One browser-mutation guard for every API. Vercel Authentication and the local
// dev server both rely on cookies or localhost reachability, so a mutation must
// come from this exact origin: no cross-site or same-site (sibling subdomain)
// requests, and no form-encodable bodies that skip a CORS preflight.
const fail = (message, status) => Object.assign(new Error(message), { status });
const JSON_TYPE = /^application\/json(?:\s*;|$)/i;

// `json: "required"` demands a JSON content type. `json: "if-body"` accepts a
// bodiless request without one, but never an undeclared or non-JSON body.
export function assertSameOriginMutation(req, { json = "if-body" } = {}) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return;
  const headers = req.headers || {};
  const site = headers["sec-fetch-site"];
  if (site && !["same-origin", "none"].includes(site)) throw fail("Cross-site requests are not allowed", 403);
  if (headers.origin) {
    let origin;
    try { origin = new URL(headers.origin); } catch { /* Opaque or invalid origins are rejected below. */ }
    const protocol = String(headers["x-forwarded-proto"] || (req.socket?.encrypted ? "https" : "http")).split(",")[0].trim();
    if (!origin || !["http:", "https:"].includes(origin.protocol) || origin.origin !== `${protocol}://${headers.host}`) {
      throw fail("Cross-site requests are not allowed", 403);
    }
  }
  const type = headers["content-type"];
  if (type ? !JSON_TYPE.test(type) : json === "required" || Number(headers["content-length"]) > 0 || headers["transfer-encoding"]) {
    throw fail("Expected an application/json request body", 415);
  }
}
