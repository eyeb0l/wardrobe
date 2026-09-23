import test from "node:test";
import assert from "node:assert/strict";
import { hostedEnabled } from "../server/hosted-enabled.mjs";

test("hosted API requires an explicit environment gate", () => {
  assert.equal(hostedEnabled({ VERCEL_ENV: "production" }), false);
  assert.equal(hostedEnabled({ VERCEL_ENV: "preview", WARDROBE_PREVIEW_ENABLED: "1" }), false);
  assert.equal(hostedEnabled({ VERCEL_ENV: "development", WARDROBE_HOSTED_ENABLED: "1", WARDROBE_PREVIEW_ENABLED: "1" }), false);
  assert.equal(hostedEnabled({ VERCEL_ENV: "production", WARDROBE_HOSTED_ENABLED: "1" }), true);
  assert.equal(hostedEnabled({ VERCEL_ENV: "preview", WARDROBE_HOSTED_ENABLED: "1" }), false);
  assert.equal(hostedEnabled({ VERCEL_ENV: "preview", WARDROBE_HOSTED_ENABLED: "1", WARDROBE_PREVIEW_ENABLED: "1" }), true);
});
