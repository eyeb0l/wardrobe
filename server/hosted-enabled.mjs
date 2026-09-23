export function hostedEnabled(env = process.env) {
  if (env.WARDROBE_HOSTED_ENABLED !== "1") return false;
  if (env.VERCEL_ENV === "production") return true;
  return env.VERCEL_ENV === "preview"
    && env.WARDROBE_PREVIEW_ENABLED === "1"
    && Boolean(env.WARDROBE_PREVIEW_NEON_PROJECT_ID)
    && env.NEON_PROJECT_ID === env.WARDROBE_PREVIEW_NEON_PROJECT_ID
    && Boolean(env.WARDROBE_PREVIEW_BLOB_STORE_ID)
    && env.BLOB_STORE_ID === env.WARDROBE_PREVIEW_BLOB_STORE_ID;
}
