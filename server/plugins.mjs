import { wardrobeImportApi } from "../scripts/import-job-api.mjs";
import { wardrobeOutfitApi } from "../scripts/outfit-api.mjs";
import { wardrobeShoppingApi } from "../scripts/shopping-api.mjs";

export const DATA_ROOT = "/wardrobe-data";

export async function createPlugin(kind, { readOnly = false, scheduleTask, beforePaidCall } = {}) {
  const factory = { import: wardrobeImportApi, outfit: wardrobeOutfitApi, shopping: wardrobeShoppingApi }[kind];
  if (!factory) throw new Error("Unknown API kind");
  const plugin = factory({
    serverless: true, readOnly, scheduleTask, beforePaidCall,
    timeoutMs: 210_000, requestTimeoutMs: 210_000,
    env: { ...process.env, WARDROBE_DATA_DIR: DATA_ROOT, WARDROBE_MODEL_REFERENCE: `${DATA_ROOT}/model-reference.png` },
  });
  await plugin.configResolved({ root: process.cwd() });
  return plugin;
}
