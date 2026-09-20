import assert from "node:assert/strict";
import test from "node:test";
import { reservePaidCall } from "../server/task-store.mjs";
import { withStorage } from "./storage-fs.mjs";

function harness(t, initial, env = {}) {
  for (const name of ["WARDROBE_DAILY_API_LIMIT", "WARDROBE_DAILY_IMAGE_API_LIMIT", "WARDROBE_DAILY_TEXT_API_LIMIT"]) {
    const previous = process.env[name];
    if (env[name] === undefined) delete process.env[name]; else process.env[name] = env[name];
    t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
  }
  let usage = initial;
  const store = {
    async readFile() { if (usage === undefined) throw Object.assign(new Error(), { code: "ENOENT" }); return JSON.stringify(usage); },
    async writeFile(file, bytes) { assert.equal(file, "/wardrobe-data/.api-usage.json"); usage = JSON.parse(bytes); },
  };
  return { reserve: kind => withStorage(store, () => reservePaidCall(kind)), usage: () => usage };
}
const day = () => new Date().toISOString().slice(0, 10);

test("40 image requests and 1000 text requests have independent daily limits", async t => {
  const h = harness(t);
  for (let i = 0; i < 40; i++) await h.reserve("image");
  await assert.rejects(h.reserve("image"), { status: 429, message: /40 image generation/ });
  for (let i = 0; i < 1000; i++) await h.reserve("text");
  await assert.rejects(h.reserve("text"), { status: 429, message: /1000 text\/vision/ });
  assert.deepEqual(h.usage(), { day: day(), calls: 40, textCalls: 1000 });
});

test("exhausted text allowance leaves images available", async t => {
  const h = harness(t, { day: day(), calls: 0, textCalls: 1000 });
  await assert.rejects(h.reserve("text"), { status: 429 });
  await h.reserve("image");
  assert.equal(h.usage().calls, 1);
});

test("legacy usage remains against images while text starts fresh; both reset on a new UTC day", async t => {
  const h = harness(t, { day: day(), calls: 40, extra: "preserved" });
  await assert.rejects(h.reserve("image"), { status: 429 });
  await h.reserve("text");
  assert.deepEqual(h.usage(), { day: day(), calls: 40, textCalls: 1, extra: "preserved" });
  const old = harness(t, { day: "2001-01-01", calls: 99, textCalls: 2000 });
  await old.reserve("image");
  await old.reserve("text");
  assert.deepEqual(old.usage(), { day: day(), calls: 1, textCalls: 1 });
});

for (const [env, image, textLimit] of [
  [{ WARDROBE_DAILY_API_LIMIT: "2" }, 2, 1000],
  [{ WARDROBE_DAILY_API_LIMIT: "2", WARDROBE_DAILY_IMAGE_API_LIMIT: "3", WARDROBE_DAILY_TEXT_API_LIMIT: "5" }, 3, 5],
  [{ WARDROBE_DAILY_IMAGE_API_LIMIT: "-1", WARDROBE_DAILY_TEXT_API_LIMIT: "1.5" }, 40, 1000],
]) test(`configured quotas and legacy image fallback: ${JSON.stringify(env)}`, async t => {
  const h = harness(t, { day: day(), calls: image - 1, textCalls: textLimit - 1 }, env);
  await h.reserve("image"); await h.reserve("text");
  await assert.rejects(h.reserve("image"), { status: 429 });
  await assert.rejects(h.reserve("text"), { status: 429 });
});

test("unknown categories and corrupt counters fail closed", async t => {
  const h = harness(t, { day: day(), calls: -1, textCalls: "0" });
  await assert.rejects(h.reserve("other"), /Unknown paid request kind/);
  await assert.rejects(h.reserve("image"), /Invalid daily API usage/);
  await assert.rejects(h.reserve("text"), /Invalid daily API usage/);
});
