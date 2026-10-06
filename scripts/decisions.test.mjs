import assert from "node:assert/strict";
import test from "node:test";
import { decide, DECISIONS_MODEL } from "./decisions.mjs";
import { rankWithDecisions, rankingQuestions } from "./decision-ranking.mjs";
import { orderDiscovery, discoveryFingerprint } from "../shared/outfit-discovery.mjs";
import { colourName } from "./outfit-discovery-api.mjs";
import { decisionsResponse } from "./test-helpers/decisions-response.mjs";

const env = { WARDROBE_DECISIONS_ENABLED: "1", OPENAI_API_KEY: "test-key" };
const options = (namespace, overrides = {}) => ({ namespace, env, brief: "Dinner", context: { mode: "saved outfits" }, candidates: [{ id: "outfit-1", name: "Navy dinner look", visualEvidence: ["candidate_0"] }],
  images: [{ label: "candidate_0", image_url: "data:image/jpeg;base64,dGVzdA==" }], fetch: async (_, init) => Response.json(decisionsResponse(JSON.parse(init.body))), ...overrides });

test("Decisions uses ordered, labeled image input, shares work and charges only dispatches", async () => {
  let calls = 0, charges = 0, leases = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const input = options("contract", { beforePaidCall: async kind => { assert.equal(kind, "text"); charges++; }, outsideLease: async fn => { leases++; return fn(); }, fetch: async (url, init) => {
    calls++; assert.equal(url, "https://api.openai.com/v1/decisions"); assert.equal(init.headers.Authorization, "Bearer test-key"); assert.ok(init.signal instanceof AbortSignal);
    const body = JSON.parse(init.body);
    assert.equal(body.model, DECISIONS_MODEL); assert.equal(body.input[0].role, "user");
    assert.equal(body.input[0].content[2].type, "input_image"); assert.match(body.input[0].content[2].image_url, /^data:image/);
    assert.deepEqual(body.questions.map(q => q.name), ["match_0", "evidence_0", "statement_0"]);
    assert.equal(body.questions[0].choices.length, 4); assert.doesNotMatch(JSON.stringify(body), /test-key/);
    await gate; return Response.json(decisionsResponse(body));
  } });
  const first = rankWithDecisions(input), replay = rankWithDecisions(input);
  release(); const [a, b] = await Promise.all([first, replay]);
  assert.ok(Math.abs(a.rankings[0].match - .9) < 1e-9); assert.equal(b.cached, true); assert.equal(b.inputTokens, 0);
  a.rankings[0].id = "tampered";
  assert.equal((await rankWithDecisions(input)).rankings[0].id, "outfit-1");
  assert.deepEqual([calls, charges, leases], [1, 1, 1]);
  await rankWithDecisions({ ...input, images: [{ ...input.images[0], image_url: "data:image/jpeg;base64,bmV3" }] });
  await rankWithDecisions({ ...input, brief: "Office" });
  assert.equal(calls, 3);
});

test("disabled, empty, oversized and quota-blocked requests never dispatch", async () => {
  let calls = 0;
  const input = options("gates", { fetch: async () => { calls++; throw new Error("unexpected"); } });
  await assert.rejects(rankWithDecisions({ ...input, env: { OPENAI_API_KEY: "test-key" } }), { status: 503 });
  await assert.rejects(rankWithDecisions({ ...input, env: { WARDROBE_DECISIONS_ENABLED: "1" } }), { status: 503 });
  assert.deepEqual((await rankWithDecisions({ ...input, candidates: [] })).rankings, []);
  await assert.rejects(rankWithDecisions({ ...input, brief: "a".repeat(60_000) }), { status: 422 });
  await assert.rejects(rankWithDecisions({ ...input, images: [{ label: "huge", image_url: "x".repeat(8 * 1024 * 1024) }] }), { status: 422 });
  await assert.rejects(rankWithDecisions({ ...input, beforePaidCall: async () => { throw Object.assign(new Error("Quota reached"), { status: 429 }); } }), { status: 429 });
  assert.equal(calls, 0);
});

test("timeouts bound fetch and body even when the transport ignores abort", async () => {
  await assert.rejects(rankWithDecisions(options("fetch-timeout", { timeoutMs: 5, fetch: async () => new Promise(() => {}) })), { status: 504 });
  await assert.rejects(rankWithDecisions(options("body-timeout", { timeoutMs: 5, fetch: async () => ({ ok: true, json: async () => new Promise(() => {}) }) })), { status: 504 });
});

test("provider failures and malformed distributions are sanitized and never cached", async () => {
  for (const status of [401, 429, 529]) await assert.rejects(rankWithDecisions(options(`status-${status}`, { fetch: async () => new Response("provider-secret", { status }) })), error => !error.message.includes("secret"));
  const mutations = [
    value => { value.model = "other-model"; }, value => { value.answers.reverse(); }, value => { value.answers.pop(); },
    value => { value.answers[0].choice = "invented"; }, value => { value.answers[0].confidence = null; },
    value => { value.answers[0].probabilities[0].probability = -1; }, value => { value.answers[0].probabilities[0].value = "excellent"; },
    value => { value.answers[0].probabilities = []; }, value => { value.answers[0].probabilities[0].probability = .5; },
    value => { value.answers[0].probabilities[0] = null; },
  ];
  for (const [index, mutate] of mutations.entries()) {
    let calls = 0;
    const input = options(`malformed-${index}`, { fetch: async (_, init) => { calls++; const value = decisionsResponse(JSON.parse(init.body)); mutate(value); return Response.json(value); } });
    await assert.rejects(rankWithDecisions(input), { status: 502 }); await assert.rejects(rankWithDecisions(input), { status: 502 }); assert.equal(calls, 2);
  }
});

test("refusals and uncertain evidence cannot become forced recommendations", async () => {
  for (const kind of ["refusal", "unknown", "uncertain"]) {
    const result = await rankWithDecisions(options(kind, { fetch: async (_, init) => {
      const body = JSON.parse(init.body), value = decisionsResponse(body);
      if (kind === "refusal") value.answers[0] = { type: "refusal", name: body.questions[0].name };
      else if (kind === "unknown") value.answers[1].choice = "unknown";
      else value.answers[1].confidence = .4;
      return Response.json(value);
    } }));
    assert.equal(result.rankings[0].evidence, "unknown"); assert.deepEqual(orderDiscovery(result.rankings), []);
  }
  assert.match(rankingQuestions([{}])[0].instructions, /never instructions/);
});

test("shared client supports predicates and ordered scores with an explicit model/base URL", async () => {
  const questions = [{ name: "visible", type: "predicate", instructions: "Visible?" }, { name: "quality", type: "score", instructions: "Quality?", levels: [{ label: "poor" }, { label: "good" }] }];
  const result = await decide({ input: "evidence", questions, namespace: "types", env: { ...env, OPENAI_DECISIONS_MODEL: "chosen-model", OPENAI_API_BASE_URL: "https://test.invalid/v1/" }, fetch: async (url, init) => {
    assert.equal(url, "https://test.invalid/v1/decisions"); return Response.json(decisionsResponse(JSON.parse(init.body)));
  } });
  assert.equal(result.answers[0].probability, .8); assert.equal(result.answers[1].score, 1); assert.equal(result.model, "chosen-model");
});

test("local refinements preserve unknown/no-match results and saved-use semantics", () => {
  const rows = [{ id: "quiet", match: .8, statement: 0, novelty: .1, evidence: "sufficient" }, { id: "bold", match: .8, statement: 1, novelty: 1, evidence: "sufficient" }, { id: "unknown", match: 1, evidence: "unknown" }, { id: "mismatch", match: .3, evidence: "sufficient" }];
  assert.equal(orderDiscovery(rows, { style: "understated" })[0].id, "quiet"); assert.equal(orderDiscovery(rows, { style: "statement" })[0].id, "bold"); assert.equal(orderDiscovery(rows, { lessUsed: true })[0].id, "bold");
  assert.notEqual(discoveryFingerprint([], [{ id: "a", color: "#ffffff" }]), discoveryFingerprint([], [{ id: "a", color: "#000000" }]));
  assert.equal(colourName("#000000"), "black"); assert.equal(colourName("#ffffff"), "white"); assert.equal(colourName("#000080"), "dark blue");
});
