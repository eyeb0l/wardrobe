import { createHash } from "node:crypto";
import { emptyDecisionUsage, normalizeDecisionUsage, newDecisionUsageId } from "./decision-usage.mjs";

export const DECISIONS_MODEL = "gpt-6-luna";
export const hashEvidence = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const cache = new Map(), pending = new Map();
let activeRequests = 0, preflight = Promise.resolve();
const requestQueue = [];
const fail = (message, status = 503) => Object.assign(new Error(message), { status });
const probability = value => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

// The two-request limit is shared by every Decisions caller in this process.
// Queue time consumes the caller's timeout; expired work never reserves quota.
function acquireRequest(signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      const index = requestQueue.indexOf(entry);
      if (index !== -1) requestQueue.splice(index, 1);
      reject(signal.reason);
    };
    const entry = () => {
      signal.removeEventListener("abort", onAbort);
      activeRequests++;
      resolve(() => {
        activeRequests--;
        requestQueue.shift()?.();
      });
    };
    if (signal.aborted) return reject(signal.reason);
    if (activeRequests < 2) entry();
    else { requestQueue.push(entry); signal.addEventListener("abort", onAbort, { once: true }); }
  });
}

export function decisionsConfig(env = process.env) {
  const enabled = env.WARDROBE_DECISIONS_ENABLED === "1";
  return { enabled, ready: enabled && Boolean(env.OPENAI_API_KEY?.trim()) };
}

export function validateDecisionAnswers(result, questions, model) {
  const invalid = () => { throw fail("The image check returned an invalid answer. Please try again.", 502); };
  if (result?.model !== model || !Array.isArray(result.answers) || result.answers.length !== questions.length) invalid();
  return result.answers.map((answer, index) => {
    const question = questions[index];
    if (!answer || answer.name !== question.name) invalid();
    if (answer.type === "refusal") return { type: "refusal", name: question.name };
    if (answer.type !== question.type) invalid();
    if (answer.type === "predicate") {
      if (!probability(answer.probability)) invalid();
      return { type: answer.type, name: answer.name, probability: answer.probability };
    }
    if (!probability(answer.confidence) || !Array.isArray(answer.probabilities) || answer.probabilities.some(item => !item || typeof item !== "object")) invalid();
    const expected = question.type === "choice" ? question.choices.map(item => item.value) : question.levels.map(item => item.label);
    const values = answer.probabilities.map(item => question.type === "choice" ? item.value : item.label);
    if (values.length !== expected.length || new Set(values).size !== expected.length || expected.some(value => !values.includes(value))
      || answer.probabilities.some(item => !probability(item.probability))
      || Math.abs(answer.probabilities.reduce((sum, item) => sum + item.probability, 0) - 1) > .02) invalid();
    if (question.type === "choice") {
      if (!expected.includes(answer.choice)) invalid();
      return { type: answer.type, name: answer.name, choice: answer.choice, confidence: answer.confidence,
        probabilities: answer.probabilities.map(({ value, probability }) => ({ value, probability })) };
    }
    if (typeof answer.score !== "number" || !Number.isFinite(answer.score) || answer.score < 0 || answer.score > expected.length - 1
      || answer.probabilities.some(item => item.value !== expected.indexOf(item.label))) invalid();
    return { type: answer.type, name: answer.name, score: answer.score, confidence: answer.confidence,
      probabilities: answer.probabilities.map(({ label, value, probability }) => ({ label, value, probability })) };
  });
}

// A shared client for bounded image judgments. Never logs evidence or provider
// response bodies; only successful, validated answers enter the process cache.
export async function decide({ withDecisionLease, ...options }) {
  return withDecisionLease ? withDecisionLease(() => runDecision(options)) : runDecision(options);
}

async function runDecision({ input, questions, namespace, version = 1, env = process.env,
  fetch: fetchImpl = fetch, beforePaidCall, outsideLease = fn => fn(), timeoutMs = 12_000, usageLog, cacheMode = "default" }) {
  if (!decisionsConfig(env).ready) throw fail("Image suggestions are unavailable. You can still review and browse your wardrobe.");
  if (!Array.isArray(questions) || !questions.length || questions.length > 64
    || questions.some(q => !q.name || !["choice", "predicate", "score"].includes(q.type))
    || new Set(questions.map(q => q.name)).size !== questions.length) throw fail("Invalid image check questions.", 422);
  const model = env.OPENAI_DECISIONS_MODEL?.trim() || DECISIONS_MODEL;
  if (typeof input !== "string" && !Array.isArray(input)) throw fail("Invalid image evidence.", 422);
  if (Array.isArray(input) && (input.some(message => message.role !== "user" || !Array.isArray(message.content)
    || message.content.some(part => !["input_text", "input_image"].includes(part.type)
      || (part.type === "input_image" && !/^data:image\/(?:png|jpeg|webp);base64,/.test(part.image_url))))
    || input.flatMap(message => message.content).filter(part => part.type === "input_image").length > 128)) throw fail("Invalid image evidence.", 422);
  const endpoint = `${(env.OPENAI_API_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "")}/decisions`;
  const payload = { model, input, questions };
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body) > 8 * 1024 * 1024) throw fail("These images are too large to check together. You can still review them yourself.", 422);
  if (!["default", "bypass"].includes(cacheMode)) throw fail("Invalid image check cache mode.", 422);
  const key = hashEvidence([namespace, endpoint, env.OPENAI_API_KEY, version, payload]);
  const started = Date.now(), id = newDecisionUsageId();
  const record = { id, attemptId: id, model, requestHash: hashEvidence([version, payload]), source: "provider", outcome: "unknown",
    dispatchState: "not-sent", startedAt: new Date(started).toISOString(), finishedAt: null, elapsedMs: null,
    imageCount: Array.isArray(input) ? input.flatMap(message => message.content).filter(part => part.type === "input_image").length : 0,
    questionCount: questions.length, bodyBytes: Buffer.byteLength(body), provider: new URL(endpoint).hostname, httpStatus: null, requestId: null, refusalCount: null, failure: null, usage: null };
  const log = async () => { try { await usageLog?.(structuredClone(record)); } catch { /* Logging must never trigger another provider request. */ } };
  const finished = () => { record.finishedAt = new Date().toISOString(); record.elapsedMs = Math.max(0, Date.now() - started); };
  const reuse = async (value, source) => {
    Object.assign(record, { source, attemptId: value.attemptId, outcome: value.answers.some(answer => answer.type === "refusal") ? "refused" : "succeeded",
      refusalCount: value.answers.filter(answer => answer.type === "refusal").length, usage: emptyDecisionUsage() });
    finished(); await log();
    return { ...structuredClone(value), cached: true, inputTokens: 0, usage: emptyDecisionUsage() };
  };
  for (const [id, entry] of cache) if (entry.expires <= Date.now()) cache.delete(id);
  if (cacheMode === "default" && cache.has(key)) return reuse(cache.get(key).value, "cache");
  if (cacheMode === "default" && pending.has(key)) {
    record.attemptId = pending.get(key).attemptId;
    // A duplicate releases its writer lease while the first request completes.
    const shared = pending.get(key);
    try { return await reuse(await outsideLease(() => shared), "shared"); }
    catch (error) { Object.assign(record, { source: "shared", outcome: "failed", failure: "shared-request-failed", usage: emptyDecisionUsage() }); finished(); await log(); throw error; }
  }
  const pendingKey = cacheMode === "bypass" ? id : key;
  const work = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
    let onAbort, release;
    try {
      if (activeRequests >= 2) {
        // Queued callers must let active calls reacquire their writer leases.
        // Capture the slot inside the callback so a stale-revision error after
        // reacquisition still releases it in finally.
        await outsideLease(async () => { release = await acquireRequest(controller.signal); });
      } else release = await acquireRequest(controller.signal);
      controller.signal.throwIfAborted();
      // Quota callbacks may read/update the same usage record. Keep reservation
      // and dispatch intent serial while the expensive provider work overlaps.
      const reservation = preflight.then(async () => {
        controller.signal.throwIfAborted();
        await beforePaidCall?.("text");
        controller.signal.throwIfAborted();
        // An interrupted process leaves an unknown attempt, never a free call.
        record.dispatchState = "unknown";
        await log();
      });
      preflight = reservation.catch(() => {});
      await reservation;
      const result = await outsideLease(async () => {
        const aborted = new Promise((_, reject) => {
          onAbort = () => reject(fail("The image check took too long. Please try again.", 504));
          controller.signal.addEventListener("abort", onAbort, { once: true });
          if (controller.signal.aborted) onAbort();
        });
        const request = (async () => {
          controller.signal.throwIfAborted();
          record.dispatchState = "sent";
          record.failure = "transport-error";
          const response = await fetchImpl(endpoint, { method: "POST", headers: { "Content-Type": "application/json",
            Authorization: `Bearer ${env.OPENAI_API_KEY.trim()}` }, body, signal: controller.signal });
          record.httpStatus = response.status ?? null;
          const requestId = response.headers?.get?.("x-request-id");
          record.requestId = typeof requestId === "string" && /^req_[a-zA-Z0-9_-]{1,90}$/.test(requestId) && !requestId.includes(env.OPENAI_API_KEY.trim()) ? requestId : null;
          record.failure = "http-error";
          if (!response.ok) throw fail(response.status === 429 ? "Image suggestions are busy. Try again shortly." : "Image suggestions are temporarily unavailable. You can still review your images.", response.status === 429 ? 429 : 502);
          record.failure = "invalid-json";
          const value = await response.json();
          record.usage = normalizeDecisionUsage(value?.usage);
          return value;
        })();
        try { return await Promise.race([request, aborted]); }
        catch (error) {
          if (controller.signal.aborted) throw fail("The image check took too long. Please try again.", 504);
          throw error.status ? error : fail("Could not reach image suggestions. Please try again.", 502);
        }
      });
      record.failure = "invalid-answer";
      const value = { answers: validateDecisionAnswers(result, questions, model), model, cached: false, attemptId: id,
        inputTokens: record.usage.inputTokens, usage: structuredClone(record.usage) };
      record.refusalCount = value.answers.filter(answer => answer.type === "refusal").length;
      record.outcome = record.refusalCount ? "refused" : "succeeded";
      record.failure = null;
      if (cacheMode === "default") {
        if (cache.size >= 64) cache.delete(cache.keys().next().value);
        cache.set(key, { value, expires: Date.now() + 15 * 60_000 });
      }
      return structuredClone(value);
    } catch (error) {
      record.outcome = record.dispatchState === "sent" ? "failed" : "blocked";
      if (record.dispatchState !== "sent") record.dispatchState = "not-sent";
      record.failure = controller.signal.aborted ? "timeout" : record.failure || "before-dispatch";
      throw controller.signal.aborted ? fail("The image check took too long. Please try again.", 504) : error;
    } finally {
      clearTimeout(timer); controller.signal.removeEventListener("abort", onAbort);
      finished(); await log();
      release?.();
    }
  })();
  work.attemptId = id;
  pending.set(pendingKey, work);
  try { return await work; } finally { pending.delete(pendingKey); }
}
