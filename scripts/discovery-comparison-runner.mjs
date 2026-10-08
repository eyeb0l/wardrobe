#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { atomicJson } from "./outfit-storage.mjs";
import { COMPARISON_PROTOCOL, comparisonVariants, maximumComparisonCalls, initializeDiscoveryComparison, loadReviewedComparison, rankComparisonApproach, scoreHumanAgreement } from "./discovery-comparison.mjs";
import { hashEvidence, decisionsConfig } from "./decisions.mjs";
import { rankWithDecisions } from "./decision-ranking.mjs";
import { prepareDiscoveryBatch, discoverySubjectUnchanged } from "./outfit-discovery-api.mjs";
import { shuffledCandidates, compareDiscoveryJudgments } from "./discovery-sensitivity.mjs";
import { defaultDecisionPricing, summarizeDecisionUsage } from "./decision-usage.mjs";

const mean = values => { const known = values.filter(value => value !== null && value !== undefined); return known.length ? known.reduce((sum, value) => sum + Number(value), 0) / known.length : null; };
export function summarizeComparison(trials) {
  const success = trials.filter(trial => trial.status === "succeeded");
  const methods = COMPARISON_PROTOCOL.methods.map(method => {
    const cases = [...new Set(success.filter(trial => trial.method === method).map(trial => trial.caseId))].map(caseId => {
      const rows = success.filter(trial => trial.method === method && trial.caseId === caseId);
      const comparisons = [];
      for (const trial of rows) {
        const base = trial.repeat > 0 ? rows.find(row => row.variant === trial.variant && row.repeat === 0) : rows.find(row => row.repeat === 0);
        if (base && base !== trial) comparisons.push({ variant: trial.variant, repeat: trial.repeat, kind: trial.repeat ? "repeat-noise" : "layout-variation", ...compareDiscoveryJudgments(base.rankings, trial.rankings) });
      }
      return { caseId, trials: rows.length,
        agreement: Object.fromEntries(["ndcgAtThree", "precisionAtThree", "preferredRecallAtThree", "winnerPreferred", "noneSuitableAgreement"].map(metric => [metric, mean(rows.map(row => row.agreement[metric]))])),
        stability: comparisons, meanLatencyMs: mean(rows.map(row => row.elapsedMs)), meanProviderCalls: mean(rows.map(row => row.providerCalls)),
        abstainedTrials: rows.filter(row => row.agreement.returnedCandidates === 0).length,
        meanReturnedCandidates: mean(rows.map(row => row.agreement.returnedCandidates)),
        humanUnknownCandidates: rows[0].agreement.humanUnknownCandidates,
        meanIgnoredHumanUnknownResults: mean(rows.map(row => row.agreement.ignoredHumanUnknownResults)),
        meanEstimatedCostLowerUsd: mean(rows.map(row => row.usage?.cost.complete ? row.usage.cost.estimatedLowerUsd : null)),
        meanEstimatedCostUpperUsd: mean(rows.map(row => row.usage?.cost.complete ? row.usage.cost.estimatedUpperUsd : null)),
        trialsWithinProductionDeadline: rows.filter(row => row.elapsedMs <= 12_000).length };
    });
    return { method, cases, caseWeightedAgreement: Object.fromEntries(["ndcgAtThree", "precisionAtThree", "preferredRecallAtThree", "winnerPreferred", "noneSuitableAgreement"].map(metric => [metric, {
      mean: mean(cases.map(item => item.agreement[metric])), usableCases: cases.filter(item => item.agreement[metric] !== null).length }])) };
  });
  return { attemptedTrials: trials.length, succeededTrials: success.length, failedTrials: trials.filter(trial => trial.status === "failed").length, methods,
    interpretation: "Accuracy means agreement with the human labels, reported separately from repeat/layout stability. Cases have equal aggregate weight. This small set is not a tuning set or proof of general quality." };
}

const trialKey = trial => JSON.stringify([trial.caseId, trial.method, trial.variant, trial.repeat]);
export async function runApproachComparison({ manifestPath, outDir, run = false, maxCalls, previousRunPath, env = process.env, fetch: fetchImpl, trialTimeoutMs = 60_000 }) {
  const { manifest, subjects } = await loadReviewedComparison(manifestPath, { reviewed: run });
  const variants = comparisonVariants(), plannedTrials = manifest.cases.length * variants.length * COMPARISON_PROTOCOL.repeats;
  const maximumProviderCalls = manifest.cases.reduce((sum, item) => sum + maximumComparisonCalls(item.candidates.length), 0);
  const model = env.OPENAI_DECISIONS_MODEL?.trim() || "gpt-6-luna";
  const manifestHash = hashEvidence(manifest), attempted = new Set();
  let previous;
  if (previousRunPath) {
    previous = JSON.parse(await readFile(previousRunPath, "utf8"));
    const allowed = new Set(manifest.cases.flatMap(item => variants.flatMap(variant => Array.from({ length: COMPARISON_PROTOCOL.repeats }, (_, repeat) => trialKey({ caseId: item.id, ...variant, repeat })))));
    if (previous.version !== 1 || previous.manifestHash !== manifestHash || previous.model !== model
      || hashEvidence(previous.protocol) !== hashEvidence(COMPARISON_PROTOCOL) || !Number.isFinite(Date.parse(previous.finishedAt))
      || previous.plan?.plannedTrials !== plannedTrials || previous.plan?.maximumProviderCalls !== maximumProviderCalls
      || previous.plan?.trialTimeoutMs !== trialTimeoutMs || !Number.isSafeInteger(previous.reservedCalls)
      || previous.reservedCalls < 0 || previous.reservedCalls > maximumProviderCalls || !Array.isArray(previous.trials) || !Array.isArray(previous.usageRecords))
      throw new Error("The previous run must be finished and use the identical frozen labels, protocol, model and deadline.");
    for (const trial of previous.trials) {
      const key = trialKey(trial);
      if (!allowed.has(key) || attempted.has(key) || !["succeeded", "failed"].includes(trial.status)) throw new Error("Invalid previous trial history.");
      attempted.add(key);
    }
  }
  const plan = { dryRun: !run, cases: manifest.cases.length, judgments: manifest.cases.reduce((sum, item) => sum + item.candidates.length, 0),
    reviewedCases: manifest.cases.filter(item => item.review.humanReviewed && item.candidates.every(candidate => candidate.relevance !== null)).length,
    methods: COMPARISON_PROTOCOL.methods, variants, repeats: COMPARISON_PROTOCOL.repeats, plannedTrials, maximumProviderCalls, providerCalls: 0,
    previouslyAttemptedTrials: attempted.size, remainingTrials: plannedTrials - attempted.size, previousReservedCalls: previous?.reservedCalls ?? 0,
    trialTimeoutMs, note: "A common 60-second experiment deadline permits one-item-at-a-time judging; the report separately counts trials fitting the production 12-second deadline. Provider calls retain a 12-second timeout. Continuations use a fresh ledger and skip every attempted trial, including failures; the call cap covers all runs together." };
  if (!run) return plan;
  if (!decisionsConfig(env).ready || !Number.isSafeInteger(maxCalls) || maxCalls < maximumProviderCalls || maxCalls > 1000
    || typeof outDir !== "string" || !Number.isFinite(trialTimeoutMs) || trialTimeoutMs <= 0 || trialTimeoutMs > 60_000) throw new Error("Supply configured Decisions, a fresh output directory and a call cap covering the complete plan.");
  outDir = path.resolve(outDir); await mkdir(outDir, { recursive: true, mode: 0o700 });
  const ledgerPath = path.join(outDir, "run.json"), reportPath = path.join(outDir, "report.json");
  const ledger = { version: 1, protocol: COMPARISON_PROTOCOL, manifestHash, humanLabels: manifest.cases,
    startedAt: new Date().toISOString(), plan, maxCalls, reservedCalls: previous?.reservedCalls ?? 0,
    trials: structuredClone(previous?.trials ?? []), usageRecords: structuredClone(previous?.usageRecords ?? []), model,
    ...(previous ? { previousRun: { path: path.resolve(previousRunPath), hash: hashEvidence(previous) } } : {}) };
  await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  let writes = Promise.resolve();
  const save = () => writes = writes.then(() => atomicJson(ledgerPath, ledger, { mode: 0o600 }));
  for (const [caseIndex, item] of manifest.cases.entries()) {
    const subject = subjects[caseIndex];
    for (const variant of variants) for (let repeat = 0; repeat < COMPARISON_PROTOCOL.repeats; repeat++) {
      const trial = { caseId: item.id, method: variant.method, variant: variant.variant, repeat, status: "running" };
      if (attempted.has(trialKey(trial))) continue;
      ledger.trials.push(trial); await save();
      const started = performance.now(), callsBefore = ledger.reservedCalls, deadline = Date.now() + trialTimeoutMs;
      const usedImages = new Map(), ensureActive = () => { if (Date.now() >= deadline) throw Object.assign(new Error("Trial deadline reached"), { status: 504 }); };
      try {
        const pool = variant.seed === null || variant.seed === undefined ? subject.candidates : shuffledCandidates(subject.candidates, variant.seed);
        const result = await rankComparisonApproach({ candidates: pool, method: variant.method, seeds: variant.seeds, ensureActive,
          scoreBatch: async (batch, { phase, ensureActive: check }) => {
            const evidence = await prepareDiscoveryBatch(subject, batch, phase);
            for (const image of evidence.images) {
              if (usedImages.has(image.file) && usedImages.get(image.file).identity !== image.identity) throw new Error("Evidence changed");
              usedImages.set(image.file, image);
            }
            check();
            // Only production evidence/metadata enters this request. The human
            // labels above are retained for scoring and never passed to models.
            return rankWithDecisions({ ...evidence, brief: item.brief, env, fetch: fetchImpl, cacheMode: "bypass",
              namespace: [subject.source.fingerprint, item.id, variant.method, variant.variant, repeat], timeoutMs: Math.min(12_000, Math.max(1, deadline - Date.now())),
              beforePaidCall: async () => { check(); if (ledger.reservedCalls >= maxCalls) throw new Error("Call cap reached"); ledger.reservedCalls++; await save(); check(); },
              usageLog: async record => {
                const tagged = { ...record, caseId: item.id, method: variant.method, variant: variant.variant, repeat };
                const index = ledger.usageRecords.findIndex(row => row.id === record.id);
                if (index === -1) ledger.usageRecords.push(tagged); else ledger.usageRecords[index] = tagged;
                await save();
              } });
          } });
        if (!(await discoverySubjectUnchanged(manifest.dataDir, subject, [...usedImages.values()]))) throw new Error("Labeled snapshot changed");
        Object.assign(trial, result, { status: "succeeded", agreement: scoreHumanAgreement(result.rankings, item) });
      } catch (error) { Object.assign(trial, { status: "failed", failure: error.status === 504 ? "timeout" : "trial-failed" }); }
      trial.providerCalls = ledger.reservedCalls - callsBefore; trial.elapsedMs = performance.now() - started;
      trial.usage = summarizeDecisionUsage(ledger.usageRecords.filter(record => record.caseId === item.id && record.method === variant.method
        && record.variant === variant.variant && record.repeat === repeat), defaultDecisionPricing(ledger.model, env.OPENAI_API_BASE_URL));
      await save();
      if (trial.status === "failed") return finish();
    }
  }
  return finish();
  async function finish() {
    ledger.finishedAt = new Date().toISOString(); await save();
    const summary = summarizeComparison(ledger.trials), pricing = defaultDecisionPricing(ledger.model, env.OPENAI_API_BASE_URL);
    const report = { ...summary, newProviderReservations: ledger.reservedCalls - (previous?.reservedCalls ?? 0), methods: summary.methods.map(method => ({ ...method,
      usage: summarizeDecisionUsage(ledger.usageRecords.filter(record => record.method === method.method), pricing) })), plannedTrials, unattemptedTrials: plannedTrials - ledger.trials.length,
      maximumProviderCalls, reservedCalls: ledger.reservedCalls, usage: summarizeDecisionUsage(ledger.usageRecords, defaultDecisionPricing(ledger.model, env.OPENAI_API_BASE_URL)), ledgerPath, reportPath };
    await atomicJson(reportPath, report, { mode: 0o600 }); return report;
  }
}

export function parseComparisonArgs(args) {
  const options = { briefs: [] };
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (["--run", "--help"].includes(key)) { options[key.slice(2)] = true; continue; }
    if (!["--init", "--manifest", "--data-dir", "--out", "--brief", "--max-calls", "--continue-unattempted-from"].includes(key) || !args[index + 1] || args[index + 1].startsWith("--")) throw new Error("Unknown argument or missing value.");
    const value = args[++index];
    if (key === "--brief") options.briefs.push(value);
    else if (key === "--max-calls") { if (!/^\d+$/.test(value)) throw new Error("Call cap must be an integer"); options.maxCalls = Number(value); }
    else options[{ "--init": "init", "--manifest": "manifestPath", "--data-dir": "dataDir", "--out": "outDir", "--continue-unattempted-from": "previousRunPath" }[key]] = value;
  }
  if (options.init && (options.run || options.manifestPath || options.maxCalls || options.outDir || options.previousRunPath)) throw new Error("Initialization cannot be combined with run options.");
  return options;
}

export async function comparisonMain(args = process.argv.slice(2)) {
  const options = parseComparisonArgs(args);
  if (options.help) { console.log("Discovery accuracy comparison (offline by default)\n  --init PRIVATE_MANIFEST --data-dir PRIVATE_SNAPSHOT --brief BRIEF (repeat for cases)\n  --manifest PRIVATE_MANIFEST [--run --out PRIVATE_RUN_DIR --max-calls N]\nHuman suitability grades and preferred picks must be confirmed before --run. Existing ledgers cannot be overwritten or retried."); return; }
  const result = options.init ? await initializeDiscoveryComparison({ ...options, manifestPath: options.init }) : await runApproachComparison(options);
  console.log(JSON.stringify(result, null, 2));
  if (result.failedTrials) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) comparisonMain().catch(() => { console.error("Comparison could not finish. Check confirmed human labels, frozen snapshot, call cap and a fresh output directory. No automatic retry was made."); process.exitCode = 1; });
