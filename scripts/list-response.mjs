import { createHash } from "node:crypto";
import { matchesETag } from "./display-image.mjs";

// Lists are polled. An unchanged list answers 304 with no body, so the browser
// keeps the copy it already rendered. Nothing is stored: it stays no-store.
export function sendListJson(req, res, value) {
  const body = JSON.stringify(value);
  const etag = `"list-${createHash("sha256").update(body).digest("hex").slice(0, 32)}"`;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("ETag", etag);
  if (matchesETag(req.headers["if-none-match"], etag)) {
    res.statusCode = 304;
    res.end();
    return;
  }
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(body);
}
