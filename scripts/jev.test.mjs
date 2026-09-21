import assert from "node:assert/strict";
import test from "node:test";
import { JEV_MODEL, rankWithJev } from "./jev.mjs";
import { orderDiscovery, discoveryFingerprint } from "../shared/outfit-discovery.mjs";
import { colourName } from "./outfit-discovery-api.mjs";
import { jevResponse } from "./test-helpers/jev-response.mjs";

const input = (namespace, overrides = {}) => ({ namespace, env: { WARDROBE_JEV_ENABLED: "1", TYPESAFE_API_KEY: "test-key" }, brief: "Dinner", context: { mode: "saved outfits" }, candidates: [{ id: "outfit-1", name: "Navy dinner look" }], fetch: async (_url, init) => Response.json(jevResponse(JSON.parse(init.body))), ...overrides });

test("Jev uses the documented contract, deduplicates work and charges only dispatches", async () => {
  let calls = 0, charges = 0, release;
  const gate = new Promise((resolve) => { release = resolve; });
  const options = input("contract", { beforePaidCall: async (kind) => { assert.equal(kind, "text"); charges++; }, fetch: async (url, init) => {
    calls++;
    assert.equal(url, "https://api.typesafe.ai/v1/systemone");
    assert.equal(init.headers.Authorization, "Bearer test-key");
    assert.ok(init.signal instanceof AbortSignal);
    const body = JSON.parse(init.body);
    assert.equal(body.model, JEV_MODEL);
    assert.equal(body.questions.match_0.type, "score");
    assert.match(body.questions.match_0.instructions, /candidates\[0\]/);
    assert.equal(body.questions.evidence_0.criteria.unknown.includes("missing"), true);
    await gate;
    return Response.json(jevResponse(body));
  } });
  const first = rankWithJev(options), replay = rankWithJev(options);
  release();
  const [a, b] = await Promise.all([first, replay]);
  assert.equal(a.rankings[0].id, "outfit-1");
  assert.equal(a.rankings[0].match, .9);
  assert.equal(b.cached, true);
  assert.equal(b.inputTokens, 0);
  a.rankings[0].id = "tampered";
  assert.equal((await rankWithJev(options)).rankings[0].id, "outfit-1");
  assert.equal(calls, 1); assert.equal(charges, 1);
  await rankWithJev({ ...options, brief: "Office" });
  await rankWithJev({ ...options, candidates: [{ id: "outfit-1", name: "Changed metadata" }] });
  assert.equal(calls, 3);
});

test("disabled, empty, oversized and quota-blocked requests never dispatch", async () => {
  let calls = 0;
  const options = input("gates", { fetch: async () => { calls++; throw new Error("unexpected"); } });
  await assert.rejects(rankWithJev({ ...options, env: { TYPESAFE_API_KEY: "test-key" } }), { status: 503 });
  await assert.rejects(rankWithJev({ ...options, env: { WARDROBE_JEV_ENABLED: "1" } }), { status: 503 });
  assert.deepEqual((await rankWithJev({ ...options, candidates: [] })).rankings, []);
  await assert.rejects(rankWithJev({ ...options, brief: "a".repeat(60_000) }), { status: 422 });
  await assert.rejects(rankWithJev({ ...options, beforePaidCall: async () => { throw Object.assign(new Error("Quota reached"), { status: 429 }); } }), { status: 429 });
  assert.equal(calls, 0);
});

test("timeouts, provider failures and malformed answers are safe and not cached", async () => {
  await assert.rejects(rankWithJev(input("timeout", { timeoutMs: 5, fetch: async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("secret")))) })), /took too long/);
  for (const status of [401, 429, 529]) {
    await assert.rejects(rankWithJev(input(`status-${status}`, { fetch: async () => new Response("provider-secret", { status }) })), (error) => !error.message.includes("secret"));
  }
  for (const bad of [null, "2.7", -1, 4, NaN]) {
    let calls = 0;
    const options = input(`bad-${bad}`, { fetch: async (_url, init) => { calls++; const value = jevResponse(JSON.parse(init.body)); value.answers.match_0.score = bad; return Response.json(value); } });
    await assert.rejects(rankWithJev(options), { status: 502 });
    await assert.rejects(rankWithJev(options), { status: 502 });
    assert.equal(calls, 2);
  }
  await assert.rejects(rankWithJev(input("missing", { fetch: async () => Response.json({ answers: {} }) })), { status: 502 });
});

test("refinements keep unknown and poor matches out without equating confidence with correctness", () => {
  const rows = [
    { id: "quiet", match: .8, statement: 0, novelty: .1, evidence: "sufficient", confidence: .2 },
    { id: "bold", match: .8, statement: 1, novelty: 1, evidence: "sufficient", confidence: .9 },
    { id: "unknown", match: 1, statement: 1, evidence: "unknown" },
    { id: "mismatch", match: .3, statement: 1, evidence: "sufficient" },
  ];
  assert.deepEqual(orderDiscovery(rows, { style: "understated" }).map(({ id }) => id), ["quiet", "bold"]);
  assert.equal(orderDiscovery(rows, { style: "statement" })[0].id, "bold");
  assert.equal(orderDiscovery(rows, { lessUsed: true })[0].id, "bold");
  assert.equal(rows.length, 4);
  assert.notEqual(discoveryFingerprint([], [{ id: "a", color: "#ffffff" }]), discoveryFingerprint([], [{ id: "a", color: "#000000" }]));
});

test("hex colours become approximate human colour names", () => {
  assert.equal(colourName("#000000"), "black");
  assert.equal(colourName("#ffffff"), "white");
  assert.equal(colourName("#ff0000"), "red");
  assert.equal(colourName("#000080"), "dark blue");
  assert.equal(colourName("no evidence"), "unknown");
});
