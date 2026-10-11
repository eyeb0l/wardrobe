import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { wardrobeImportApi } from "./import-job-api.mjs";

// Exercise the same read-only endpoint used by the welcome flow. It must never
// disclose credentials, create an env file, or spend credits to check readiness.
for (const scenario of [
  { name: "fresh installation", key: "", reference: false, hosted: false },
  { name: "blank key", key: "  ", reference: true, hosted: false },
  { name: "key without reference", key: "test-private-key", reference: false, hosted: false },
  { name: "configured local installation", key: "test-private-key", reference: true, hosted: false },
  { name: "hosted installation", key: "test-private-key", reference: true, hosted: true },
]) {
  test(`setup status: ${scenario.name} is safe and accurate`, async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wardrobe-setup-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    t.mock.method(globalThis, "fetch", () => assert.fail("Setup must not make external API calls"));
    const previous = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    t.after(() => {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    });
    if (scenario.reference) await writeFile(path.join(root, "reference.png"), "reference fixture");
    const plugin = wardrobeImportApi({ serverless: scenario.hosted, readOnly: true, env: {
      OPENAI_API_KEY: scenario.key,
      DATABASE_URL: "private-database-url",
      BLOB_READ_WRITE_TOKEN: "private-blob-token",
      WARDROBE_DATA_DIR: path.join(root, "data"),
      WARDROBE_MODEL_REFERENCE: "reference.png",
    } });
    await plugin.configResolved({ root });
    t.after(() => plugin.closeBundle?.());
    let handler;
    // Both development and preview use the same middleware.
    plugin.configurePreviewServer({ middlewares: { use(value) { handler = value; } } });
    const headers = {};
    let body;
    const response = { setHeader(name, value) { headers[name.toLowerCase()] = value; }, end(value) { body = value; } };
    await handler({ url: "/api/import/config", method: "GET", headers: {} }, response, () => assert.fail("Unexpected fallthrough"));
    assert.equal(response.statusCode, 200);
    assert.equal(headers["cache-control"], "no-store");
    const status = JSON.parse(body);
    assert.equal(status.hasApiKey, Boolean(scenario.key.trim()));
    assert.equal(status.hasModelReference, scenario.reference);
    assert.equal(status.ready, Boolean(scenario.key.trim()) && scenario.reference);
    assert.equal(status.setupMode, scenario.hosted ? "hosted" : "local");
    assert.doesNotMatch(body, /test-private-key|private-database-url|private-blob-token/);
    assert.deepEqual(Object.keys(status).sort(), ["hasApiKey", "hasModelReference", "imageChecks", "modelReference", "modelReferences", "ready", "setupMode"].sort());
    await assert.rejects(stat(path.join(root, ".env")), { code: "ENOENT" });
  });
}
