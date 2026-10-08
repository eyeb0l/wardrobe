import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { harness } from "./test-helpers/outfit-harness.mjs";
import { decisionMetadata, decisionsResponse } from "./test-helpers/decisions-response.mjs";
import { sensitivityLayouts, shuffledCandidates, compareDiscoveryJudgments, summarizeDiscoverySensitivity, runDiscoverySensitivity } from "./discovery-sensitivity.mjs";
import { parseSensitivityArgs } from "./discovery-sensitivity-runner.mjs";

const row = (id, match = .8) => ({ id, match, statement: .5, evidence: "sufficient" });
async function setup(t) {
  const h = await harness(t); await h.close();
  await writeFile(path.join(h.dataDir, "outfits.json"), JSON.stringify({ version: 1,
    outfits: Array.from({ length: 24 }, (_, index) => ({ ...h.originals[index % 6], id: `eval-${index}` })) }));
  return { ...h, options: { dataDir: h.dataDir, outDir: path.join(h.root, "sensitivity"), briefs: ["Dinner"], seeds: [1], repeats: 2,
    env: { WARDROBE_DECISIONS_ENABLED: "1", OPENAI_API_KEY: "fake-test-key" } } };
}

test("layouts preserve exact membership for batch-order tests, including a partial batch", () => {
  const candidates = Array.from({ length: 20 }, (_, id) => ({ id: String(id) }));
  const [original, reversed, shuffled] = sensitivityLayouts(candidates, [7]);
  assert.deepEqual(reversed.batches, [...original.batches].reverse());
  assert.deepEqual(reversed.batches.map(batch => batch.length), [8, 12]);
  assert.deepEqual(shuffled.candidates, shuffledCandidates(candidates, 7));
  assert.notDeepEqual(shuffled.candidates, candidates);
  assert.deepEqual(shuffled.candidates.map(item => item.id).sort(), candidates.map(item => item.id).sort());
});

test("reports separate repeat noise from batch changes and expose missing finalists and failed trials", () => {
  const baseline = [row("a", .9), row("b", .8), row("c", .7)];
  const altered = [row("b", .95), row("c", .7), row("d", .8)];
  const comparison = compareDiscoveryJudgments(baseline, altered);
  assert.equal(comparison.commonCandidates, 2); assert.equal(comparison.winnerAgrees, false);
  assert.equal(comparison.topThreeOverlap, 2 / 3); assert.deepEqual(comparison.missingBaselineTopThree, ["a"]);
  const report = summarizeDiscoverySensitivity([
    { briefIndex: 0, layout: "original", repeat: 0, status: "succeeded", screeningRankings: baseline, rankings: baseline },
    { briefIndex: 0, layout: "original", repeat: 1, status: "succeeded", screeningRankings: baseline, rankings: baseline },
    { briefIndex: 0, layout: "shuffle-1", repeat: 0, status: "succeeded", screeningRankings: altered, rankings: altered },
    { briefIndex: 0, layout: "shuffle-1", repeat: 1, status: "failed" },
  ]);
  assert.equal(report.failedTrials, 1);
  assert.deepEqual(report.comparisons.map(item => item.kind), ["repeat-noise", "batch-membership-and-order"]);
  assert.equal(report.comparisons[0].screening.maximumScoreChange, 0);
  assert.equal(compareDiscoveryJudgments([], []).winnerAgrees, null);
});

test("offline planning prepares a bounded run without model calls or credentials", async t => {
  const h = await setup(t);
  const plan = await runDiscoverySensitivity({ ...h.options, env: {}, fetch: async () => { assert.fail("Offline planning must not dispatch"); } });
  assert.equal(plan.maximumProviderCalls, 18); assert.equal(plan.plannedTrials, 6); assert.equal(plan.providerCalls, 0);
  assert.equal(plan.dryRun, true); assert.deepEqual(plan.candidateCounts, [24]);
  await assert.rejects(runDiscoverySensitivity({ ...h.options, run: true, maxCalls: 17 }), /upper bound of 18/);
});

test("live harness bypasses caches, measures all layouts and persists a private exclusive call ledger", async t => {
  const h = await setup(t);
  let calls = 0, active = 0, peak = 0;
  const fetch = async (url, init) => {
    assert.equal(url, "https://api.openai.com/v1/decisions"); calls++; peak = Math.max(peak, ++active);
    try {
      const ledger = JSON.parse(await readFile(path.join(h.options.outDir, "run.json"), "utf8"));
      assert.ok(ledger.reservedCalls >= calls);
      const body = JSON.parse(init.body), metadata = decisionMetadata(body), result = decisionsResponse(body);
      for (const [index, candidate] of metadata.candidates.entries()) {
        const score = metadata.context.comparisonStage === "final" ? .7 + Number(candidate.id.split("-")[1]) * .005 : .9 - index * .01;
        result.answers[index * 3].probabilities = result.answers[index * 3].probabilities.map(item => ({ ...item,
          probability: item.value === "excellent" ? score : item.value === "conflict" ? 1 - score : 0 }));
      }
      return Response.json(result);
    } finally { active--; }
  };
  const result = await runDiscoverySensitivity({ ...h.options, run: true, maxCalls: 18, fetch });
  assert.equal(calls, 18); assert.equal(result.reservedCalls, calls); assert.equal(result.succeededTrials, 6);
  assert.equal(result.usage.providerCalls, 18); assert.equal(result.usage.cacheHits, 0);
  assert.ok(peak <= 2);
  assert.ok(result.comparisons.some(item => item.kind === "batch-membership-and-order" && item.screening.maximumScoreChange > 0));
  assert.ok(result.comparisons.filter(item => item.kind === "repeat-noise").every(item => item.screening.maximumScoreChange === 0));
  const raw = await readFile(result.ledgerPath, "utf8");
  assert.doesNotMatch(raw, /fake-test-key|data:image\/|image_url|Authorization/);
  await assert.rejects(runDiscoverySensitivity({ ...h.options, run: true, maxCalls: 18, fetch }), { code: "EEXIST" });
  assert.equal(calls, 18);
});

test("provider failure stops evaluation with unattempted trials visible and no retry", async t => {
  const h = await setup(t); let calls = 0;
  const result = await runDiscoverySensitivity({ ...h.options, run: true, maxCalls: 18,
    fetch: async () => { calls++; return new Response("unavailable", { status: 503 }); } });
  assert.equal(result.failedTrials, 1); assert.equal(result.unattemptedTrials, 5);
  assert.ok(calls <= 2); assert.equal(result.reservedCalls, calls);
  assert.deepEqual(result.comparisons, []);
});

test("CLI requires explicit paid run and rejects malformed seeds/counts", () => {
  const args = parseSensitivityArgs(["--data-dir", "private", "--out", "run", "--brief", "Dinner", "--seeds", "1,2", "--repeats", "2"]);
  assert.equal(args.run, undefined); assert.deepEqual(args.seeds, [1, 2]);
  assert.deepEqual(args.briefs, ["Dinner"]);
  assert.throws(() => parseSensitivityArgs(["--max-calls", "2.5"]), /integers/);
  assert.throws(() => parseSensitivityArgs(["--unknown", "value"]), /Unknown/);
});
