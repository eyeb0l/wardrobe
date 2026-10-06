import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { harness, API } from "./test-helpers/outfit-harness.mjs";
import { decisionsResponse } from "./test-helpers/decisions-response.mjs";
import { readDecisionUsage, summarizeDecisionUsage } from "./decision-usage.mjs";

test("outfit image checks compare actual selected cutouts and keep acceptance under human control", async t => {
  const charges = [];
  const h = await harness(t, { env: { WARDROBE_DECISIONS_ENABLED: "1" }, beforePaidCall: async kind => charges.push(kind) });
  const created = await h.create(); const job = await h.settled(created.id); const outfit = job.outfits[0];
  const before = await readFile(path.join(h.dataDir, "outfit-jobs", job.id, "job.json"), "utf8");
  const result = await h.action(job, outfit, "check", {});
  assert.equal(result.status, "no-obvious-issues"); assert.equal(result.checks.length, 5);
  const request = h.requests.find(item => item.kind === "decision").request;
  assert.equal(request.input[0].content.filter(part => part.type === "input_image").length, 3);
  assert.doesNotMatch(JSON.stringify(request), /outfit-test-key|identity\.png|model-reference|candidateFile|history/);
  assert.match(request.questions.find(item => item.name === "extras").instructions, /tights/);
  assert.equal(await readFile(path.join(h.dataDir, "outfit-jobs", job.id, "job.json"), "utf8"), before);
  assert.equal((await h.request("GET", `${API}/jobs/${job.id}`)).outfits[0].status, "review");
  const count = charges.length;
  assert.equal((await h.action(job, outfit, "check", {})).cached, true); assert.equal(charges.length, count);
  const usage = await readDecisionUsage(h.dataDir);
  assert.ok(usage.every(record => record.purpose === "outfit-review"));
  assert.equal(summarizeDecisionUsage(usage).providerCalls, 1);
  assert.equal(summarizeDecisionUsage(usage).cacheHits, 1);
  await h.action(job, outfit, "approve", {});
  await h.action(job, outfit, "check", {}, 409);
});

test("review checks reject replaced images and deleted pieces", async t => {
  const h = await harness(t, { env: { WARDROBE_DECISIONS_ENABLED: "1" } });
  const created = await h.create(); const job = await h.settled(created.id); const outfit = job.outfits[0];
  h.setDecisions(async body => {
    const stored = JSON.parse(await readFile(path.join(h.dataDir, "outfit-jobs", job.id, "job.json"), "utf8"));
    await writeFile(path.join(h.dataDir, "outfit-jobs", job.id, stored.outfits[0].internal.candidateFile), h.identity);
    return Response.json(decisionsResponse(body));
  });
  assert.match((await h.action(job, outfit, "check", {}, 409)).error, /changed/);
  const records = h.items.map(item => item.id === outfit.garmentIds[0] ? { ...item, hidden: true } : item);
  await writeFile(path.join(h.dataDir, "library.json"), JSON.stringify(records));
  await h.action(job, outfit, "check", {}, 409);
  assert.equal(h.requests.filter(item => item.kind === "decision").length, 1);
});

test("review checks remain gated independently of ordinary generation", async t => {
  const h = await harness(t, { env: { WARDROBE_DECISIONS_ENABLED: "0" } });
  const created = await h.create(); const job = await h.settled(created.id);
  assert.equal((await h.request("GET", `${API}/config`)).imageChecks.enabled, false);
  await h.action(job, job.outfits[0], "check", {}, 503);
  assert.equal(h.requests.filter(item => item.kind === "decision").length, 0);
});
