// Options and failure handling shared by every /images/edits request, so the
// import and outfit pipelines cannot drift apart.
export const IMAGE_MODERATION = "low";

const COMPLEXITIES = new Set(["low", "medium", "high"]);
const MODERATION_STAGES = new Set(["input", "output", "unknown"]);
const LABEL = /^[a-zA-Z0-9_.:-]{1,100}$/;

// GPT Image 2.5 rejects this field with HTTP 400, so an evaluation can keep a
// complexity configured while switching the model back to its baseline.
const supportsComplexity = model => /^gpt-image-2\.6(?:-|$)/.test(model);

// Marked edits are focused by definition, so they default to low complexity
// and do not inherit the setting used for whole new images.
export function imageComplexity(setting, stage, model, { markup = false } = {}) {
  const value = markup ? setting("OPENAI_MARKUP_COMPLEXITY", "low")
    : setting(stage === "garment" ? "OPENAI_GARMENT_COMPLEXITY" : "OPENAI_MODELED_COMPLEXITY", setting("OPENAI_IMAGE_COMPLEXITY"));
  if (!value) return null;
  if (!COMPLEXITIES.has(value)) throw Object.assign(new Error("Image complexity must be low, medium or high. Check the OPENAI_*_COMPLEXITY settings."), { status: 503 });
  return supportsComplexity(model) ? value : null;
}

export function moderationDetails(result) {
  // The guide's JSON nests this under error, but some of its samples read it from the top level.
  const details = result?.error?.moderation_details ?? result?.moderation_details;
  const categories = Array.isArray(details?.categories) ? details.categories.filter(value => typeof value === "string" && LABEL.test(value)) : [];
  return { stage: MODERATION_STAGES.has(details?.moderation_stage) ? details.moderation_stage : null, categories: [...new Set(categories)].slice(0, 8) };
}

// Never reflect provider messages, which can include credentials or URLs. A
// moderation refusal is identified by its error code, never its message text.
export function providerAdvice(status, result) {
  if (result?.error?.code === "moderation_blocked") {
    const blocked = { input: "the prompt or reference images", output: "the generated image" }[moderationDetails(result).stage];
    return blocked ? `The provider's safety checks blocked ${blocked}. Adjust the direction or upload a photo instead.`
      : "The request was refused by the provider's safety checks. Adjust the direction or upload a photo instead.";
  }
  return [401, 403].includes(status) ? "Check the configured API key and model access."
    : status === 429 ? "Check the API quota or rate limit, then retry."
      : status === 400 || status === 404 ? "Check the configured model and API base URL support this request." : "The API could not complete the request. Retry when it is available.";
}
