import { readFile, writeFile, mkdir, rename, open, rm, realpath, stat, lstat, chmod } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { decide, hashEvidence, DECISIONS_MODEL, validateDecisionAnswers } from "./decisions.mjs";
import { prepareEvidence, evidenceUnchanged } from "./decision-images.mjs";
import { imageCheckRequest, imageCheckRubric, formatImageChecks, IMAGE_CHECK_CONFIDENCE, IMAGE_CHECK_VERSION } from "./decision-checks.mjs";
import { defaultDecisionPricing, validateDecisionPricing, summarizeDecisionUsage } from "./decision-usage.mjs";

export class EvaluationError extends Error {}
const insist = (condition, message) => { if (!condition) throw new EvaluationError(message); };
const object = value => value && typeof value === "object" && !Array.isArray(value);
const identifier = value => typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,79}$/.test(value);
const states = ["clear", "concern", "unknown"];
const text = (value, max) => typeof value === "string" && value.length <= max;
const now = () => new Date().toISOString();
const rate = (numerator, denominator) => ({ numerator, denominator, rate: denominator ? numerator / denominator : null });

const scenarios = [
  "faithful-simple-outfit", "faithful-layered-outfit", "faithful-patterned-dress", "faithful-lighting-change", "faithful-natural-drape",
  "changed-neckline", "changed-sleeve-length", "changed-hem-length", "changed-pattern", "changed-closure",
  "missing-selected-piece", "hidden-selected-piece", "wrong-shoes", "added-accessory", "malformed-hand",
  "duplicated-limb", "cropped-feet", "extra-person", "ambiguous-small-detail", "permitted-plain-tights",
  "complete-clear-crop", "cut-off-sleeve", "cut-off-shoe-pair", "competing-garments", "blurred-crop-detail",
];

export function evaluationTemplate() {
  return { version: 1, name: "wardrobe-decisions-evaluation", cases: scenarios.map((id, index) => {
    const kind = index < 20 ? "outfit-review" : "preflight";
    return { id, family: id, kind, split: index % 3 === 2 ? "confirmation" : "calibration", evidence: [],
      metadata: kind === "outfit-review" ? { garments: [] } : { category: "", name: "" },
      expected: Object.fromEntries(imageCheckRubric(kind).map(item => [item.name, null])),
      review: { humanReviewed: false, reviewedAt: null },
      notes: "Select representative private images and label each independent check before running live. The scenario is a selection hint, not a ground-truth label." };
  }) };
}

async function privateDirectory(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  insist(!(await lstat(dir)).isSymbolicLink(), "Evaluation output must not be a symlink.");
  await chmod(dir, 0o700);
}

async function privateWrite(file, contents) {
  const temporary = path.join(path.dirname(file), `.decision-eval-${randomUUID()}.tmp`);
  const fd = await open(temporary, "wx", 0o600);
  try {
    try { await fd.writeFile(contents); await fd.sync(); } finally { await fd.close(); }
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}
const save = (file, value) => privateWrite(file, `${JSON.stringify(value, null, 2)}\n`);

async function json(file, fallback) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT" && fallback !== undefined) return fallback; throw error; }
}

export async function initializeDecisionEvaluation(dir) {
  dir = path.resolve(dir);
  await privateDirectory(dir);
  await privateDirectory(path.join(dir, "images"));
  const manifestPath = path.join(dir, "suite.json");
  await writeFile(manifestPath, `${JSON.stringify(evaluationTemplate(), null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return { manifestPath, plannedCases: 25, humanReviewedCases: 0, providerCalls: 0 };
}

function checkedMetadata(kind, metadata, labels) {
  insist(object(metadata), "Case metadata must be an object.");
  if (kind === "preflight") {
    insist(Object.keys(metadata).every(key => ["category", "name"].includes(key)) && text(metadata.category, 80) && text(metadata.name, 200), "Crop metadata only accepts bounded category and name fields.");
    return { category: metadata.category, name: metadata.name };
  }
  insist(Object.keys(metadata).every(key => key === "garments") && Array.isArray(metadata.garments) && metadata.garments.length <= 20, "Outfit metadata requires at most 20 garment records.");
  const garments = metadata.garments.map((garment, index) => {
    insist(object(garment) && Object.keys(garment).every(key => ["id", "name", "part", "color", "tags", "outerConstruction", "visualEvidence"].includes(key))
      && text(garment.name, 200) && text(garment.part, 80) && (garment.id === undefined || identifier(garment.id))
      && (garment.color === undefined || text(garment.color, 80)) && (garment.outerConstruction === undefined || text(garment.outerConstruction, 80))
      && (garment.tags === undefined || (Array.isArray(garment.tags) && garment.tags.length <= 20 && garment.tags.every(tag => text(tag, 80)))), "Garment metadata contains unsupported or unbounded fields.");
    insist(garment.visualEvidence === undefined || garment.visualEvidence === `garment_${index}`, "Garment reference labels must follow garment order.");
    return { ...garment, visualEvidence: `garment_${index}` };
  });
  if (labels.length) insist(garments.length > 0 && garments.length + 1 === labels.length && garments.every((_, index) => labels.includes(`garment_${index}`)), "Every selected garment needs its own labeled cutout.");
  return { garments };
}

export function validateEvaluationManifest(manifest) {
  insist(object(manifest) && manifest.version === 1 && identifier(manifest.name) && Array.isArray(manifest.cases) && manifest.cases.length > 0 && manifest.cases.length <= 100, "Evaluation manifest needs version 1, a safe name and 1..100 cases.");
  const ids = new Set(), familySplits = new Map();
  return { version: 1, name: manifest.name, cases: manifest.cases.map(item => {
    insist(object(item) && identifier(item.id) && !ids.has(item.id) && identifier(item.family) && ["outfit-review", "preflight"].includes(item.kind)
      && ["calibration", "confirmation"].includes(item.split), "Cases need unique safe IDs, a family, a supported kind and split.");
    ids.add(item.id);
    insist(!familySplits.has(item.family) || familySplits.get(item.family) === item.split, "Related case families cannot appear in both calibration and confirmation.");
    familySplits.set(item.family, item.split);
    const rubric = imageCheckRubric(item.kind), names = rubric.map(check => check.name);
    insist(object(item.expected) && Object.keys(item.expected).length === names.length && names.every(name => states.includes(item.expected[name]) || item.expected[name] === null), "Every rubric check needs a human label or explicit null pending label.");
    insist(object(item.review) && typeof item.review.humanReviewed === "boolean"
      && (item.review.reviewedAt === null || (typeof item.review.reviewedAt === "string" && Number.isFinite(Date.parse(item.review.reviewedAt)))), "Cases need an explicit human review status and date.");
    insist(Array.isArray(item.evidence) && item.evidence.length <= 21 && item.evidence.every(entry => object(entry) && typeof entry.file === "string" && entry.file.length <= 400
      && !path.isAbsolute(entry.file) && !entry.file.split(/[\\/]/).some(part => ["..", "."].includes(part)) && !/[\0\\]/.test(entry.file)
      && /\.(png|jpe?g|webp)$/i.test(entry.file) && typeof entry.label === "string"), "Evidence must use relative contained PNG, JPEG or WebP files.");
    const labels = item.evidence.map(entry => entry.label);
    insist(new Set(labels).size === labels.length && labels.every(label => item.kind === "preflight" ? ["source", "target"].includes(label) : label === "result" || /^garment_(?:[0-9]|1[0-9])$/.test(label))
      && (!labels.length || (item.kind === "preflight" ? labels.length === 2 : labels.includes("result"))), "Evidence labels must identify the result and references unambiguously.");
    const metadata = checkedMetadata(item.kind, item.metadata, labels);
    const reviewed = item.review.humanReviewed && item.review.reviewedAt !== null && names.every(name => states.includes(item.expected[name]));
    return { id: item.id, family: item.family, kind: item.kind, split: item.split, metadata, evidence: item.evidence.map(({ file, label }) => ({ file, label })),
      expected: { ...item.expected }, review: { ...item.review }, ready: reviewed && labels.length > 0 };
  }) };
}

async function containedEvidence(base, entries) {
  const root = await realpath(base);
  return Promise.all(entries.map(async entry => {
    const file = await realpath(path.resolve(root, entry.file));
    insist(file.startsWith(`${root}${path.sep}`) && (await stat(file)).isFile(), "Evidence escaped the dataset directory.");
    return { label: entry.label, file };
  }));
}

async function prepareSchedule(manifest, base, model, rubricVersion) {
  const items = []; let totalBytes = 0;
  for (const item of manifest.cases) {
    if (!item.evidence.length) { items.push({ ...item, requestHash: null, input: null, preparationMs: 0 }); continue; }
    const started = Date.now(), entries = await containedEvidence(base, item.evidence), images = await prepareEvidence(entries);
    insist(await evidenceUnchanged(images), "Evaluation evidence changed while preparing the run.");
    const request = { model, ...imageCheckRequest(item.kind, { images, metadata: item.metadata, rubricVersion }) };
    const bytes = Buffer.byteLength(JSON.stringify(request)); totalBytes += bytes;
    insist(bytes <= 8 * 1024 * 1024 && totalBytes <= 64 * 1024 * 1024, "Evaluation evidence exceeds the per-request or 64 MiB suite limit. Select fewer cases.");
    items.push({ ...item, requestHash: hashEvidence(request), input: request, preparationMs: Date.now() - started,
      imageHashes: images.map(image => ({ label: image.label, hash: hashEvidence(image.image_url) })) });
  }
  return items;
}

const percentile = (values, fraction) => values.length ? [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * fraction) - 1)] : null;
function scoreCases(cases, attempts, threshold, rubricVersion) {
  const byCheck = new Map(), rows = [];
  for (const item of cases) {
    const attempt = attempts[item.id], result = attempt?.result;
    const predictions = result ? formatImageChecks(item.kind, result, threshold, rubricVersion).checks : [];
    const checks = imageCheckRubric(item.kind, rubricVersion).map(check => {
      const expected = item.expected[check.name], predicted = predictions.find(prediction => prediction.id === check.name)?.state ?? null;
      const key = `${item.kind}:${check.name}`;
      if (!byCheck.has(key)) byCheck.set(key, { kind: item.kind, id: check.name, labeled: 0, evaluated: 0, unevaluated: 0,
        confusion: Object.fromEntries(states.map(state => [state, Object.fromEntries(states.map(other => [other, 0]))])) });
      const metrics = byCheck.get(key);
      if (expected !== null) { metrics.labeled++; if (predicted === null) metrics.unevaluated++; else { metrics.evaluated++; metrics.confusion[expected][predicted]++; } }
      return { id: check.name, expected, predicted, refusal: result?.answers.find(answer => answer.name === check.name)?.type === "refusal" };
    });
    rows.push({ id: item.id, family: item.family, kind: item.kind, split: item.split, status: result ? "evaluated" : attempt?.state || "pending",
      checks, missedDefects: checks.filter(check => check.expected === "concern" && check.predicted === "clear").map(check => check.id),
      falseWarnings: checks.filter(check => check.expected === "clear" && check.predicted === "concern").map(check => check.id),
      unsupportedClear: checks.filter(check => check.expected === "unknown" && check.predicted === "clear").map(check => check.id) });
  }
  const checkMetrics = [...byCheck.values()].map(item => {
    const matrix = item.confusion, concerns = Object.values(matrix.concern).reduce((a, b) => a + b, 0), clear = Object.values(matrix.clear).reduce((a, b) => a + b, 0);
    return { ...item, missedDefectRate: rate(matrix.concern.clear, concerns), falseWarningRate: rate(matrix.clear.concern, clear),
      uncertaintyRate: rate(states.reduce((sum, expected) => sum + matrix[expected].unknown, 0), item.evaluated),
      defectReviewCoverage: rate(matrix.concern.concern + matrix.concern.unknown, concerns) };
  });
  return { threshold, caseCount: cases.length, evaluatedCases: rows.filter(row => row.status === "evaluated").length,
    uniqueFamilies: new Set(cases.map(item => item.family)).size, smallSample: new Set(cases.map(item => item.family)).size < 30,
    casesWithMissedDefects: rows.filter(row => row.missedDefects.length).length, casesWithFalseWarnings: rows.filter(row => row.falseWarnings.length).length,
    casesWithUnsupportedClear: rows.filter(row => row.unsupportedClear.length).length, checks: checkMetrics, cases: rows };
}

export function summarizeDecisionEvaluation(ledger) {
  const attempts = Object.values(ledger.attempts), cases = ledger.cases, rubricVersion = ledger.rubricVersion ?? IMAGE_CHECK_VERSION;
  const records = attempts.flatMap(attempt => attempt.usageRecord ? [attempt.usageRecord] : attempt.state !== "blocked" ? [{ source: "provider", dispatchState: "unknown", outcome: attempt.state === "failed" ? "failed" : "unknown", model: ledger.model }] : []);
  const timings = records.map(record => record.elapsedMs).filter(value => Number.isFinite(value));
  const preparation = cases.filter(item => item.requestHash).map(item => item.preparationMs);
  const combined = cases.flatMap(item => Number.isFinite(ledger.attempts[item.id]?.usageRecord?.elapsedMs) ? [item.preparationMs + ledger.attempts[item.id].usageRecord.elapsedMs] : []);
  return { version: 1, generatedAt: now(), model: ledger.model, rubricVersion, manifestHash: ledger.manifestHash, rubricHash: ledger.rubricHash,
    maxCalls: ledger.maxCalls, requestedCases: cases.length, pendingLabelsOrImages: cases.filter(item => !item.ready).map(item => item.id),
    providerUsage: summarizeDecisionUsage(records, ledger.pricing),
    latencyMs: { count: timings.length, median: percentile(timings, .5), p95: percentile(timings, .95),
      imagePreparation: { count: preparation.length, median: percentile(preparation, .5), p95: percentile(preparation, .95) },
      combined: { count: combined.length, median: percentile(combined, .5), p95: percentile(combined, .95) },
      note: "Request wall time includes quota and logging. Combined time adds measured image preparation; it is not a hosted end-to-end benchmark. p95 is exploratory for small samples." },
    defaultThreshold: ledger.threshold,
    calibration: [...new Set([.5, .6, ledger.threshold, .85, .9])].sort((a, b) => a - b).map(threshold => scoreCases(cases.filter(item => item.split === "calibration"), ledger.attempts, threshold, rubricVersion)),
    confirmation: scoreCases(cases.filter(item => item.split === "confirmation"), ledger.attempts, ledger.threshold, rubricVersion),
    note: "Only human-reviewed labels are ground truth. Unknowns and refusals require review. Provider failures remain unevaluated. This report does not authorize audit skipping or automatic acceptance." };
}

export function renderDecisionEvaluation(report) {
  const base = report.calibration.find(item => item.threshold === report.defaultThreshold);
  const lines = ["# Decisions image evaluation", "", `Model: ${report.model}. Current review threshold: ${report.defaultThreshold}.`, "",
    `Rubric version: ${report.rubricVersion}.`, "",
    `${report.requestedCases} selected cases; ${report.pendingLabelsOrImages.length} still need images or human labels.`, "",
    `Provider calls: ${report.providerUsage.providerCalls}; failures: ${report.providerUsage.failed}; unfinished: ${report.providerUsage.unfinished}.`, "",
    `Observed input tokens: ${report.providerUsage.usage.inputTokens.observed}; calls with unknown input usage: ${report.providerUsage.usage.inputTokens.unknownCalls}.`, "",
    report.providerUsage.cost.knownCalls ? `Estimated cost for ${report.providerUsage.cost.knownCalls} known calls: $${report.providerUsage.cost.estimatedLowerUsd.toFixed(6)}–$${report.providerUsage.cost.estimatedUpperUsd.toFixed(6)}. ${report.providerUsage.cost.unknownCalls} calls have unknown cost. This is a rate-based estimate, not an invoice.` : "Cost has not been measured for any provider calls.", "",
    "| Split | Cases | Evaluated | Cases with missed defects | Cases with false warnings |", "| --- | ---: | ---: | ---: | ---: |",
    ...[base, report.confirmation].map((item, index) => `| ${index ? "Confirmation" : "Calibration"} | ${item.caseCount} | ${item.evaluatedCases} | ${item.casesWithMissedDefects} | ${item.casesWithFalseWarnings} |`), "",
    "## Calibration threshold replay", "", "| Threshold | Evaluated | Missed defects | False warnings |", "| --- | ---: | ---: | ---: |",
    ...report.calibration.map(item => `| ${item.threshold} | ${item.evaluatedCases} | ${item.casesWithMissedDefects} | ${item.casesWithFalseWarnings} |`), "",
    "The confirmation split is reported only at the current threshold. Related families stay in one split. Threshold replay makes no provider calls.", "",
    "## Cases to inspect", "", ...[...base.cases, ...report.confirmation.cases].filter(item => item.missedDefects.length || item.falseWarnings.length || item.unsupportedClear.length || item.status !== "evaluated")
      .map(item => `- ${item.id}: ${item.status}; missed ${item.missedDefects.join(", ") || "none"}; false warnings ${item.falseWarnings.join(", ") || "none"}; unsupported clear ${item.unsupportedClear.join(", ") || "none"}.`), "",
    report.latencyMs.note, "", "Fewer than 30 independent families is a small sample. Fixtures verify report arithmetic and integration, not visual accuracy.", "", report.note, ""];
  return lines.join("\n");
}

export async function runDecisionEvaluation({ manifestPath, outDir, run = false, maxCalls, caseIds, split, pricing, rubricVersion = IMAGE_CHECK_VERSION,
  env = process.env, fetch: fetchImpl = fetch, onProgress = () => {} }) {
  insist(manifestPath && outDir, "Specify --manifest and --out.");
  imageCheckRubric("outfit-review", rubricVersion);
  insist(maxCalls === undefined || (Number.isSafeInteger(maxCalls) && maxCalls > 0 && maxCalls <= 100), "--max-calls must be 1..100.");
  insist(!run || (Number.isSafeInteger(maxCalls) && maxCalls > 0 && maxCalls <= 100), "Live evaluation requires --max-calls 1..100.");
  const model = env.OPENAI_DECISIONS_MODEL?.trim() || DECISIONS_MODEL;
  const endpoint = (env.OPENAI_API_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  if (run) insist(env.OPENAI_API_KEY?.trim(), "Live evaluation needs the existing server-side OPENAI_API_KEY.");
  insist((await stat(path.resolve(manifestPath))).size <= 1024 * 1024, "The evaluation manifest exceeds 1 MiB.");
  const full = validateEvaluationManifest(await json(path.resolve(manifestPath)));
  if (split) insist(["calibration", "confirmation"].includes(split), "Select calibration or confirmation.");
  if (caseIds) insist(Array.isArray(caseIds) && caseIds.length && new Set(caseIds).size === caseIds.length && caseIds.every(id => full.cases.some(item => item.id === id)), "Select unique existing case IDs.");
  const manifest = { ...full, cases: full.cases.filter(item => (!caseIds || caseIds.includes(item.id)) && (!split || item.split === split)) };
  insist(manifest.cases.length, "The case selection is empty.");
  if (run) insist(manifest.cases.every(item => item.ready), "Selected cases need complete human labels, a review date and image evidence before live evaluation.");
  const selectedPricing = pricing ? validateDecisionPricing(pricing, model) : defaultDecisionPricing(model, endpoint);
  const schedule = await prepareSchedule(manifest, path.dirname(path.resolve(manifestPath)), model, rubricVersion);
  const manifestHash = hashEvidence(manifest), rubricHash = hashEvidence([IMAGE_CHECK_CONFIDENCE, imageCheckRequest("outfit-review", { images: [], metadata: {}, rubricVersion }), imageCheckRequest("preflight", { images: [], metadata: {}, rubricVersion })]);
  outDir = path.resolve(outDir);
  await privateDirectory(outDir);
  const lock = path.join(outDir, ".runner-lock");
  try { await mkdir(lock, { mode: 0o700 }); } catch { throw new EvaluationError("Evaluation output is locked. Verify the previous process stopped before clearing .runner-lock."); }
  try {
    const ledgerPath = path.join(outDir, "ledger.json");
    const stored = await json(ledgerPath, null);
    const cases = schedule.map(({ input, evidence, metadata, ...item }) => item);
    const descriptor = { manifestHash, rubricHash, rubricVersion, model, threshold: IMAGE_CHECK_CONFIDENCE, endpointHash: hashEvidence(endpoint), pricing: selectedPricing, cases };
    const ledger = stored || { version: 1, ...descriptor, maxCalls: maxCalls ?? null, attempts: {}, createdAt: now() };
    if (stored) {
      insist(ledger.version === 1 && (ledger.rubricVersion ?? IMAGE_CHECK_VERSION) === rubricVersion && ledger.manifestHash === manifestHash && ledger.rubricHash === rubricHash && ledger.model === model
        && ledger.threshold === IMAGE_CHECK_CONFIDENCE
        && ledger.endpointHash === descriptor.endpointHash && hashEvidence(ledger.pricing) === hashEvidence(selectedPricing)
        && hashEvidence(ledger.cases.map(({ preparationMs, ...item }) => item)) === hashEvidence(cases.map(({ preparationMs, ...item }) => item)), "Frozen run changed. Preserve it and choose a new output directory.");
      insist(object(ledger.attempts) && Object.entries(ledger.attempts).every(([id, attempt]) => cases.some(item => item.id === id)
        && object(attempt) && ["dispatching", "succeeded", "refused", "failed", "blocked"].includes(attempt.state)
        && attempt.requestHash === cases.find(item => item.id === id).requestHash
        && (!["succeeded", "refused"].includes(attempt.state) || attempt.result)), "Evaluation ledger is invalid; preserve and repair it before continuing.");
      try { for (const [id, attempt] of Object.entries(ledger.attempts)) if (attempt.result) validateDecisionAnswers(attempt.result, imageCheckRubric(cases.find(item => item.id === id).kind, rubricVersion).map(item => item.question), model); }
      catch { throw new EvaluationError("Recorded answers are invalid; preserve and repair the ledger before continuing."); }
      if (run && ledger.maxCalls !== null) insist(ledger.maxCalls === maxCalls, "A resumed run must keep its original call limit.");
      if (run && ledger.maxCalls === null) ledger.maxCalls = maxCalls;
    }
    if (run) {
      const pending = schedule.filter(item => !ledger.attempts[item.id]);
      const reserved = Object.values(ledger.attempts).filter(attempt => attempt.state !== "blocked").length;
      insist(reserved + pending.length <= ledger.maxCalls, "The frozen run would exceed its call limit. Select a smaller suite in a new output directory.");
    }
    await save(ledgerPath, ledger);
    let newProviderCalls = 0;
    for (const item of run ? schedule : []) {
      if (ledger.attempts[item.id]) continue; // Sent and uncertain calls are never retried automatically.
      const attempt = { state: "dispatching", startedAt: now(), requestHash: item.requestHash, result: null, usageRecord: null };
      ledger.attempts[item.id] = attempt;
      // Persist intent before even entering the client. A crash may have sent
      // this request; resuming preserves the uncertainty and call allowance.
      await save(ledgerPath, ledger);
      let lastUsage;
      try {
        const result = await decide({ ...item.input, env: { ...env, WARDROBE_DECISIONS_ENABLED: "1" }, namespace: ["evaluation", outDir, item.id],
          fetch: fetchImpl, cacheMode: "bypass", timeoutMs: 12_000,
          usageLog: async record => { lastUsage = record; },
          beforePaidCall: async () => { await save(ledgerPath, ledger); } });
        attempt.state = result.answers.some(answer => answer.type === "refusal") ? "refused" : "succeeded";
        attempt.result = result;
      } catch (error) {
        attempt.state = lastUsage?.dispatchState === "not-sent" ? "blocked" : "failed";
        attempt.failure = error.status === 504 ? "timeout" : lastUsage?.failure || "request-failed";
      }
      attempt.usageRecord = lastUsage || null;
      if (lastUsage?.dispatchState === "sent") newProviderCalls++;
      attempt.finishedAt = now();
      await save(ledgerPath, ledger);
      await onProgress({ caseId: item.id, state: attempt.state });
      // Authentication, transport, malformed output and timeouts need inspection
      // before spending on more cases. Partial refusals remain independently scored.
      if (["failed", "blocked"].includes(attempt.state)) break;
    }
    const report = summarizeDecisionEvaluation(ledger);
    await save(path.join(outDir, "report.json"), report);
    await privateWrite(path.join(outDir, "report.md"), renderDecisionEvaluation(report));
    return { dryRun: !run, newProviderCalls, reportPath: path.join(outDir, "report.md"), reportJsonPath: path.join(outDir, "report.json"), ledgerPath,
      plannedCalls: schedule.length, pendingCalls: schedule.filter(item => !ledger.attempts[item.id]).length, ...report };
  } finally { await rm(lock, { recursive: true, force: true }); }
}
