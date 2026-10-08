import assert from "node:assert/strict";
import test from "node:test";
import { rankBatchedDiscovery, rankDiscovery, promoteDiscoveryBatch, maximumBatchedDiscoveryCalls, maximumDiscoveryCalls } from "./discovery-ranking.mjs";
import { orderDiscovery } from "../shared/outfit-discovery.mjs";

const row = (id, match = .9, evidence = "sufficient") => ({ id, match, evidence, statement: .5, confidence: .8 });
const candidates = count => Array.from({ length: count }, (_, index) => ({ id: `piece-${index}` }));

test("absolute discovery judges every candidate alone and aggregates evidence, usage and cache state", async () => {
  const pool = candidates(14).reverse(), seen = [];
  const result = await rankDiscovery({ candidates: pool, scoreBatch: async (batch, { phase }) => {
    assert.equal(batch.length, 1); assert.equal(phase, "absolute");
    const id = batch[0].id; seen.push(id);
    return { rankings: [row(id, id === "piece-13" ? .99 : .7, id === "piece-1" ? "unknown" : "sufficient")], inputTokens: 10, cached: id !== "piece-0" };
  } });
  assert.equal(seen.length, 14); assert.equal(result.rankings.length, 14);
  assert.deepEqual(result.rankings.map(item => item.id), [...pool].map(item => item.id).sort((a, b) => a.localeCompare(b)));
  assert.equal(orderDiscovery(result.rankings)[0].id, "piece-13");
  assert.equal(result.unknownCount, 1); assert.equal(result.inputTokens, 140); assert.equal(result.cached, false);
  assert.equal(result.scoringMethod, "absolute"); assert.equal(maximumDiscoveryCalls(14), 14);
});

test("empty absolute discovery does no work and missing usage remains unknown", async () => {
  const empty = await rankDiscovery({ candidates: [], scoreBatch: async () => assert.fail("Empty collection") });
  assert.deepEqual(empty.rankings, []); assert.equal(empty.inputTokens, 0); assert.equal(empty.unknownCount, 0);
  const result = await rankDiscovery({ candidates: candidates(3), scoreBatch: async batch => ({ rankings: [row(batch[0].id, .4)], cached: true, inputTokens: null }) });
  assert.equal(result.cached, true); assert.equal(result.inputTokens, null); assert.deepEqual(orderDiscovery(result.rankings), []);
});

test("promotion retains three strong candidates and near ties within each cohort, never unknowns", () => {
  const rows = [.99, .9, .8, .77, .76, .75, .74, .6].map((score, index) => row(`item-${index}`, score));
  assert.deepEqual(promoteDiscoveryBatch([...rows, row("unknown", 1, "unknown")]).map(item => item.id), rows.slice(0, 6).map(item => item.id));
  assert.deepEqual(promoteDiscoveryBatch([row("weak", .4)]), []);
});

test("a common final comparison replaces incomparable screening scores", async () => {
  const seen = [];
  const result = await rankBatchedDiscovery({ candidates: candidates(24), scoreBatch: async (batch, { phase }) => {
    seen.push({ phase, ids: batch.map(item => item.id) });
    return { rankings: batch.map(item => row(item.id, phase === "final" ? item.id === "piece-12" ? .99 : .7 : Number(item.id.split("-")[1]) < 12 ? .95 : .8)), inputTokens: 100, cached: false };
  } });
  assert.equal(seen.length, 3); assert.equal(seen.at(-1).phase, "final");
  assert.ok(seen.at(-1).ids.includes("piece-0")); assert.ok(seen.at(-1).ids.includes("piece-12"));
  assert.equal(orderDiscovery(result.screeningRankings)[0].id, "piece-0");
  assert.equal(orderDiscovery(result.rankings)[0].id, "piece-12");
  assert.equal(result.inputTokens, 300);
});

test("bounded reduction rounds converge and return only the shared final cohort", async () => {
  const seen = [];
  const result = await rankBatchedDiscovery({ candidates: candidates(145), scoreBatch: async (batch, { phase }) => {
    assert.ok(batch.length <= 12); seen.push(phase);
    return { rankings: batch.map(item => row(item.id)), inputTokens: 1, cached: true };
  } });
  assert.ok(seen.includes("reduction")); assert.equal(seen.at(-1), "final");
  assert.ok(result.rankings.length <= 12); assert.equal(result.screeningRankings.length, 145);
  assert.equal(seen.length, maximumBatchedDiscoveryCalls(145));
  assert.equal(result.cached, true);
});

test("small pools need one comparison; empty, weak and refused evidence cannot force a winner", async () => {
  let calls = 0;
  const scoreBatch = async batch => { calls++; return { rankings: batch.map(item => row(item.id, .9, "unknown")), cached: false, inputTokens: null }; };
  const empty = await rankBatchedDiscovery({ candidates: [], scoreBatch });
  assert.equal(calls, 0); assert.deepEqual(empty.rankings, []);
  const small = await rankBatchedDiscovery({ candidates: candidates(6), scoreBatch });
  assert.equal(calls, 1); assert.equal(small.unknownCount, 6); assert.equal(small.inputTokens, null);
  const large = await rankBatchedDiscovery({ candidates: candidates(24), scoreBatch });
  assert.equal(calls, 3); assert.equal(large.unknownCount, 24); assert.deepEqual(large.rankings, []);
});

test("a failed final comparison never falls back to screening scores", async () => {
  await assert.rejects(rankBatchedDiscovery({ candidates: candidates(24), scoreBatch: async (batch, { phase }) => {
    if (phase === "final") throw Object.assign(new Error("Unavailable"), { status: 502 });
    return { rankings: batch.map(item => row(item.id)), cached: false, inputTokens: 1 };
  } }), { status: 502 });
});

test("identical survivors have identical final order despite reversed screening batch order", async () => {
  const pool = candidates(20), batches = [pool.slice(0, 12), pool.slice(12)], finalOrders = [];
  for (const initialBatches of [batches, [...batches].reverse()]) {
    await rankBatchedDiscovery({ candidates: pool, initialBatches, scoreBatch: async (batch, { phase }) => {
      if (phase === "final") finalOrders.push(batch.map(item => item.id));
      return { rankings: batch.map(item => row(item.id)), inputTokens: 0, cached: true };
    } });
  }
  assert.deepEqual(finalOrders[0], finalOrders[1]);
  assert.deepEqual(finalOrders[0], [...finalOrders[0]].sort((a, b) => a.localeCompare(b)));
});

test("evaluation batches cannot omit, duplicate or introduce candidates", async () => {
  const pool = candidates(20);
  for (const initialBatches of [[pool.slice(0, 12)], [pool.slice(0, 12), pool.slice(0, 8)], [[{ id: "foreign" }], ...[pool.slice(0, 12), pool.slice(12, 19)]]]) {
    await assert.rejects(rankBatchedDiscovery({ candidates: pool, initialBatches, scoreBatch: async () => assert.fail("Invalid layouts must not dispatch") }), /exactly once/);
  }
});
