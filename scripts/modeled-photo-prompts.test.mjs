import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { buildModeledPhotoPrompt, buildModeledSettingPrompt } from "./modeled-photo-prompts.mjs";

const run = promisify(execFile);
const cli = new URL("./modeled-photo-prompt.mjs", import.meta.url);

test("the skill CLI renders exactly the same planning and image prompts as the app", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wardrobe-prompt-parity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "context.json");
  const context = { metadata: { name: "Blue wool cardigan", part: "upperbody", color: "#224466", tags: ["cable knit"] }, previousSetting: "A riverside footpath", recentSettings: ["A riverside footpath"], setting: "A brick passage with weathered doors and soft reflected light.", direction: "Keep the neckline visible" };
  const bytes = JSON.stringify(context);
  await writeFile(file, bytes);
  for (const [mode, builder] of [["plan", buildModeledSettingPrompt], ["image", buildModeledPhotoPrompt]]) {
    const { stdout, stderr } = await run(process.execPath, [cli.pathname, mode, file]);
    assert.equal(stdout, builder(context));
    assert.equal(stderr, "");
  }
  assert.equal(await readFile(file, "utf8"), bytes, "rendering does not alter the supplied context");
  await writeFile(file, JSON.stringify({ setting: " " }));
  await assert.rejects(run(process.execPath, [cli.pathname, "image", file]), /Scene planning/);
});

test("arbitrary invented settings are accepted and scene history is bounded without presets", () => {
  for (const setting of ["A quiet ferry terminal with blue tiles.", "A timber atrium under diffuse winter daylight."]) {
    assert.ok(buildModeledPhotoPrompt({ setting }).includes(`Scene/backdrop: ${setting}`));
  }
  for (const setting of [null, 3, "", " ", "x".repeat(601)]) assert.throws(() => buildModeledPhotoPrompt({ setting }), /Scene planning/);
  const recentSettings = Array.from({ length: 50 }, (_, index) => `Previously planned place ${index}`);
  const prompt = buildModeledSettingPrompt({ recentSettings: [...recentSettings, null, ""] });
  assert.deepEqual(JSON.parse(prompt.split("Context (JSON):\n")[1]).recentSettings, recentSettings.slice(-24));
});
