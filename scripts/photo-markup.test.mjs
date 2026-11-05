import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { imageComplexity, moderationDetails, providerAdvice } from "./image-request.mjs";
import { prepareMarkup } from "./photo-markup.mjs";

const SIZE = { width: 200, height: 100 };
const photo = () => sharp({ create: { ...SIZE, channels: 3, background: "#888888" } }).png().toBuffer();
const layer = async (svg, size = SIZE) => `data:image/png;base64,${(await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}">${svg}</svg>`)).png().toBuffer()).toString("base64")}`;
const circle = '<circle cx="50%" cy="50%" r="20%" fill="none" stroke="#ff0000" stroke-width="4"/>';
const settings = values => (name, fallback = "") => values[name] || fallback;

test("marks are scaled to the exact photo and stay transparent", async () => {
  const output = await prepareMarkup(await layer(circle, { width: 100, height: 50 }), await photo());
  const metadata = await sharp(output).metadata();
  assert.deepEqual([metadata.format, metadata.width, metadata.height, metadata.hasAlpha], ["png", 200, 100, true]);
  const { data } = await sharp(output).raw().toBuffer({ resolveWithObject: true });
  assert.equal(data[3], 0, "unmarked pixels remain transparent");
});

test("marks use the photo's displayed dimensions after orientation", async () => {
  const sideways = await sharp(await photo()).withMetadata({ orientation: 6 }).jpeg().toBuffer();
  const metadata = await sharp(await prepareMarkup(await layer(circle, { width: 100, height: 200 }), sideways)).metadata();
  assert.deepEqual([metadata.width, metadata.height], [100, 200]);
});

test("invalid marks are rejected before any paid request", async () => {
  const base = await photo();
  const jpeg = `data:image/jpeg;base64,${(await sharp(base).jpeg().toBuffer()).toString("base64")}`;
  const opaque = `data:image/png;base64,${base.toString("base64")}`;
  for (const [input, message] of [
    [undefined, /transparent PNG/], [12, /transparent PNG/], [jpeg, /transparent PNG/], [opaque, /transparent PNG/],
    ["data:image/png;base64,bm90IGFuIGltYWdl", /could not be read/],
    [await layer(""), /Mark the area/],
    [await layer('<rect width="100%" height="100%" fill="#ff0000"/>'), /Leave part/],
    [await layer(circle, { width: 100, height: 100 }), /don't match/],
    [`data:image/png;base64,${"A".repeat(3 * 1024 * 1024)}`, /2 MB/],
  ]) await assert.rejects(prepareMarkup(input, base), error => error.status >= 400 && message.test(error.message));
});

test("complexity is sent only to 2.6 models and marked edits default to low", () => {
  const sunburst = "gpt-image-2.6-sunburst";
  assert.equal(imageComplexity(settings({}), "garment", sunburst), null, "the model default applies unless configured");
  assert.equal(imageComplexity(settings({ OPENAI_IMAGE_COMPLEXITY: "medium" }), "garment", sunburst), "medium");
  assert.equal(imageComplexity(settings({ OPENAI_IMAGE_COMPLEXITY: "medium", OPENAI_GARMENT_COMPLEXITY: "low" }), "garment", sunburst), "low");
  assert.equal(imageComplexity(settings({ OPENAI_GARMENT_COMPLEXITY: "low" }), "modeled", sunburst), null);
  assert.equal(imageComplexity(settings({ OPENAI_MODELED_COMPLEXITY: "high" }), "modeled", "gpt-image-2.6-flare"), "high");
  assert.equal(imageComplexity(settings({ OPENAI_IMAGE_COMPLEXITY: "high" }), "modeled", sunburst, { markup: true }), "low");
  assert.equal(imageComplexity(settings({ OPENAI_MARKUP_COMPLEXITY: "medium" }), "modeled", sunburst, { markup: true }), "medium");
  for (const model of ["gpt-image-2.5-sunburst", "gpt-image-2", "gpt-image-2.60"]) {
    assert.equal(imageComplexity(settings({ OPENAI_IMAGE_COMPLEXITY: "low" }), "garment", model), null);
    assert.equal(imageComplexity(settings({}), "modeled", model, { markup: true }), null);
  }
  assert.throws(() => imageComplexity(settings({ OPENAI_IMAGE_COMPLEXITY: "extreme" }), "garment", sunburst), /low, medium or high/);
});

test("moderation details are bounded and read from either documented location", () => {
  const details = { moderation_stage: "output", categories: ["sexual", "sexual", "self-harm", "https://user:secret@x.invalid", 3] };
  for (const result of [{ error: { moderation_details: details } }, { moderation_details: details }]) {
    assert.deepEqual(moderationDetails(result), { stage: "output", categories: ["sexual", "self-harm"] });
  }
  assert.deepEqual(moderationDetails({ error: { moderation_details: { moderation_stage: "private prompt" } } }), { stage: null, categories: [] });
  assert.deepEqual(moderationDetails(null), { stage: null, categories: [] });
});

test("refusal advice names the blocked stage and never reflects provider text", () => {
  const blocked = stage => ({ error: { code: "moderation_blocked", message: "PRIVATE PROMPT", moderation_details: stage && { moderation_stage: stage } } });
  assert.match(providerAdvice(400, blocked("input")), /blocked the prompt or reference images/);
  assert.match(providerAdvice(400, blocked("output")), /blocked the generated image/);
  for (const result of [blocked("unknown"), blocked()]) assert.match(providerAdvice(400, result), /refused by the provider's safety checks/);
  assert.doesNotMatch(providerAdvice(400, blocked("input")), /PRIVATE/);
  assert.match(providerAdvice(429, {}), /quota or rate limit/);
  assert.match(providerAdvice(400, { error: { code: "invalid_value" } }), /configured model/);
});
