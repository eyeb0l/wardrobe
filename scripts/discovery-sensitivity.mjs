import path from "node:path";
import { mkdir, lstat, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { hashEvidence, decisionsConfig } from "./decisions.mjs";
import { rankWithDecisions } from "./decision-ranking.mjs";
import { discoveryBatches, rankBatchedDiscovery, maximumBatchedDiscoveryCalls } from "./discovery-ranking.mjs";
import { loadDiscoverySubject, prepareDiscoveryBatch, discoverySubjectUnchanged } from "./outfit-discovery-api.mjs";
import { atomicJson } from "./outfit-storage.mjs";
import { orderDiscovery } from "../shared/outfit-discovery.mjs";
import { defaultDecisionPricing, summarizeDecisionUsage } from "./decision-usage.mjs";

const insist = (value, message) => { if (!value) throw new Error(message); };
export function shuffledCandidates(candidates, seed) {
  const result = [...candidates];
  let state = seed >>> 0;
  for (let index = result.length - 1; index > 0; index--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const other = Math.floor(state / 2 ** 32 * (index + 1));
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

export function sensitivityLayouts(candidates, seeds = [1, 2]) {
  const original = discoveryBatches(candidates);
  return [
    { id: "original", batches: original },
    { id: "reverse-batches", batches: [...original].reverse() },
    ...seeds.map(seed => ({ id: `shuffle-${seed}`, batches: discoveryBatches(shuffledCandidates(candidates, seed)) })),
  ].map(layout => ({ ...layout, candidates: layout.batches.flat() }));
}

export function compareDiscoveryJudgments(baseline, candidate) {
  const reference = new Map(baseline.map(row => [row.id, row]));
  const common = candidate.filter(row => reference.has(row.id));
  const differences = common.map(row => Math.abs(row.match - reference.get(row.id).match));
  const a = orderDiscovery(baseline).slice(0, 3).map(row => row.id);
  const b = orderDiscovery(candidate).slice(0, 3).map(row => row.id);
  return {
    commonCandidates: common.length,
    candidateSetOverlap: reference.size || candidate.length ? common.length / (reference.size + candidate.length - common.length) : null,
    evidenceStatusChanges: common.filter(row => row.evidence !== reference.get(row.id).evidence).length,
    meanAbsoluteScoreChange: differences.length ? differences.reduce((sum, value) => sum + value, 0) / differences.length : null,
    maximumScoreChange: differences.length ? Math.max(...differences) : null,
    winnerAgrees: a.length && b.length ? a[0] === b[0] : null,
    topThreeOverlap: a.length || b.length ? a.filter(id => b.includes(id)).length / Math.max(a.length, b.length) : null,
    missingBaselineTopThree: a.filter(id => !candidate.some(row => row.id === id)),
    qualifyingCandidates: { baseline: orderDiscovery(baseline).length, candidate: orderDiscovery(candidate).length },
  };
}

export function summarizeDiscoverySensitivity(trials) {
  const successful = trials.filter(trial => trial.status === "succeeded");
  const comparisons = [];
  for (const trial of successful) {
    const baseline = successful.find(row => row.briefIndex === trial.briefIndex && row.layout === "original" && row.repeat === 0);
    const repeated = successful.find(row => row.briefIndex === trial.briefIndex && row.layout === trial.layout && row.repeat === 0);
    const add = (reference, kind) => {
      if (reference && reference !== trial) comparisons.push({ briefIndex: trial.briefIndex, layout: trial.layout, repeat: trial.repeat, kind,
        screening: compareDiscoveryJudgments(reference.screeningRankings, trial.screeningRankings),
        final: compareDiscoveryJudgments(reference.rankings, trial.rankings) });
    };
    if (trial.repeat > 0) add(repeated, "repeat-noise");
    if (trial.repeat === 0 && trial.layout !== "original") add(baseline, trial.layout === "reverse-batches" ? "batch-order" : "batch-membership-and-order");
  }
  return { attemptedTrials: trials.length, succeededTrials: successful.length, failedTrials: trials.filter(trial => trial.status === "failed").length,
    incompleteTrials: trials.filter(trial => !["succeeded", "failed"].includes(trial.status)).length,
    comparisons, conclusion: "Stability measurements only. No human relevance labels or objective ranking accuracy are inferred." };
}

// Offline planning never sends images. Paid runs use a fresh, exclusive ledger,
// bypass response caching, reserve each call durably and never retry failures.
export async function runDiscoverySensitivity({ dataDir, outDir, briefs, seeds = [1, 2], repeats = 2, run = false, maxCalls,
  env = process.env, fetch: fetchImpl, timeoutMs = 12_000 }) {
  insist(typeof dataDir === "string" && typeof outDir === "string", "Supply --data-dir and --out.");
  insist(Array.isArray(briefs) && briefs.length > 0 && briefs.length <= 10 && briefs.every(brief => typeof brief === "string" && brief.trim() && brief.length <= 500), "Supply 1..10 nonempty briefs, at most 500 characters each.");
  insist(Number.isInteger(repeats) && repeats >= 2 && repeats <= 5, "Repeats must be 2..5 to measure ordinary variation.");
  insist(Array.isArray(seeds) && seeds.length > 0 && seeds.length <= 5 && new Set(seeds).size === seeds.length && seeds.every(seed => Number.isSafeInteger(seed) && seed >= 0 && seed <= 0xffffffff), "Supply 1..5 unique unsigned 32-bit shuffle seeds.");
  insist(Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= 12_000, "Timeout must be within 1..12000 ms.");
  dataDir = path.resolve(dataDir); outDir = path.resolve(outDir);
  const subjects = await Promise.all(briefs.map(brief => loadDiscoverySubject(dataDir, { brief: brief.trim() })));
  insist(subjects.every(subject => subject.candidates.length > 12), "Batch-sensitivity evaluation needs more than 12 eligible saved looks.");
  const plannedCalls = subjects.reduce((sum, subject) => sum + maximumBatchedDiscoveryCalls(subject.candidates.length) * (2 + seeds.length) * repeats, 0);
  const plan = { version: 1, dryRun: !run, candidateCounts: subjects.map(subject => subject.candidates.length),
    layouts: ["original", "reverse-batches", ...seeds.map(seed => `shuffle-${seed}`)], repeats, briefCount: briefs.length,
    plannedTrials: briefs.length * (2 + seeds.length) * repeats, maximumProviderCalls: plannedCalls,
    callBound: "Includes screening, worst-case near-tie reductions and the shared final comparison.",
    evidence: "Actual saved photos and garment cutouts from the supplied private snapshot.",
    providerCalls: 0 };
  if (run) {
    insist(decisionsConfig(env).ready, "Enable Decisions and supply the existing server-only OpenAI key before a paid run.");
    insist(Number.isSafeInteger(maxCalls) && maxCalls >= plannedCalls && maxCalls <= 1000, `--max-calls must cover the plan's upper bound of ${plannedCalls} calls (maximum 1000).`);
  }
  await mkdir(outDir, { recursive: true, mode: 0o700 });
  insist(!(await lstat(outDir)).isSymbolicLink(), "Evaluation output cannot be a symlink.");
  if (!run) {
    const planPath = path.join(outDir, "plan.json");
    await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    return { ...plan, planPath };
  }
  const ledgerPath = path.join(outDir, "run.json"), reportPath = path.join(outDir, "report.json");
  const ledger = { version: 1, plan, startedAt: new Date().toISOString(), maxCalls, reservedCalls: 0, trials: [], usageRecords: [],
    snapshotHashes: subjects.map(subject => subject.source.fingerprint), briefs, model: env.OPENAI_DECISIONS_MODEL?.trim() || "gpt-6-luna" };
  await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  let writes = Promise.resolve();
  const save = () => writes = writes.then(() => atomicJson(ledgerPath, ledger, { mode: 0o600 }));
  for (const [briefIndex, subject] of subjects.entries()) {
    for (const layout of sensitivityLayouts(subject.candidates, seeds)) {
      for (let repeat = 0; repeat < repeats; repeat++) {
        const trial = { briefIndex, layout: layout.id, repeat, status: "running", candidateOrder: layout.candidates.map(candidate => candidate.id) };
        ledger.trials.push(trial); await save();
        const started = performance.now(), deadline = Date.now() + timeoutMs, usedImages = new Map();
        const ensureActive = () => { if (Date.now() >= deadline) throw Object.assign(new Error("Evaluation trial timed out"), { status: 504 }); };
        try {
          const result = await rankBatchedDiscovery({ candidates: layout.candidates, initialBatches: layout.batches, ensureActive, scoreBatch: async (batch, { phase, ensureActive: check }) => {
            const evidence = await prepareDiscoveryBatch(subject, batch, phase);
            for (const image of evidence.images) {
              insist(!usedImages.has(image.file) || usedImages.get(image.file).identity === image.identity, "Evaluation evidence changed.");
              usedImages.set(image.file, image);
            }
            check();
            return rankWithDecisions({ ...evidence, brief: briefs[briefIndex].trim(), env, fetch: fetchImpl,
              cacheMode: "bypass", namespace: hashEvidence([subject.source.fingerprint, briefIndex, layout.id, repeat]),
              timeoutMs: Math.max(1, deadline - Date.now()),
              beforePaidCall: async () => {
                check(); insist(ledger.reservedCalls < maxCalls, "The durable evaluation call cap has been reached.");
                ledger.reservedCalls++; await save(); check();
              },
              usageLog: async record => {
                const index = ledger.usageRecords.findIndex(item => item.id === record.id);
                if (index === -1) ledger.usageRecords.push(record); else ledger.usageRecords[index] = record;
                await save();
              },
            });
          } });
          insist(await discoverySubjectUnchanged(dataDir, subject, [...usedImages.values()]), "Evaluation snapshot changed.");
          Object.assign(trial, result, { status: "succeeded" });
        } catch (error) {
          Object.assign(trial, { status: "failed", failure: error.status === 504 ? "timeout" : "trial-failed" });
        }
        trial.elapsedMs = performance.now() - started;
        await save();
        // Never push ahead after a failed or uncertain paid trial.
        if (trial.status === "failed") return finish();
      }
    }
  }
  return finish();
  async function finish() {
    ledger.finishedAt = new Date().toISOString(); await save();
    const report = { ...summarizeDiscoverySensitivity(ledger.trials), plannedTrials: plan.plannedTrials, unattemptedTrials: plan.plannedTrials - ledger.trials.length,
      maximumProviderCalls: plannedCalls, reservedCalls: ledger.reservedCalls,
      usage: summarizeDecisionUsage(ledger.usageRecords, defaultDecisionPricing(ledger.model, env.OPENAI_API_BASE_URL)),
      latencyMs: ledger.trials.map(({ briefIndex, layout, repeat, elapsedMs, status }) => ({ briefIndex, layout, repeat, elapsedMs, status })),
      ledgerPath, reportPath };
    await atomicJson(reportPath, report, { mode: 0o600 });
    return report;
  }
}
