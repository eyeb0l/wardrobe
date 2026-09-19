import { readFile } from "node:fs/promises";
import { buildModeledPhotoPrompt, buildModeledSettingPrompt } from "./modeled-photo-prompts.mjs";

// Pure prompt rendering for the agent skill: no network, credentials or writes.
try {
  const [mode, input, ...extra] = process.argv.slice(2);
  if (!["plan", "image"].includes(mode) || !input || extra.length) {
    throw new Error("Usage: node scripts/modeled-photo-prompt.mjs <plan|image> <context.json>");
  }
  const context = JSON.parse(await readFile(input, "utf8"));
  if (!context || typeof context !== "object" || Array.isArray(context)) throw new Error("Context must be a JSON object");
  process.stdout.write(mode === "plan" ? buildModeledSettingPrompt(context) : buildModeledPhotoPrompt(context));
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
