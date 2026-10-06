import { randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir, readFile, readdir } from "./storage-fs.mjs";
import { atomicJson } from "./outfit-storage.mjs";

const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const token = value => typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,100}$/.test(value) ? value : null;
const fields = ["inputTokens", "cachedInputTokens", "cacheWriteTokens", "outputTokens", "reasoningTokens", "totalTokens", "computeUnits"];
export const emptyDecisionUsage = () => Object.fromEntries(fields.map(field => [field, 0]));

export const DECISIONS_LUNA_PRICING = Object.freeze({ version: 1, model: "gpt-6-luna", provider: "api.openai.com", basis: "input-only", verifiedAt: "2026-10-06",
  source: "https://developers.openai.com/api/docs/guides/decisions#pricing-and-availability",
  // Global endpoint only. Retain a short/long context range rather than infer
  // an undocumented threshold. These are endpoint-specific, not Responses rates.
  rates: Object.freeze({ input: .10, maximumInput: .20 }) });

export function defaultDecisionPricing(model, baseUrl = "https://api.openai.com/v1") {
  return model === "gpt-6-luna" && baseUrl.replace(/\/+$/, "") === "https://api.openai.com/v1" ? structuredClone(DECISIONS_LUNA_PRICING) : null;
}

// Keep every documented counter, but never turn missing or invalid billing
// information into zero. The allowlist excludes arbitrary provider fields.
export function normalizeDecisionUsage(value) {
  const usage = {
    inputTokens: count(value?.input_tokens), cachedInputTokens: count(value?.input_tokens_details?.cached_tokens),
    cacheWriteTokens: count(value?.input_tokens_details?.cache_write_tokens), outputTokens: count(value?.output_tokens),
    reasoningTokens: count(value?.output_tokens_details?.reasoning_tokens), totalTokens: count(value?.total_tokens),
    computeUnits: count(value?.compute_units),
  };
  if (usage.inputTokens !== null && ((usage.cachedInputTokens ?? 0) + (usage.cacheWriteTokens ?? 0) > usage.inputTokens)) {
    usage.cachedInputTokens = null; usage.cacheWriteTokens = null;
  }
  if (usage.outputTokens !== null && usage.reasoningTokens > usage.outputTokens) usage.reasoningTokens = null;
  if (usage.inputTokens !== null && usage.outputTokens !== null && usage.totalTokens !== usage.inputTokens + usage.outputTokens) usage.totalTokens = null;
  return usage;
}

export function validateDecisionPricing(pricing, model) {
  if (!pricing || pricing.version !== 1 || pricing.model !== model || !Number.isFinite(Date.parse(pricing.verifiedAt))
    || typeof pricing.source !== "string" || !/^https:\/\/(?:developers\.openai\.com|platform\.openai\.com)\//.test(pricing.source)
    || !["input-only", "tokens", "compute-units"].includes(pricing.basis)) throw new Error("Pricing must identify the exact model, billing basis, verification date and official source.");
  const names = pricing.basis === "input-only" ? ["input", "maximumInput"] : pricing.basis === "tokens" ? ["input", "cachedInput", "cacheWrite", "output"] : ["computeUnit"];
  if (names.some(name => typeof pricing.rates?.[name] !== "number" || !Number.isFinite(pricing.rates[name]) || pricing.rates[name] < 0)
    || (pricing.basis === "tokens" && !Number.isSafeInteger(pricing.maxInputTokens))) throw new Error("Pricing needs complete nonnegative rates and a token context bound.");
  if (pricing.basis === "tokens" && pricing.maxInputTokens < 1) throw new Error("Pricing needs a positive token context bound.");
  if (pricing.basis === "input-only" && pricing.rates.maximumInput < pricing.rates.input) throw new Error("The maximum input price cannot be below the base input price.");
  if (pricing.provider !== undefined && (typeof pricing.provider !== "string" || !/^[a-z0-9.-]{1,253}$/.test(pricing.provider))) throw new Error("Pricing provider must be a hostname.");
  return { version: 1, model, ...(pricing.provider ? { provider: pricing.provider } : {}), verifiedAt: pricing.verifiedAt, source: pricing.source, basis: pricing.basis,
    ...(pricing.basis === "tokens" ? { maxInputTokens: pricing.maxInputTokens } : {}), rates: Object.fromEntries(names.map(name => [name, pricing.rates[name]])) };
}

// Rates are supplied and frozen by the evaluator, never inferred from a model
// name. Token rates are USD per million; compute-unit rates are USD per unit.
export function decisionUsageCost(usage, pricing) {
  if (!pricing) return null;
  if (pricing.basis === "input-only") return usage?.inputTokens === null || usage?.inputTokens === undefined ? null
    : { lowerUsd: usage.inputTokens * pricing.rates.input / 1e6, upperUsd: usage.inputTokens * pricing.rates.maximumInput / 1e6 };
  if (pricing.basis === "compute-units") return usage?.computeUnits === null || usage?.computeUnits === undefined ? null
    : { lowerUsd: usage.computeUnits * pricing.rates.computeUnit, upperUsd: usage.computeUnits * pricing.rates.computeUnit };
  if (usage?.inputTokens === null || usage?.outputTokens === null || usage?.inputTokens === undefined || usage?.outputTokens === undefined
    || usage.inputTokens > pricing.maxInputTokens) return null;
  const rates = pricing.rates, knownCached = usage.cachedInputTokens ?? 0, knownWrites = usage.cacheWriteTokens ?? 0;
  const remaining = usage.inputTokens - knownCached - knownWrites;
  const unknownRates = [rates.input, ...(usage.cachedInputTokens === null ? [rates.cachedInput] : []), ...(usage.cacheWriteTokens === null ? [rates.cacheWrite] : [])];
  const fixed = knownCached * rates.cachedInput + knownWrites * rates.cacheWrite + usage.outputTokens * rates.output;
  return { lowerUsd: (fixed + remaining * Math.min(...unknownRates)) / 1e6, upperUsd: (fixed + remaining * Math.max(...unknownRates)) / 1e6 };
}

let warned = false;
export function decisionUsageLog(dataDir, purpose) {
  return async record => {
    try {
      if (!/^[a-f0-9-]{36}$/.test(record.id) || !/^[a-f0-9-]{36}$/.test(record.attemptId)) throw new Error("Invalid usage record identifier");
      const safe = {
        version: 1, id: record.id, attemptId: record.attemptId, purpose: token(purpose) || "other", model: token(record.model),
        provider: typeof record.provider === "string" && /^[a-z0-9.-]{1,253}$/.test(record.provider) ? record.provider : null,
        requestHash: /^[a-f0-9]{64}$/.test(record.requestHash) ? record.requestHash : null,
        source: record.source, outcome: record.outcome, dispatchState: record.dispatchState,
        startedAt: record.startedAt, finishedAt: record.finishedAt, elapsedMs: count(record.elapsedMs),
        httpStatus: count(record.httpStatus), requestId: token(record.requestId),
        imageCount: count(record.imageCount), questionCount: count(record.questionCount), bodyBytes: count(record.bodyBytes),
        refusalCount: count(record.refusalCount), failure: token(record.failure),
        usage: record.usage ? Object.fromEntries(fields.map(field => [field, count(record.usage[field])])) : null,
      };
      const dir = path.join(dataDir, "decision-usage");
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await atomicJson(path.join(dir, `${safe.id}.json`), safe, { mode: 0o600 });
    } catch {
      // Logging failure must not hide a result or cause another paid request.
      if (!warned) { warned = true; console.warn("Decision usage could not be saved; reporting coverage may be incomplete."); }
    }
  };
}

export async function readDecisionUsage(dataDir) {
  const dir = path.join(dataDir, "decision-usage");
  let names;
  try { names = await readdir(dir); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const records = [];
  const files = names.filter(name => /^[a-f0-9-]+\.json$/.test(name)).sort();
  for (let offset = 0; offset < files.length; offset += 50) {
    records.push(...await Promise.all(files.slice(offset, offset + 50).map(async name => {
      const record = JSON.parse(await readFile(path.join(dir, name), "utf8"));
      if (record?.id !== name.slice(0, -5)) throw new Error("Decision usage identifier does not match its file.");
      return record;
    })));
  }
  if (records.some(record => !record || record.version !== 1 || !token(record.id) || !token(record.attemptId)
    || !["provider", "cache", "shared"].includes(record.source) || !["unknown", "succeeded", "refused", "failed", "blocked"].includes(record.outcome)
    || !["not-sent", "unknown", "sent"].includes(record.dispatchState) || !Number.isFinite(Date.parse(record.startedAt))
    || (record.usage && fields.some(field => record.usage[field] !== null && count(record.usage[field]) === null)))) throw new Error("Invalid decision usage record.");
  return records;
}

export function summarizeDecisionUsage(records, pricing = null) {
  const calls = records.filter(record => record.source === "provider" && record.dispatchState !== "not-sent");
  const totals = Object.fromEntries(fields.map(field => {
    const known = calls.filter(record => record.usage?.[field] !== null && record.usage?.[field] !== undefined);
    return [field, { observed: known.reduce((sum, record) => sum + record.usage[field], 0), knownCalls: known.length, unknownCalls: calls.length - known.length }];
  }));
  const costs = calls.map(record => record.model === pricing?.model && (!pricing.provider || record.provider === pricing.provider) ? decisionUsageCost(record.usage, pricing) : null);
  return { providerCalls: calls.length, cacheHits: records.filter(record => record.source === "cache").length,
    sharedCalls: records.filter(record => record.source === "shared").length, blocked: records.filter(record => record.outcome === "blocked").length,
    succeeded: calls.filter(record => record.outcome === "succeeded").length, refused: calls.filter(record => record.outcome === "refused").length,
    failed: calls.filter(record => record.outcome === "failed").length, unfinished: calls.filter(record => record.outcome === "unknown").length,
    refusals: calls.reduce((sum, record) => sum + (record.refusalCount ?? 0), 0),
    refusalCoverage: { knownCalls: calls.filter(record => record.refusalCount !== null && record.refusalCount !== undefined).length,
      unknownCalls: calls.filter(record => record.refusalCount === null || record.refusalCount === undefined).length }, usage: totals,
    cost: { basis: pricing?.basis ?? null, estimatedLowerUsd: costs.reduce((sum, cost) => sum + (cost?.lowerUsd ?? 0), 0),
      estimatedUpperUsd: costs.reduce((sum, cost) => sum + (cost?.upperUsd ?? 0), 0), knownCalls: costs.filter(Boolean).length,
      unknownCalls: costs.filter(cost => !cost).length, complete: costs.every(Boolean), actualBilledUsd: null } };
}

export const newDecisionUsageId = () => randomUUID();
