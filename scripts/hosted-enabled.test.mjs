import test from "node:test";
import assert from "node:assert/strict";
import { hostedEnabled } from "../server/hosted-enabled.mjs";

test("hosted API requires an explicit environment gate", () => {
  assert.equal(hostedEnabled({ VERCEL_ENV: "production" }), false);
  assert.equal(hostedEnabled({ VERCEL_ENV: "preview", WARDROBE_PREVIEW_ENABLED: "1" }), false);
  assert.equal(hostedEnabled({ VERCEL_ENV: "development", WARDROBE_HOSTED_ENABLED: "1", WARDROBE_PREVIEW_ENABLED: "1" }), false);
  assert.equal(hostedEnabled({ VERCEL_ENV: "production", WARDROBE_HOSTED_ENABLED: "1" }), true);
  assert.equal(hostedEnabled({ VERCEL_ENV: "preview", WARDROBE_HOSTED_ENABLED: "1" }), false);
  const preview = {
    VERCEL_ENV: "preview", WARDROBE_HOSTED_ENABLED: "1", WARDROBE_PREVIEW_ENABLED: "1",
    NEON_PROJECT_ID: "preview-db", WARDROBE_PREVIEW_NEON_PROJECT_ID: "preview-db",
    BLOB_STORE_ID: "preview-blob", WARDROBE_PREVIEW_BLOB_STORE_ID: "preview-blob",
  };
  assert.equal(hostedEnabled(preview), true);
  assert.equal(hostedEnabled({ ...preview, NEON_PROJECT_ID: "production-db" }), false);
  assert.equal(hostedEnabled({ ...preview, BLOB_STORE_ID: "production-blob" }), false);
  assert.equal(hostedEnabled({ ...preview, WARDROBE_PREVIEW_BLOB_STORE_ID: "" }), false);
});
