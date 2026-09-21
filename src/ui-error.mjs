// Keep known infrastructure failures useful in the UI without exposing server paths.
// Unrecognised messages pass through so specific recovery guidance is preserved.
export function uiErrorMessage(error, fallback = "Something went wrong. Please try again.") {
  const message = typeof error === "string" ? error : error?.message;
  if (typeof message !== "string" || !message.trim()) return fallback;
  if (/Another wardrobe operation is still running|\bEBUSY\b|Another Wardrobe outfit writer|Outfit writer ownership changed/i.test(message)) {
    return "Your wardrobe is finishing another update. Wait a moment, then try again.";
  }
  if (/\bESTALE\b|active cloud storage lease is required/i.test(message)) {
    return "This update was interrupted. Refresh to check the latest result before trying again.";
  }
  if (/\/wardrobe-data(?:\/|\b)|\b(?:ENOENT|EACCES|EROFS|ENOTDIR|EPERM)\b/.test(message)) {
    return "The saved item or image is unavailable. Refresh and try again. If it still fails, the wardrobe service needs attention.";
  }
  if (/OPENAI_API_KEY|Setup required: add|Durable generation scheduling is not configured/i.test(message)) {
    return "Image creation needs to be set up before you can continue. Refresh after the wardrobe service has been updated.";
  }
  if (/^Internal server error$/i.test(message)) {
    return "The wardrobe service couldn't complete this request. Please try again.";
  }
  return message.replace(/\bmodeled\b/gi, (word) => word[0] === "M" ? "Modelled" : "modelled");
}
