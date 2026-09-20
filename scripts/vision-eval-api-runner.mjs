#!/usr/bin/env node
/** Private, bounded-concurrency Responses API evaluation. Default is offline dry run.
 * node scripts/vision-eval-api-runner.mjs --manifest suite.json --ledger-dir private/run
 *   --phase calibration --cases case1,case2 --configs luna-low,luna-medium,luna-high,terra-low,sol-low --repeats 1 [--concurrency 1..5] [--blocks-per-batch 1..3] [--run]
 * Every phase MUST use the same ledger directory. Never delete it to resume.
 * No retry option: a sent request is never automatically sent again.
 * Pricing verified 2026-09-20, Standard/global endpoint, USD per million tokens:
 * https://developers.openai.com/api/docs/pricing
 * https://developers.openai.com/api/docs/guides/prompt-caching (input-cost formula)
 * https://developers.openai.com/api/docs/guides/token-counting (includes images/schema)
 * https://developers.openai.com/api/reference/typescript/resources/responses/subresources/input_tokens/methods/count
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile, rename, mkdir, chmod, open, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const HARD_CAP_USD = 10;
const NANO = 1_000_000_000;
export const CONFIGS = Object.freeze({
  'luna-low': { model: 'gpt-5.6-luna', effort: 'low' },
  'luna-medium': { model: 'gpt-5.6-luna', effort: 'medium' },
  'luna-high': { model: 'gpt-5.6-luna', effort: 'high' },
  'terra-low': { model: 'gpt-5.6-terra', effort: 'low' },
  'terra-medium': { model: 'gpt-5.6-terra', effort: 'medium' },
  'sol-low': { model: 'gpt-5.6-sol', effort: 'low' },
});
export const PRICING = Object.freeze({
  verifiedAt: '2026-09-20', source: 'https://developers.openai.com/api/docs/pricing',
  cacheSource: 'https://developers.openai.com/api/docs/guides/prompt-caching',
  longContextThreshold: 272_000,
  models: {
    'gpt-5.6-luna': { input: 0.2, cached: 0.02, write: 0.25, output: 1.2 },
    'gpt-5.6-terra': { input: 2, cached: 0.2, write: 2.5, output: 12 },
    'gpt-5.6-sol': { input: 4, cached: 0.4, write: 5, output: 20 },
  },
});
const hash = (v) => createHash('sha256').update(typeof v === 'string' || Buffer.isBuffer(v) ? v : JSON.stringify(v)).digest('hex');
const now = () => new Date().toISOString();
const int = (v) => Number.isSafeInteger(v) && v >= 0;
const dollars = (n) => n / NANO;
function insist(condition, message) { if (!condition) throw new Error(message); }
async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch (error) {
    if (error.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw error;
  }
}
async function saveJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = await open(tmp, 'w', 0o600);
  try { await fd.writeFile(`${JSON.stringify(value, null, 2)}\n`); await fd.sync(); } finally { await fd.close(); }
  await rename(tmp, file);
  await chmod(file, 0o600);
}
async function privateDir(dir) { await mkdir(dir, { recursive: true, mode: 0o700 }); await chmod(dir, 0o700); }
function rates(model, inputTokens) {
  const base = PRICING.models[model];
  insist(base, 'Unpriced model');
  const long = inputTokens > PRICING.longContextThreshold;
  return { input: base.input * (long ? 2 : 1), cached: base.cached * (long ? 2 : 1), write: base.write * (long ? 2 : 1), output: base.output * (long ? 1.5 : 1) };
}
export function reservationNano(model, countedInputTokens, maxOutputTokens) {
  insist(int(countedInputTokens) && int(maxOutputTokens) && maxOutputTokens > 0, 'Invalid token bound');
  // Token-count API is authoritative; margin also covers small tokenizer/accounting drift.
  const inputBound = Math.ceil(countedInputTokens * 1.05) + 256;
  insist(inputBound + maxOutputTokens <= 1_050_000, 'Request exceeds conservative context bound');
  const r = rates(model, inputBound);
  return { inputBound, nanoUsd: Math.ceil((inputBound * r.write + maxOutputTokens * r.output) * 1000) };
}
export function usageCost(model, usage) {
  if (!usage || !int(usage.input_tokens) || !int(usage.output_tokens)) return null;
  const { input_tokens: input, output_tokens: output } = usage;
  const cached = usage.input_tokens_details?.cached_tokens;
  const writes = usage.input_tokens_details?.cache_write_tokens;
  const reasoning = usage.output_tokens_details?.reasoning_tokens;
  if (!int(cached) || cached > input || (writes !== undefined && (!int(writes) || cached + writes > input)) || (reasoning !== undefined && (!int(reasoning) || reasoning > output))) return null;
  const r = rates(model, input);
  const unknownWrites = writes === undefined;
  const lowerWrites = writes ?? 0;
  const upperWrites = writes ?? (input - cached);
  const cost = (w) => Math.ceil(((input - cached - w) * r.input + cached * r.cached + w * r.write + output * r.output) * 1000);
  return { exact: !unknownWrites, nanoUsd: unknownWrites ? null : cost(writes), lowerNanoUsd: cost(lowerWrites), upperNanoUsd: cost(upperWrites), inputTokens: input, cachedTokens: cached, cacheWriteTokens: writes ?? null, outputTokens: output, reasoningTokens: reasoning ?? null };
}
export function parseResponse(body) {
  const content = Array.isArray(body?.output) ? body.output.flatMap((item) => Array.isArray(item.content) ? item.content : []) : [];
  const outputText = content.filter((item) => item.type === 'output_text' && typeof item.text === 'string').map((item) => item.text).join('');
  const refusals = content.filter((item) => item.type === 'refusal').map((item) => item.refusal);
  let parsed = null;
  try { parsed = JSON.parse(outputText); } catch { /* Keep the original text, including incomplete JSON. */ }
  return { apiStatus: body?.status ?? null, responseId: body?.id ?? null, returnedModel: body?.model ?? null, serviceTier: body?.service_tier ?? null, incompleteDetails: body?.incomplete_details ?? null, outputText, parsed, refusals };
}
export function summarizeLedger(ledger) {
  const attempts = Object.values(ledger.attempts);
  const committedNano = attempts.reduce((sum, a) => sum + (a.chargedNanoUsd ?? a.usageUpperNanoUsd ?? a.reservedNanoUsd), 0);
  const measuredNano = attempts.reduce((sum, a) => sum + (a.chargedNanoUsd ?? 0), 0);
  return { capUsd: dollars(ledger.capNanoUsd), observedUsageLowerUsd: dollars(attempts.reduce((s, a) => s + (a.cost?.lowerNanoUsd ?? 0), 0)), observedUsageUpperUsd: dollars(attempts.reduce((s, a) => s + (a.cost?.upperNanoUsd ?? 0), 0)), committedUsd: dollars(committedNano), exactUsageUsd: dollars(measuredNano), reservedUnreconciledUsd: dollars(committedNano - measuredNano), remainingUsd: dollars(Math.max(0, ledger.capNanoUsd - committedNano)), attempts: attempts.filter(a => a.dispatchState !== 'not_sent').length, reservedNotSent: attempts.filter(a => a.dispatchState === 'not_sent').length, completed: attempts.filter(a => a.status === 'completed').length, incomplete: attempts.filter(a => a.status === 'incomplete').length, uncertain: attempts.filter(a => a.dispatchState !== 'not_sent' && ['reserved', 'uncertain'].includes(a.status)).length };
}

export async function materializeImages(value, baseDir) {
  if (Array.isArray(value)) return Promise.all(value.map(v => materializeImages(v, baseDir)));
  if (!value || typeof value !== 'object') return value;
  if (value.type === 'input_image') {
    const item = { ...value };
    if (item.image_path) {
      insist(!item.image_url && !item.file_id, 'Image must have one source');
      const ext = path.extname(item.image_path).toLowerCase();
      const mime = item.mime_type ?? ({ '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' })[ext];
      insist(['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(mime), 'Unsupported image type');
      const bytes = await readFile(path.resolve(baseDir, item.image_path));
      item.image_url = `data:${mime};base64,${bytes.toString('base64')}`;
      delete item.image_path; delete item.mime_type;
    }
    insist(typeof item.image_url === 'string' && /^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(item.image_url), 'Freeze images locally; remote images and file IDs are not allowed');
    return item;
  }
  return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([k, v]) => [k, await materializeImages(v, baseDir)])));
}
function validateRequest(request) {
  const allowed = new Set(['model', 'input', 'instructions', 'text', 'reasoning', 'store', 'service_tier', 'max_output_tokens', 'temperature', 'top_p', 'prompt_cache_key', 'prompt_cache_retention', 'prompt_cache_options', 'truncation', 'metadata']);
  insist(request && request.input, 'Missing production input');
  for (const key of Object.keys(request)) insist(allowed.has(key), `Unsupported production request field: ${key}`);
  insist(request.truncation === undefined || request.truncation === 'disabled', 'Automatic truncation is disallowed');
  const messages = Array.isArray(request.input) ? request.input : [];
  insist(messages.every(m => m && (!m.type || m.type === 'message') && ['user', 'system', 'developer'].includes(m.role)), 'Only fresh input messages are allowed');
  for (const message of messages) if (Array.isArray(message.content)) insist(message.content.every(c => ['input_text', 'input_image'].includes(c.type)), 'Only text/image inputs are allowed');
}
export async function buildSchedule({ manifest, baseDir, phase, configNames, caseIds, repeats, seed = 'wardrobe-vision-2026-09-20' }) {
  insist(['calibration', 'screen', 'confirmation', 'diagnostic', 'rescue'].includes(phase), 'Choose a named phase');
  insist(int(repeats) && repeats > 0 && repeats <= 10, 'Repeats must be 1..10');
  insist(configNames.length && new Set(configNames).size === configNames.length && configNames.every(c => CONFIGS[c]), 'Invalid or duplicate configs');
  insist(caseIds.length && new Set(caseIds).size === caseIds.length, 'Name unique cases explicitly');
  insist(Array.isArray(manifest.cases), 'Manifest must contain cases');
  insist(new Set(manifest.cases.map(c => c.id)).size === manifest.cases.length, 'Duplicate manifest case IDs');
  const cases = caseIds.map(id => { const c = manifest.cases.find(c => c.id === id); insist(c, `Unknown case: ${id}`); return c; });
  const items = [];
  for (const c of cases) {
    insist(c.task && c.split && c.family && int(c.timeoutMs) && c.timeoutMs > 0 && c.timeoutMs <= 600_000, `Missing task/split/family/timeoutMs for ${c.id}`);
    const allowedSplits = ['diagnostic', 'rescue'].includes(phase) ? [phase] : phase === 'confirmation' ? ['confirm', 'confirmation'] : ['screen', 'screening'];
    insist(allowedSplits.includes(c.split), `Case split conflicts with ${phase}: ${c.id}`);
    const cap = manifest.outputCaps?.[c.task];
    insist(int(cap) && cap > 0 && cap <= 128_000, `Missing/invalid common output cap for task ${c.task}`);
    const request = await materializeImages(c.request, baseDir);
    validateRequest(request);
    for (let repeat = 1; repeat <= repeats; repeat++) {
      const blockId = hash(`${seed}:${c.id}:${repeat}`);
      for (const name of configNames) {
        const config = CONFIGS[name];
        const payload = { ...request, model: config.model, reasoning: { ...request.reasoning, effort: config.effort }, service_tier: 'default', store: false, max_output_tokens: cap };
        const requestHash = hash(payload);
        // Deliberately phase-independent: calibration answers are included in screening.
        const id = hash({ caseId: c.id, config: name, repeat, requestHash, timeoutMs: c.timeoutMs });
        items.push({ id, caseId: c.id, task: c.task, split: c.split, family: c.family, config: name, repeat, blockId, timeoutMs: c.timeoutMs, requestHash, payload });
      }
    }
  }
  items.sort((a, b) => a.blockId.localeCompare(b.blockId) || hash(`${seed}:${a.id}`).localeCompare(hash(`${seed}:${b.id}`)));
  return { version: 1, phase, seed, repeats, configNames, caseIds, manifestHash: hash(manifest), pricingHash: hash(PRICING), items };
}
function countPayload(payload) {
  // Official count endpoint fields; generation-only options do not change input tokens.
  const keys = ['model', 'input', 'instructions', 'reasoning', 'text', 'truncation'];
  return Object.fromEntries(keys.filter(k => payload[k] !== undefined).map(k => [k, payload[k]]));
}
export function createTransport(apiKey, fetchImpl = fetch) {
  insist(typeof apiKey === 'string' && apiKey.length > 0, 'OPENAI_API_KEY must be present for --run');
  async function post(endpoint, payload, timeoutMs, clientRequestId) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`https://api.openai.com/v1/${endpoint}`, { method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', 'x-client-request-id': clientRequestId }, body: JSON.stringify(payload), signal: controller.signal });
      // Provider errors may echo the submitted credential. Redact it before any
      // parsing, logging or private artifact persistence; successful text is unchanged.
      const raw = (await response.text()).split(apiKey).join('[REDACTED_API_KEY]');
      let body = null;
      try { body = JSON.parse(raw); } catch { /* Preserve non-JSON HTTP failures privately. */ }
      return { httpStatus: response.status, requestId: response.headers.get('x-request-id'), body, raw };
    } finally { clearTimeout(timer); }
  }
  return {
    async count(payload, id) { return post('responses/input_tokens', countPayload(payload), 60_000, `count-${id}`); },
    async create(payload, timeoutMs, id) { return post('responses', payload, timeoutMs, id); },
  };
}

export async function runEvaluation({ manifestPath, ledgerDir, phase, configNames, caseIds, repeats = 1, seed, concurrency = 1, blocksPerBatch = 1, run = false, apiKey, transport, onProgress = () => {} }) {
  insist(int(concurrency) && concurrency >= 1 && concurrency <= 5, 'Concurrency must be 1..5');
  insist(int(blocksPerBatch) && blocksPerBatch >= 1 && blocksPerBatch <= 3, 'Blocks per batch must be 1..3');
  const absoluteManifest = path.resolve(manifestPath);
  const manifest = await readJson(absoluteManifest);
  const schedule = await buildSchedule({ manifest, baseDir: path.dirname(absoluteManifest), phase, configNames, caseIds, repeats, seed });
  ledgerDir = path.resolve(ledgerDir);
  await privateDir(ledgerDir);
  const lockPath = path.join(ledgerDir, '.runner-lock');
  try { await mkdir(lockPath, { mode: 0o700 }); } catch (error) { if (error.code === 'EEXIST') throw new Error('Ledger is locked; verify the prior process stopped before manually clearing .runner-lock'); throw error; }
  try {
    const ledgerPath = path.join(ledgerDir, 'ledger.json');
    const ledger = await readJson(ledgerPath, { version: 1, capNanoUsd: HARD_CAP_USD * NANO, pricing: PRICING, attempts: {}, createdAt: now() });
    insist(ledger.version === 1 && ledger.capNanoUsd === HARD_CAP_USD * NANO && hash(ledger.pricing) === hash(PRICING), 'Ledger policy/pricing mismatch');
    for (const a of Object.values(ledger.attempts)) insist(int(a.reservedNanoUsd) && (a.chargedNanoUsd === null || a.chargedNanoUsd === undefined || int(a.chargedNanoUsd)) && (a.usageUpperNanoUsd === undefined || int(a.usageUpperNanoUsd)), 'Invalid ledger amount');
    const schedulePath = path.join(ledgerDir, `${phase}-schedule.json`);
    const existing = await readJson(schedulePath, null);
    const descriptor = { ...schedule, items: schedule.items.map(({ payload, ...item }) => item) };
    if (existing) insist(hash(existing) === hash(descriptor), 'Frozen phase schedule differs; do not overwrite or silently change a scored run');
    else await saveJson(schedulePath, descriptor);
    await privateDir(path.join(ledgerDir, 'requests'));
    for (const item of schedule.items) {
      const file = path.join(ledgerDir, 'requests', `${item.requestHash}.json`);
      const saved = await readJson(file, null);
      if (saved) insist(hash(saved) === item.requestHash, 'Frozen request was modified');
      else await saveJson(file, item.payload);
    }
    await saveJson(ledgerPath, ledger);
    if (!run) return { dryRun: true, concurrency, blocksPerBatch, plannedCalls: schedule.items.length, pendingCalls: schedule.items.filter(i => !ledger.attempts[i.id] || ledger.attempts[i.id].dispatchState === 'not_sent').length, schedulePath, ledgerDir, ...summarizeLedger(ledger), note: 'Offline only. Exact input counts and reservations require --run. No network requests made.' };
    insist(!ledger.haltReason, 'Ledger contains a cost-envelope violation; reconcile before continuing');
    // An interrupted sent call remains fully reserved and is never sent again.
    for (const [id, a] of Object.entries(ledger.attempts)) if (a.status === 'reserved') {
      if (a.dispatchState === 'not_sent') delete ledger.attempts[id];
      else { a.status = 'uncertain'; a.failure = 'prior_process_interrupted'; }
    }
    await saveJson(ledgerPath, ledger);
    const client = transport ?? createTransport(apiKey);
    await privateDir(path.join(ledgerDir, 'raw'));
    const countFile = path.join(ledgerDir, 'input-counts.json');
    const counts = await readJson(countFile, {});
    let stopped = null;
    const blocks = [...new Set(schedule.items.filter(i => !ledger.attempts[i.id]).map(i => i.blockId))];
    for (let blockOffset = 0; blockOffset < blocks.length; blockOffset += blocksPerBatch) {
      const batchIds = new Set(blocks.slice(blockOffset, blockOffset + blocksPerBatch));
      const block = schedule.items.filter(i => batchIds.has(i.blockId) && !ledger.attempts[i.id]);
      if (!block.length) continue;
      // Count unique requests in parallel, but persist only after every count has
      // settled. No paid request is admitted unless the entire matched batch fits.
      const uncounted = [...new Map(block.filter(item => !counts[item.requestHash]).map(item => [item.requestHash, item])).values()];
      const counted = await Promise.all(uncounted.map(async item => {
        try { return { item, result: await client.count(item.payload, item.id) }; }
        catch { return { item, failed: true }; }
      }));
      let countFailure = null;
      for (const { item, result, failed } of counted) {
        if (failed) { countFailure = 'Input-token counting failed; no generation admitted for this batch'; continue; }
        if (!(result?.httpStatus >= 200 && result.httpStatus < 300 && int(result.body?.input_tokens))) {
          countFailure = 'Input-token counter rejected the request; no generation admitted for this batch'; continue;
        }
        counts[item.requestHash] = { inputTokens: result.body.input_tokens, countedAt: now(), requestId: result.requestId ?? null };
      }
      if (counted.length) await saveJson(countFile, counts);
      insist(!countFailure, countFailure);
      const bounds = new Map(block.map(item => [item.id, reservationNano(item.payload.model, counts[item.requestHash].inputTokens, item.payload.max_output_tokens)]));
      const committedNano = Object.values(ledger.attempts).reduce((s, a) => s + (a.chargedNanoUsd ?? a.usageUpperNanoUsd ?? a.reservedNanoUsd), 0);
      if (committedNano + [...bounds.values()].reduce((s, b) => s + b.nanoUsd, 0) > ledger.capNanoUsd) { stopped = blocksPerBatch === 1 ? 'budget_before_matched_block' : 'budget_before_matched_batch'; break; }
      // Reserve every pending call in all matched blocks atomically before launching any of them.
      for (const item of block) {
        const bound = bounds.get(item.id);
        ledger.attempts[item.id] = { id: item.id, caseId: item.caseId, task: item.task, family: item.family, split: item.split, config: item.config, repeat: item.repeat, firstPhase: phase, requestHash: item.requestHash, status: 'reserved', dispatchState: 'not_sent', concurrency, blocksPerBatch, reservedNanoUsd: bound.nanoUsd, chargedNanoUsd: null, inputBound: bound.inputBound, countedInputTokens: counts[item.requestHash].inputTokens, maxOutputTokens: item.payload.max_output_tokens, timeoutMs: item.timeoutMs, reservedAt: now() };
      }
      await saveJson(ledgerPath, ledger);
      for (let offset = 0; offset < block.length; offset += concurrency) {
        const wave = block.slice(offset, offset + concurrency);
        for (const item of wave) {
          ledger.attempts[item.id].dispatchState = 'sending';
          ledger.attempts[item.id].startedAt = now();
        }
        // A crash from this point keeps the entire launched wave reserved forever;
        // no request can be sent before its sending state reaches durable storage.
        await saveJson(ledgerPath, ledger);
        const results = await Promise.all(wave.map(async (item) => {
          const start = performance.now();
          try {
            const result = await client.create(item.payload, item.timeoutMs, item.id);
            return { result, finishedAt: now(), latencyMs: Math.round(performance.now() - start) };
          } catch {
            return { transportFailed: true, finishedAt: now(), latencyMs: Math.round(performance.now() - start) };
          }
        }));
        // Persist sequentially: no shared temporary-file or ledger write races.
        // Even if one response invalidates pricing, every already-sent response
        // in this wave is reconciled before stopping later waves.
        for (let index = 0; index < wave.length; index++) {
          const item = wave[index], { result, transportFailed, finishedAt, latencyMs } = results[index];
          const entry = ledger.attempts[item.id], bound = bounds.get(item.id);
          entry.finishedAt = finishedAt; entry.latencyMs = latencyMs;
          if (transportFailed) {
            entry.status = 'uncertain'; entry.failure = 'transport_error_or_timeout';
            await saveJson(ledgerPath, ledger);
            onProgress({ caseId: item.caseId, config: item.config, repeat: item.repeat, status: entry.status, latencyMs: entry.latencyMs, ...summarizeLedger(ledger) });
            continue;
          }
          entry.httpStatus = result.httpStatus; entry.requestId = result.requestId ?? null;
          // Do not put API error messages/headers/secrets in console output.
          await saveJson(path.join(ledgerDir, 'raw', `${item.id}.json`), { httpStatus: result.httpStatus, requestId: result.requestId ?? null, body: result.body, raw: result.raw ?? null });
          const parsed = parseResponse(result.body);
          const cost = usageCost(item.payload.model, result.body?.usage);
          entry.response = parsed; entry.usage = result.body?.usage ?? null; entry.cost = cost;
          const httpSuccess = result.httpStatus >= 200 && result.httpStatus < 300;
          const tierValid = parsed.serviceTier === 'default';
          const modelValid = parsed.returnedModel === item.payload.model || parsed.returnedModel?.startsWith(`${item.payload.model}-`);
          const boundsValid = cost && cost.inputTokens <= bound.inputBound && cost.outputTokens <= item.payload.max_output_tokens && cost.upperNanoUsd <= bound.nanoUsd;
          if (cost?.exact && tierValid && modelValid && boundsValid) entry.chargedNanoUsd = cost.nanoUsd;
          if (!httpSuccess || !cost || !tierValid || !modelValid || !boundsValid) {
            entry.status = 'uncertain';
            entry.failure = !httpSuccess ? 'http_error' : !tierValid ? 'unverified_service_tier' : !modelValid ? 'unexpected_model' : !cost ? 'missing_or_invalid_usage' : 'usage_exceeded_reservation';
            // A timeout/error's full reservation is sufficient to continue. Contradictory
            // billing evidence invalidates the bound and must stop further admissions.
            if ((httpSuccess && (!tierValid || !modelValid)) || (cost && !boundsValid)) {
              stopped = 'cost_envelope_violation'; ledger.haltReason = { attemptId: item.id, reason: entry.failure, at: now() };
            }
          } else {
            entry.status = parsed.apiStatus === 'completed' ? 'completed' : 'incomplete';
            if (!cost.exact) {
              entry.usageUpperNanoUsd = cost.upperNanoUsd;
              entry.accountingNote = 'Cache write tokens absent: known output cost plus all non-cached input charged at cache-write rate held against cap; cost interval recorded.';
            }
            if (entry.latencyMs > item.timeoutMs) entry.operationalFailure = 'deadline_exceeded';
          }
          await saveJson(ledgerPath, ledger);
          onProgress({ caseId: item.caseId, config: item.config, repeat: item.repeat, status: entry.status, latencyMs: entry.latencyMs, ...summarizeLedger(ledger) });
        }
        if (stopped) {
          // These later waves provably were never dispatched: release only their
          // reservations. A restarted process makes the same distinction.
          for (const item of block) if (ledger.attempts[item.id]?.dispatchState === 'not_sent') delete ledger.attempts[item.id];
          await saveJson(ledgerPath, ledger);
          break;
        }
      }
      if (stopped) break;
    }
    return { dryRun: false, concurrency, blocksPerBatch, stopped, plannedCalls: schedule.items.length, pendingCalls: schedule.items.filter(i => !ledger.attempts[i.id] || ledger.attempts[i.id].dispatchState === 'not_sent').length, schedulePath, ledgerDir, ...summarizeLedger(ledger) };
  } finally { await rm(lockPath, { recursive: true, force: true }); }
}
function parseCli(argv) {
  const args = {};
  const allowed = new Set(['manifest', 'ledger-dir', 'phase', 'configs', 'cases', 'repeats', 'seed', 'concurrency', 'blocks-per-batch', 'run']);
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i].replace(/^--/, '');
    insist(argv[i].startsWith('--') && allowed.has(name), 'Unknown CLI argument');
    insist(args[name] === undefined, 'Duplicate CLI argument');
    args[name] = name === 'run' ? true : argv[++i];
    insist(args[name] !== undefined && (args[name] === true || !args[name].startsWith('--')), 'Missing CLI value');
  }
  for (const name of ['manifest', 'ledger-dir', 'phase', 'configs', 'cases']) insist(args[name], `--${name} is required`);
  return { manifestPath: args.manifest, ledgerDir: args['ledger-dir'], phase: args.phase, configNames: args.configs.split(','), caseIds: args.cases.split(','), repeats: Number(args.repeats ?? 1), seed: args.seed, concurrency: Number(args.concurrency ?? 1), blocksPerBatch: Number(args['blocks-per-batch'] ?? 1), run: args.run === true };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const options = parseCli(process.argv.slice(2));
    const result = await runEvaluation({ ...options, apiKey: options.run ? process.env.OPENAI_API_KEY : undefined, onProgress: row => console.log(JSON.stringify(row)) });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    // Our own validation messages only. Underlying network/FS errors can contain sensitive data.
    console.error(`Evaluation stopped: ${error?.code ? error.code : error.message}`);
    process.exitCode = 1;
  }
}
