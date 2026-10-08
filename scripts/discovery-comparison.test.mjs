import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { harness } from "./test-helpers/outfit-harness.mjs";
import { decisionsResponse, decisionMetadata } from "./test-helpers/decisions-response.mjs";
import { COMPARISON_PROTOCOL, initializeDiscoveryComparison, validateComparisonManifest, rankComparisonApproach, scoreHumanAgreement, maximumComparisonCalls } from "./discovery-comparison.mjs";
import { runApproachComparison, summarizeComparison, parseComparisonArgs } from "./discovery-comparison-runner.mjs";
import { createComparisonReview } from "./discovery-comparison-review.mjs";

const row = (id, match = .9) => ({ id, match, evidence: "sufficient", statement: .5 });
async function setup(t, reviewed = false) {
  const h = await harness(t); await h.close();
  const outfits = Array.from({ length: 24 }, (_, index) => ({ ...h.originals[index % 6], id: `compare-${index}` }));
  await writeFile(path.join(h.dataDir, "outfits.json"), JSON.stringify({ version: 1, outfits }));
  const manifestPath = path.join(h.root, "comparison", "human-labels.json");
  await initializeDiscoveryComparison({ dataDir: h.dataDir, manifestPath, briefs: ["A relaxed everyday outfit"] });
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (reviewed) {
    manifest.cases[0].candidates.forEach(item => { item.relevance = item.id === "compare-23" ? 3 : 0; item.preferred = item.id === "compare-23"; });
    manifest.cases[0].review = { humanReviewed: true, reviewedAt: new Date().toISOString() };
    await writeFile(manifestPath, JSON.stringify(manifest));
  }
  return { ...h, manifestPath, manifest, outfits };
}

test("human agreement penalizes stable wrong rankings and rewards preferred relevant results", () => {
  const item = { candidates: [{ id: "wrong", relevance: 0, preferred: false }, { id: "right", relevance: 3, preferred: true }, { id: "partial", relevance: 1, preferred: false }, { id: "unknown", relevance: "unknown", preferred: false }], noneSuitable: false };
  const wrong = scoreHumanAgreement([row("wrong")], item), right = scoreHumanAgreement([row("right", .99), row("partial", .8)], item);
  assert.equal(wrong.ndcgAtThree, 0); assert.equal(wrong.winnerPreferred, false);
  assert.equal(right.ndcgAtThree, 1); assert.equal(right.winnerPreferred, true);
  assert.equal(scoreHumanAgreement([], item).ndcgAtThree, 0);
  assert.throws(() => scoreHumanAgreement([], { candidates: [{ id: "ungraded", relevance: null }] }), /Complete human labels/);
  const summary = summarizeComparison([0, 1].map(repeat => ({ status: "succeeded", method: "absolute", caseId: "case-1", variant: "one", repeat,
    rankings: [row("wrong")], agreement: wrong, elapsedMs: 10, providerCalls: 1 })));
  assert.equal(summary.methods[0].caseWeightedAgreement.ndcgAtThree.mean, 0);
  assert.equal(summary.methods[0].cases[0].stability[0].winnerAgrees, true);
});

test("absolute judging sees one candidate, current flow uses shared finalists, consensus aggregates ranks rather than raw cohort scores", async () => {
  const candidates = Array.from({ length: 24 }, (_, id) => ({ id: `item-${id}` }));
  for (const method of COMPARISON_PROTOCOL.methods) {
    const calls = [];
    const result = await rankComparisonApproach({ candidates, method, seeds: [1, 2, 3], scoreBatch: async (batch, { phase }) => {
      calls.push({ size: batch.length, phase });
      return { rankings: batch.map(item => row(item.id)), inputTokens: 1, cached: false };
    } });
    assert.ok(result.rankings.length > 0);
    if (method === "absolute") { assert.equal(calls.length, 24); assert.ok(calls.every(call => call.size === 1 && call.phase === "absolute")); }
    else { assert.equal(calls.at(-1).phase, "final"); assert.ok(calls.at(-1).size <= 12); }
    if (method === "shuffled-consensus") { assert.equal(calls.length, 7); assert.ok(result.consensusSupport.every(item => item.votes <= 3)); }
  }
});

test("unreviewed labels or changed protocol block paid work; planning remains offline", async t => {
  const h = await setup(t); let calls = 0;
  const plan = await runApproachComparison({ manifestPath: h.manifestPath });
  assert.equal(plan.maximumProviderCalls, maximumComparisonCalls(24)); assert.equal(plan.reviewedCases, 0);
  assert.equal(plan.providerCalls, 0);
  await assert.rejects(runApproachComparison({ manifestPath: h.manifestPath, run: true, fetch: async () => { calls++; } }), /human review/);
  assert.equal(calls, 0);
  const tampered = structuredClone(h.manifest); tampered.protocol.shortlistLimit = 5;
  assert.throws(() => validateComparisonManifest(tampered), /altered/);
});

test("all approaches share visual evidence and never send human labels; dispatch caps and fresh ledgers hold", async t => {
  const h = await setup(t, true), outDir = path.join(h.root, "comparison-run");
  const calls = [], env = { WARDROBE_DECISIONS_ENABLED: "1", OPENAI_API_KEY: "comparison-fake-key" };
  const fetch = async (_, init) => {
    const body = JSON.parse(init.body); calls.push(body);
    assert.doesNotMatch(init.body, /humanReviewed|reviewedAt|relevance|preferred|noneSuitable/);
    assert.match(init.body, /data:image\/jpeg;base64/);
    return Response.json(decisionsResponse(body));
  };
  const result = await runApproachComparison({ manifestPath: h.manifestPath, outDir, run: true, maxCalls: 94, env, fetch });
  assert.equal(result.succeededTrials, 12); assert.equal(result.usage.providerCalls, 94); assert.equal(calls.length, 94);
  assert.equal(result.usage.cacheHits, 0);
  assert.equal(result.methods.find(item => item.method === "absolute").usage.providerCalls, 48);
  assert.equal(result.methods.find(item => item.method === "shuffled-consensus").usage.providerCalls, 28);
  assert.equal(result.methods.reduce((sum, method) => sum + method.usage.providerCalls, 0), result.usage.providerCalls);
  assert.ok(result.methods.every(method => typeof method.cases[0].abstainedTrials === "number"));
  assert.ok(calls.filter(call => decisionMetadata(call).context.comparisonStage === "absolute").every(call => decisionMetadata(call).candidates.length === 1));
  await assert.rejects(runApproachComparison({ manifestPath: h.manifestPath, outDir, run: true, maxCalls: 94, env, fetch }), { code: "EEXIST" });
  assert.equal(calls.length, 94);
});

test("review page hides model results, restricts image paths and rejects foreign/missing-token writes", async t => {
  const h = await setup(t), review = await createComparisonReview(h.manifestPath);
  t.after(async () => { review.server.closeAllConnections(); await new Promise(resolve => review.server.close(resolve)); });
  const state = await (await fetch(`${review.url}/state`)).json();
  assert.equal(state.cases[0].candidates[0].relevance, null);
  assert.doesNotMatch(JSON.stringify(state), /rankings|confidence|matchScore/);
  assert.equal((await fetch(`${review.url}/image/../../.env`)).status, 404);
  assert.equal((await fetch(`${review.url}/image/0-0-photo`)).headers.get("content-type"), "image/jpeg");
  const cases = state.cases.map(item => ({ id: item.id, noneSuitable: false, candidates: item.candidates.map(({ id, relevance, preferred }) => ({ id, relevance, preferred })) }));
  const response = await fetch(`${review.url}/labels`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://foreign.invalid", "X-Review-Token": state.token }, body: JSON.stringify({ complete: true, cases }) });
  assert.equal(response.status, 403);
  assert.equal(JSON.parse(await readFile(h.manifestPath, "utf8")).cases[0].review.humanReviewed, false);
  const incomplete = await fetch(`${review.url}/labels`, { method: "POST", headers: { "Content-Type": "application/json", Origin: review.url, "X-Review-Token": state.token }, body: JSON.stringify({ complete: true, cases }) });
  assert.equal(incomplete.status, 400);
  const headers = { "Content-Type": "application/json", Origin: review.url, "X-Review-Token": state.token };
  cases[0].candidates.forEach((item, index) => { item.relevance = index === 0 ? 3 : 0; item.preferred = index === 0; });
  const saved = await fetch(`${review.url}/labels`, { method: "POST", headers, body: JSON.stringify({ complete: false, cases }) });
  assert.equal(saved.status, 200);
  assert.equal(JSON.parse(await readFile(h.manifestPath, "utf8")).cases[0].review.humanReviewed, false);
  const finished = await fetch(`${review.url}/labels`, { method: "POST", headers, body: JSON.stringify({ complete: true, cases }) });
  assert.equal(finished.status, 200);
  const reviewed = JSON.parse(await readFile(h.manifestPath, "utf8"));
  assert.equal(reviewed.cases[0].review.humanReviewed, true);
  assert.equal(reviewed.cases[0].candidates[0].relevance, 3);
  assert.doesNotThrow(() => validateComparisonManifest(reviewed, { reviewed: true }));
});

test("fresh continuation skips both completed and failed trials and keeps the combined call cap", async t => {
  const h = await setup(t, true), firstDir = path.join(h.root, "first-run"), nextDir = path.join(h.root, "remaining-run");
  const env = { WARDROBE_DECISIONS_ENABLED: "1", OPENAI_API_KEY: "comparison-fake-key" };
  let calls = 0, failOnce = true;
  const fetch = async (_, init) => {
    const body = JSON.parse(init.body); calls++;
    if (decisionMetadata(body).context.comparisonStage === "screening" && failOnce) {
      failOnce = false; return new Response("", { status: 504 });
    }
    return Response.json(decisionsResponse(body));
  };
  const first = await runApproachComparison({ manifestPath: h.manifestPath, outDir: firstDir, run: true, maxCalls: 94, env, fetch });
  assert.equal(first.succeededTrials, 2); assert.equal(first.failedTrials, 1); assert.equal(first.reservedCalls, 50);
  const previousRunPath = path.join(firstDir, "run.json"), originalLedger = await readFile(previousRunPath, "utf8");
  const plan = await runApproachComparison({ manifestPath: h.manifestPath, previousRunPath, env });
  assert.equal(plan.remainingTrials, 9); assert.equal(plan.previousReservedCalls, 50);
  const result = await runApproachComparison({ manifestPath: h.manifestPath, previousRunPath, outDir: nextDir, run: true, maxCalls: 94, env, fetch });
  assert.equal(result.succeededTrials, 11); assert.equal(result.failedTrials, 1); assert.equal(result.unattemptedTrials, 0);
  assert.equal(result.reservedCalls, 93); assert.equal(result.newProviderReservations, 43); assert.equal(calls, 93);
  assert.equal(await readFile(previousRunPath, "utf8"), originalLedger);
  assert.equal(result.methods.find(method => method.method === "absolute").usage.providerCalls, 48);
  await assert.rejects(runApproachComparison({ manifestPath: h.manifestPath, previousRunPath, env: { ...env, OPENAI_DECISIONS_MODEL: "different-model" } }), /identical frozen/);
  assert.equal(calls, 93);
});

test("CLI defaults to offline and disallows initialization with paid options", () => {
  assert.equal(parseComparisonArgs(["--manifest", "private.json"]).run, undefined);
  assert.throws(() => parseComparisonArgs(["--init", "private.json", "--run"]), /Initialization/);
});
