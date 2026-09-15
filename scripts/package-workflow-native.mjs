import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const functionsDir = path.resolve(".vercel/output/functions");
const stepDir = path.join(functionsDir, ".well-known/workflow/v1/step.func");
const stepConfigPath = path.join(stepDir, ".vc-config.json");
const architecture = { x64: "x86_64", arm64: "arm64" }[process.arch];
assert(architecture, `Unsupported Vercel build architecture: ${process.arch}`);

// WDK bundles Sharp's JavaScript, but does not trace its dynamic native imports.
// Nitro already traces that same dependency for the API; keep its complete closure.
await rm(path.join(stepDir, "node_modules"), { recursive: true, force: true });
await cp(path.join(functionsDir, "__server.func/node_modules"), path.join(stepDir, "node_modules"), {
  recursive: true,
  dereference: true,
});
const config = JSON.parse(await readFile(stepConfigPath, "utf8"));
assert(config.experimentalTriggers?.some((trigger) => trigger.type === "queue/v2beta" && trigger.topic === "__wkf_step_*"),
  "The Workflow step must retain its queue trigger");
await writeFile(stepConfigPath, `${JSON.stringify({
  ...config,
  runtime: "nodejs22.x",
  architecture,
  maxDuration: 300,
}, null, 2)}\n`);

// Copy outside the repository so ancestor node_modules cannot hide missing files.
// Importing registers the real step without executing it or making paid API calls.
const isolatedDir = await mkdtemp(path.join(tmpdir(), "wardrobe-workflow-package-"));
try {
  await cp(stepDir, isolatedDir, { recursive: true, dereference: true });
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=commonjs", "-e", `
    const assert = require("node:assert/strict");
    globalThis.fetch = async () => { throw new Error("Network access is forbidden during package verification"); };
    const entrypoint = require("./index.js");
    assert.equal(typeof entrypoint.POST, "function");
    const steps = globalThis[Symbol.for("@workflow/core//registeredSteps")];
    assert.equal(typeof steps?.get("step//./server/generation-workflow//runGenerationStep"), "function");
    const sharp = require("./node_modules/sharp");
    (async () => {
      const image = await sharp({ create: { width: 1, height: 1, channels: 3, background: "#ffffff" } }).png().toBuffer();
      assert.equal((await sharp(image).metadata()).width, 1);
      console.log("Workflow native package verified: " + process.platform + "/" + process.arch + ", Sharp " + sharp.versions.sharp);
    })().catch((error) => { console.error(error); process.exitCode = 1; });
  `], {
    cwd: isolatedDir,
    env: { PATH: process.env.PATH, NODE_ENV: "production" },
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  process.stdout.write(stdout);
} finally {
  await rm(isolatedDir, { recursive: true, force: true });
}
