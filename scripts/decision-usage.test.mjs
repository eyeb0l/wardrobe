import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { decide, hashEvidence } from "./decisions.mjs";
import { decisionsResponse } from "./test-helpers/decisions-response.mjs";
import { withStorage } from "./storage-fs.mjs";
import { normalizeDecisionUsage, decisionUsageLog, readDecisionUsage, summarizeDecisionUsage,
  decisionUsageCost, DECISIONS_LUNA_PRICING, defaultDecisionPricing, validateDecisionPricing } from "./decision-usage.mjs";

const env = { OPENAI_API_KEY: "test-private-key", WARDROBE_DECISIONS_ENABLED: "1" };
const options = extra => ({ env, namespace: randomUUID(), input: "PRIVATE EVIDENCE", questions: [{ name: "detail", type: "choice", instructions: "PRIVATE INSTRUCTIONS",
  choices: [{ value: "clear" }, { value: "concern" }, { value: "unknown" }] }], ...extra });
const fullUsage = { input_tokens: 100, input_tokens_details: { cached_tokens: 20, cache_write_tokens: 30 }, output_tokens: 10,
  output_tokens_details: { reasoning_tokens: 5 }, total_tokens: 110, compute_units: 7, private_field: "PRIVATE VALUE" };
async function directory(t) { const dir = await fs.mkdtemp(path.join(os.tmpdir(), "decision-usage-")); t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir; }
const transport = async (_, init) => Response.json({ ...decisionsResponse(JSON.parse(init.body)), usage: fullUsage }, { headers: { "x-request-id": "req_test123" } });

test("all usage fields survive sanitization while missing, negative and inconsistent counters stay unknown", () => {
  assert.deepEqual(normalizeDecisionUsage(fullUsage), { inputTokens: 100, cachedInputTokens: 20, cacheWriteTokens: 30, outputTokens: 10, reasoningTokens: 5, totalTokens: 110, computeUnits: 7 });
  assert.ok(Object.values(normalizeDecisionUsage(undefined)).every(value => value === null));
  const broken = normalizeDecisionUsage({ input_tokens: 1, input_tokens_details: { cached_tokens: 2, cache_write_tokens: 3 }, output_tokens: 4, total_tokens: 0,
    output_tokens_details: { reasoning_tokens: 5 }, compute_units: -1 });
  assert.deepEqual(broken, { inputTokens: 1, cachedInputTokens: null, cacheWriteTokens: null, outputTokens: 4, reasoningTokens: null, totalTokens: null, computeUnits: null });
});

test("request hashes and byte counts match the exact dispatched image evidence", async () => {
  const records = [];
  const config = options({ version: 3, input: [{ role: "user", content: [
    { type: "input_text", text: 'Navy jacket: "silk"? £80\nCheck the cuffs.' },
    { type: "input_image", image_url: "data:image/png;base64,dGVzdA==" },
  ] }], usageLog: async record => records.push(record), fetch: async (_, init) => {
    const body = JSON.parse(init.body);
    assert.equal(records[0].requestHash, hashEvidence([3, body]));
    assert.equal(records[0].bodyBytes, Buffer.byteLength(init.body));
    return Response.json(decisionsResponse(body));
  } });
  const first = await decide(config);
  assert.equal((await decide(config)).cached, true);
  assert.ok(records.every(record => record.requestHash === records[0].requestHash));
  assert.ok(records.every(record => record.attemptId === first.attemptId));
});

test("durable log writes dispatch intent, links shared/cache results and counts provider usage once", async t => {
  const dir = await directory(t), log = decisionUsageLog(dir, "outfit-review");
  let release, calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const config = options({ usageLog: log, fetch: async (...args) => {
    calls++; assert.equal((await readDecisionUsage(dir))[0].dispatchState, "unknown");
    await gate; return transport(...args);
  } });
  const first = decide(config), shared = decide(config);
  release();
  const [a, b] = await Promise.all([first, shared]);
  const cached = await decide(config);
  assert.equal(calls, 1); assert.equal(b.cached, true); assert.equal(cached.cached, true);
  assert.equal(b.attemptId, a.attemptId); assert.ok(Object.values(b.usage).every(value => value === 0));
  const records = await readDecisionUsage(dir);
  assert.equal(records.length, 3); assert.ok(records.every(record => record.attemptId === a.attemptId));
  assert.equal((await fs.stat(path.join(dir, "decision-usage"))).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(dir, "decision-usage", `${records[0].id}.json`))).mode & 0o777, 0o600);
  const provider = records.find(record => record.source === "provider");
  assert.equal(provider.httpStatus, 200); assert.equal(provider.requestId, "req_test123");
  assert.equal(provider.dispatchState, "sent"); assert.equal(provider.outcome, "succeeded");
  for (const privateValue of ["PRIVATE", "test-private-key", "INSTRUCTIONS", "https://", "image_url"]) assert.ok(!JSON.stringify(records).includes(privateValue));
  const report = summarizeDecisionUsage(records, DECISIONS_LUNA_PRICING);
  assert.equal(report.providerCalls, 1); assert.equal(report.cacheHits, 1); assert.equal(report.sharedCalls, 1);
  assert.equal(report.usage.outputTokens.observed, 10); assert.equal(report.usage.cachedInputTokens.observed, 20);
  assert.equal(report.cost.estimatedLowerUsd, .00001); assert.equal(report.cost.estimatedUpperUsd, .00002); assert.equal(report.cost.actualBilledUsd, null);
});

test("quota blocks, HTTP errors and timeouts retain distinct dispatch and unknown-cost states", async t => {
  const dir = await directory(t), usageLog = decisionUsageLog(dir, "preflight");
  await assert.rejects(decide(options({ usageLog, beforePaidCall: async () => { throw Object.assign(new Error("PRIVATE quota"), { status: 429 }); }, fetch: transport })), { status: 429 });
  await assert.rejects(decide(options({ usageLog, fetch: async () => new Response("PRIVATE error", { status: 401, headers: { "x-request-id": env.OPENAI_API_KEY } }) })), { status: 502 });
  await assert.rejects(decide(options({ usageLog, timeoutMs: 100, fetch: async () => new Promise(() => {}) })), { status: 504 });
  const records = await readDecisionUsage(dir), report = summarizeDecisionUsage(records, DECISIONS_LUNA_PRICING);
  assert.equal(report.blocked, 1); assert.equal(report.providerCalls, 2); assert.equal(report.failed, 2);
  assert.equal(report.usage.inputTokens.unknownCalls, 2); assert.equal(report.cost.unknownCalls, 2); assert.equal(report.cost.complete, false);
  assert.equal(records.find(record => record.httpStatus === 401).requestId, null);
  assert.ok(!JSON.stringify(records).includes("PRIVATE"));
});

test("partial refusals and malformed answers retain returned billing counters", async t => {
  const dir = await directory(t), usageLog = decisionUsageLog(dir, "outfit-review");
  const refusal = await decide(options({ usageLog, fetch: async (_, init) => {
    const body = JSON.parse(init.body); return Response.json({ model: body.model, usage: fullUsage, answers: [{ name: "detail", type: "refusal", private_field: "PRIVATE" }] });
  } }));
  assert.equal(refusal.answers[0].type, "refusal");
  await assert.rejects(decide(options({ usageLog, fetch: async (_, init) => {
    const value = { ...decisionsResponse(JSON.parse(init.body)), usage: fullUsage }; value.answers[0].choice = "invented"; return Response.json(value);
  } })), { status: 502 });
  const records = await readDecisionUsage(dir), report = summarizeDecisionUsage(records, DECISIONS_LUNA_PRICING);
  assert.equal(report.refused, 1); assert.equal(report.failed, 1); assert.equal(report.refusals, 1); assert.equal(report.usage.inputTokens.observed, 200);
  assert.equal(records.find(record => record.outcome === "failed").failure, "invalid-answer");
});

test("usage persistence outages do not lose a successful result or dispatch again", async t => {
  const dir = await directory(t); t.mock.method(console, "warn", () => {});
  let calls = 0;
  await withStorage({ ...fs, mkdir: async () => { throw new Error("PRIVATE database URL"); } }, async () => {
    const config = options({ usageLog: decisionUsageLog(dir, "preflight"), fetch: async (...args) => { calls++; return transport(...args); } });
    assert.equal((await decide(config)).answers[0].choice, "clear");
    assert.equal((await decide(config)).cached, true);
  });
  assert.equal(calls, 1); assert.deepEqual(await readDecisionUsage(dir), []);
});

test("evaluation bypass disables cache reuse without changing normal request semantics", async () => {
  let calls = 0;
  const config = options({ cacheMode: "bypass", fetch: async (...args) => { calls++; return transport(...args); } });
  assert.equal((await decide(config)).cached, false); assert.equal((await decide(config)).cached, false); assert.equal(calls, 2);
  await assert.rejects(decide({ ...config, cacheMode: "invalid" }), { status: 422 });
});

test("pricing uses the Decisions endpoint's input-only range, never assumes a custom provider's rates", () => {
  const usage = normalizeDecisionUsage({ input_tokens: 1000 });
  assert.deepEqual(decisionUsageCost(usage, DECISIONS_LUNA_PRICING), { lowerUsd: .0001, upperUsd: .0002 });
  assert.equal(decisionUsageCost(normalizeDecisionUsage(null), DECISIONS_LUNA_PRICING), null);
  assert.equal(defaultDecisionPricing("gpt-6-luna", "https://custom.invalid/v1"), null);
  assert.equal(defaultDecisionPricing("other-model"), null);
  assert.deepEqual(validateDecisionPricing(DECISIONS_LUNA_PRICING, "gpt-6-luna"), DECISIONS_LUNA_PRICING);
  assert.throws(() => validateDecisionPricing(DECISIONS_LUNA_PRICING, "other-model"));
  const report = summarizeDecisionUsage([{ source: "provider", dispatchState: "sent", outcome: "succeeded", model: "gpt-6-luna", provider: "custom.invalid", usage }], DECISIONS_LUNA_PRICING);
  assert.equal(report.cost.unknownCalls, 1);
  const tokenPricing = validateDecisionPricing({ version: 1, model: "test", basis: "tokens", verifiedAt: "2026-10-06", source: "https://developers.openai.com/api/docs/pricing",
    maxInputTokens: 1000, rates: { input: 1, cachedInput: .1, cacheWrite: 2, output: 5 } }, "test");
  assert.deepEqual(decisionUsageCost(normalizeDecisionUsage({ input_tokens: 1000, output_tokens: 0 }), tokenPricing), { lowerUsd: .0001, upperUsd: .002 });
  assert.equal(decisionUsageCost(normalizeDecisionUsage({ input_tokens: 1001, output_tokens: 0 }), tokenPricing), null);
});

test("corrupt usage records fail visibly rather than disappearing from the denominator", async t => {
  const dir = await directory(t); await fs.mkdir(path.join(dir, "decision-usage"));
  await fs.writeFile(path.join(dir, "decision-usage", `${randomUUID()}.json`), JSON.stringify({ version: 1 }));
  await assert.rejects(readDecisionUsage(dir), /Decision usage identifier|Invalid decision usage/);
});
