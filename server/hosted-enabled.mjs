export function hostedEnabled(env = process.env) {
  if (env.WARDROBE_HOSTED_ENABLED !== "1") return false;
  if (env.VERCEL_ENV === "production") return true;
  return env.VERCEL_ENV === "preview" && env.WARDROBE_PREVIEW_ENABLED === "1";
}
