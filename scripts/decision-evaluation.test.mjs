import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile, writeFile, stat, symlink, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import sharp from "sharp";
import { spawnSync } from "node:child_process";
import { imageCheckRequest, imageCheckRubric, checkDecisionImages } from "./decision-checks.mjs";
import { prepareEvidence } from "./decision-images.mjs";
import { decisionsResponse } from "./test-helpers/decisions-response.mjs";
import { evaluationTemplate, validateEvaluationManifest, initializeDecisionEvaluation, runDecisionEvaluation, summarizeDecisionEvaluation, renderDecisionEvaluation } from "./decision-evaluation.mjs";
import { parseEvaluationArgs } from "./decision-evaluation-runner.mjs";

const env = { OPENAI_API_KEY: "evaluation-test-key" };
const labels = kind => Object.fromEntries(imageCheckRubric(kind).map(check => [check.name, "clear"]));
function caseRecord(id, overrides = {}) {
  return { id, kind: "outfit-review", family: id, split: "calibration", evidence: [{ label: "result", file: "images/result.png" }, { label: "garment_0", file: "images/garment.png" }],
    metadata: { garments: [{ id: "dress", name: "Blue dress", part: "dresses" }] }, expected: labels("outfit-review"), review: { humanReviewed: true, reviewedAt: "2026-10-06T12:00:00Z" }, ...overrides };
}
async function fixture(t, cases = [caseRecord("clear")]) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "decision-evaluation-")); t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, "images"));
  await sharp({ create: { width: 80, height: 120, channels: 4, background: "#2050a0" } }).png().toFile(path.join(dir, "images/result.png"));
  await sharp({ create: { width: 60, height: 90, channels: 4, background: "#2870af" } }).png().toFile(path.join(dir, "images/garment.png"));
  const manifest = { version: 1, name: "synthetic-contract-fixture", cases };
  const manifestPath = path.join(dir, "suite.json"); await writeFile(manifestPath, JSON.stringify(manifest));
  return { dir, manifestPath, manifest, outDir: path.join(dir, "run"), env };
}
const responseFor = (body, changes = {}) => {
  const result = decisionsResponse(body);
  result.usage = { input_tokens: 1000, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens: 0, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 1000 };
  result.answers.forEach(answer => {
    const value = changes[answer.name];
    if (value === "refusal") { Object.keys(answer).forEach(key => delete answer[key]); Object.assign(answer, { type: "refusal", name: body.questions[result.answers.indexOf(answer)].name }); }
    else if (value) { answer.choice = value.choice; answer.confidence = value.confidence; answer.probabilities.forEach(item => { item.probability = item.value === value.choice ? 1 : 0; }); }
  });
  return result;
};

test("private 25-case scaffold keeps labels pending and never overwrites a dataset", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "decision-scaffold-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const result = await initializeDecisionEvaluation(path.join(dir, "dataset"));
  const suite = validateEvaluationManifest(JSON.parse(await readFile(result.manifestPath, "utf8")));
  assert.equal(suite.cases.length, 25); assert.equal(suite.cases.filter(item => item.kind === "outfit-review").length, 20);
  assert.ok(suite.cases.every(item => !item.ready && Object.values(item.expected).every(value => value === null)));
  assert.equal((await stat(result.manifestPath)).mode & 0o777, 0o600); assert.equal((await stat(path.dirname(result.manifestPath))).mode & 0o777, 0o700);
  await assert.rejects(initializeDecisionEvaluation(path.dirname(result.manifestPath)), { code: "EEXIST" });
  const report = await runDecisionEvaluation({ manifestPath: result.manifestPath, outDir: path.join(dir, "plan"), fetch: async () => assert.fail("Offline plans cannot call a provider") });
  assert.equal(report.providerUsage.providerCalls, 0); assert.equal(report.pendingLabelsOrImages.length, 25);
  assert.equal(report.calibration[0].evaluatedCases, 0);
});

test("runner uses the exact production rubric and actual prepared images without leaking labels or notes", async t => {
  const h = await fixture(t, [caseRecord("case-one", { notes: "PRIVATE ANSWER GUIDE", expected: { ...labels("outfit-review"), fidelity: "concern" } })]);
  const prepared = await prepareEvidence(h.manifest.cases[0].evidence.map(entry => ({ label: entry.label, file: path.join(h.dir, entry.file) })));
  let request, calls = 0;
  const fetch = async (_, init) => { calls++; request = JSON.parse(init.body); return Response.json(responseFor(request)); };
  const result = await runDecisionEvaluation({ ...h, run: true, maxCalls: 1, fetch });
  assert.equal(calls, 1); assert.equal(request.input[0].content.filter(part => part.type === "input_image").length, 2);
  const expected = imageCheckRequest("outfit-review", { images: prepared, metadata: { garments: [{ ...h.manifest.cases[0].metadata.garments[0], visualEvidence: "garment_0" }] } });
  assert.deepEqual(request.questions, expected.questions); assert.deepEqual(request.input, expected.input);
  assert.doesNotMatch(JSON.stringify(request), /humanReviewed|expected|PRIVATE ANSWER|evaluation-test-key|images\/result/);
  assert.equal(result.calibration.find(item => item.threshold === .75).casesWithMissedDefects, 1);
  const ledger = JSON.parse(await readFile(result.ledgerPath, "utf8"));
  assert.equal(ledger.attempts["case-one"].result.cached, false);
  assert.doesNotMatch(JSON.stringify(ledger), /data:image|evaluation-test-key|Blue dress/);
  const again = await runDecisionEvaluation({ ...h, run: true, maxCalls: 1, fetch });
  assert.equal(calls, 1); assert.equal(again.providerUsage.providerCalls, 1);
  assert.deepEqual(summarizeDecisionEvaluation(ledger).calibration, result.calibration);
  const app = await checkDecisionImages("outfit-review", { entries: h.manifest.cases[0].evidence.map(entry => ({ label: entry.label, file: path.join(h.dir, entry.file) })), metadata: JSON.parse(request.input[0].content[0].text),
    namespace: "evaluation-parity", env: { ...env, WARDROBE_DECISIONS_ENABLED: "1" }, fetch });
  assert.deepEqual(request.questions, expected.questions); assert.equal(app.checks[0].state, "clear");
});

test("threshold replay separates missed defects, false warnings, uncertainty and refusals; holdout remains fixed", async t => {
  const h = await fixture(t, [caseRecord("miss", { expected: { ...labels("outfit-review"), fidelity: "concern" } }), caseRecord("warning"),
    caseRecord("refusal"), caseRecord("holdout", { split: "confirmation", expected: { ...labels("outfit-review"), fidelity: "concern" } })]);
  let index = 0;
  const changes = [ { fidelity: { choice: "clear", confidence: .8 } }, { fidelity: { choice: "concern", confidence: .7 } }, { fidelity: "refusal" }, { fidelity: { choice: "clear", confidence: .8 } } ];
  const report = await runDecisionEvaluation({ ...h, run: true, maxCalls: 4, fetch: async (_, init) => Response.json(responseFor(JSON.parse(init.body), changes[index++])) });
  const current = report.calibration.find(item => item.threshold === .75), lower = report.calibration.find(item => item.threshold === .6), higher = report.calibration.find(item => item.threshold === .85);
  assert.equal(current.casesWithMissedDefects, 1); assert.equal(current.casesWithFalseWarnings, 0); assert.equal(lower.casesWithFalseWarnings, 1); assert.equal(higher.casesWithMissedDefects, 0);
  const fidelity = current.checks.find(item => item.id === "fidelity");
  assert.deepEqual(fidelity.missedDefectRate, { numerator: 1, denominator: 1, rate: 1 });
  assert.equal(fidelity.confusion.clear.unknown, 2); assert.equal(report.providerUsage.refusals, 1);
  assert.equal(report.confirmation.threshold, .75); assert.equal(report.confirmation.casesWithMissedDefects, 1);
  assert.equal(report.providerUsage.usage.inputTokens.observed, 4000); assert.equal(report.providerUsage.cost.knownCalls, 4);
  assert.match(renderDecisionEvaluation(report), /Confirmation.*1.*1.*1/s);
});

test("offline plan needs no credential and live gates stop before any network call", async t => {
  const h = await fixture(t); let calls = 0;
  const fetch = async () => { calls++; throw new Error("Unexpected dispatch"); };
  const plan = await runDecisionEvaluation({ ...h, env: {}, fetch }); assert.equal(plan.dryRun, true); assert.equal(calls, 0);
  await assert.rejects(runDecisionEvaluation({ ...h, run: true, fetch }), /max-calls/);
  await assert.rejects(runDecisionEvaluation({ ...h, run: true, maxCalls: 1, env: {}, fetch }), /OPENAI_API_KEY/);
  h.manifest.cases[0].review.humanReviewed = false; await writeFile(h.manifestPath, JSON.stringify(h.manifest));
  await assert.rejects(runDecisionEvaluation({ ...h, run: true, maxCalls: 1, fetch }), /human labels/); assert.equal(calls, 0);
});

test("crop evaluation reuses the production completeness, selection and detail checks", async t => {
  const h = await fixture(t, [caseRecord("crop", { kind: "preflight", expected: { complete: "concern", isolated: "clear", detail: "unknown" },
    evidence: [{ label: "source", file: "images/result.png" }, { label: "target", file: "images/garment.png" }], metadata: { category: "upperbody", name: "Blue blouse" } })]);
  let request;
  const report = await runDecisionEvaluation({ ...h, run: true, maxCalls: 1, fetch: async (_, init) => {
    request = JSON.parse(init.body); return Response.json(responseFor(request, { complete: { choice: "concern", confidence: .9 }, detail: { choice: "unknown", confidence: .9 } }));
  } });
  assert.deepEqual(request.questions.map(question => question.name), ["complete", "isolated", "detail"]);
  const base = report.calibration.find(item => item.threshold === .75);
  assert.equal(base.casesWithMissedDefects, 0); assert.equal(base.casesWithFalseWarnings, 0); assert.equal(base.checks.find(item => item.id === "detail").confusion.unknown.unknown, 1);
});

test("failed and interrupted calls are never retried or treated as free, and errors halt a batch", async t => {
  const h = await fixture(t, [caseRecord("first"), caseRecord("second")]); let calls = 0;
  const fetch = async () => { calls++; return new Response("PRIVATE provider message", { status: 401 }); };
  const report = await runDecisionEvaluation({ ...h, run: true, maxCalls: 2, fetch });
  assert.equal(calls, 1); assert.equal(report.pendingCalls, 1); assert.equal(report.providerUsage.cost.unknownCalls, 1);
  assert.equal(report.calibration[0].evaluatedCases, 0); assert.equal(report.calibration[0].checks[0].unevaluated, 2);
  const ledger = JSON.parse(await readFile(report.ledgerPath, "utf8"));
  ledger.attempts.second = { state: "dispatching", requestHash: ledger.cases.find(item => item.id === "second").requestHash, result: null, usageRecord: null };
  await writeFile(report.ledgerPath, JSON.stringify(ledger));
  const resumed = await runDecisionEvaluation({ ...h, run: true, maxCalls: 2, fetch });
  assert.equal(calls, 1); assert.equal(resumed.providerUsage.providerCalls, 2); assert.equal(resumed.providerUsage.unfinished, 1);
  assert.equal(resumed.providerUsage.cost.unknownCalls, 2); assert.doesNotMatch(await readFile(resumed.ledgerPath, "utf8"), /PRIVATE/);
});

test("frozen runs reject changed images, labels, rubric descriptors or call caps", async t => {
  const h = await fixture(t); const config = { ...h, run: true, maxCalls: 1, fetch: async (_, init) => Response.json(responseFor(JSON.parse(init.body))) };
  await runDecisionEvaluation(config);
  await assert.rejects(runDecisionEvaluation({ ...config, maxCalls: 2 }), /original call limit/);
  h.manifest.cases[0].expected.fidelity = "concern"; await writeFile(h.manifestPath, JSON.stringify(h.manifest));
  await assert.rejects(runDecisionEvaluation(config), /Frozen run changed/);
  h.manifest.cases[0].expected.fidelity = "clear"; await writeFile(h.manifestPath, JSON.stringify(h.manifest));
  await sharp({ create: { width: 40, height: 80, channels: 4, background: "#ff0000" } }).png().toFile(path.join(h.dir, "images/result.png"));
  await assert.rejects(runDecisionEvaluation(config), /Frozen run changed/);
});

test("manifest prevents family leakage, escaping paths, missing piece evidence and arbitrary metadata", async t => {
  const a = caseRecord("one"), b = caseRecord("two", { family: "one", split: "confirmation" });
  assert.throws(() => validateEvaluationManifest({ version: 1, name: "suite", cases: [a, b] }), /Related case families/);
  const h = await fixture(t);
  for (const mutate of [item => { item.evidence[0].file = "../outside.png"; }, item => { item.metadata.garments[0].privateKey = "secret"; },
    item => { item.evidence[1].label = "identity-reference"; }, item => { item.metadata.garments.push({ name: "Missing", part: "shoes" }); },
    item => { item.expected.fidelity = undefined; }]) {
    const manifest = structuredClone(h.manifest); mutate(manifest.cases[0]); assert.throws(() => validateEvaluationManifest(manifest));
  }
  const outside = path.join(h.dir, "..", `${path.basename(h.dir)}-outside.png`); await writeFile(outside, await readFile(path.join(h.dir, "images/result.png"))); t.after(() => rm(outside, { force: true }));
  await rm(path.join(h.dir, "images/result.png")); await symlink(outside, path.join(h.dir, "images/result.png"));
  await assert.rejects(runDecisionEvaluation(h), /escaped the dataset/);
});

test("call cap, ledger lock and corrupt saved answers fail closed", async t => {
  const h = await fixture(t, [caseRecord("one"), caseRecord("two")]);
  await assert.rejects(runDecisionEvaluation({ ...h, run: true, maxCalls: 1 }), /exceed its call limit/);
  await mkdir(path.join(h.outDir, ".runner-lock"));
  await assert.rejects(runDecisionEvaluation(h), /locked/); await rm(path.join(h.outDir, ".runner-lock"), { recursive: true });
  const result = await runDecisionEvaluation({ ...h, run: true, maxCalls: 2, fetch: async (_, init) => Response.json(responseFor(JSON.parse(init.body))) });
  const ledger = JSON.parse(await readFile(result.ledgerPath, "utf8")); ledger.attempts.one.result.answers[0].choice = "fabricated";
  await writeFile(result.ledgerPath, JSON.stringify(ledger));
  await assert.rejects(runDecisionEvaluation({ ...h, run: true, maxCalls: 2 }), /Recorded answers are invalid/);
});

test("CLI help and strict arguments do not perform live work", () => {
  assert.deepEqual(parseEvaluationArgs(["--manifest", "suite.json", "--out", "run", "--cases", "a,b", "--run", "--max-calls", "2"]), { manifestPath: "suite.json", outDir: "run", caseIds: ["a", "b"], run: true, maxCalls: 2 });
  assert.throws(() => parseEvaluationArgs(["--run", "--max-calls", "NaN"])); assert.throws(() => parseEvaluationArgs(["--init", "new", "--run"]));
  const child = spawnSync(process.execPath, ["scripts/decision-evaluation-runner.mjs", "--help"], { encoding: "utf8" });
  assert.equal(child.status, 0); assert.match(child.stdout, /offline by default/); assert.equal(child.stderr, "");
  assert.ok(validateEvaluationManifest(evaluationTemplate()).cases.every(item => !item.ready));
});
