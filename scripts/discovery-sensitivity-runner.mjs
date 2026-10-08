#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { runDiscoverySensitivity } from "./discovery-sensitivity.mjs";

export function parseSensitivityArgs(args) {
  const options = { briefs: [] };
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (key === "--help") { options.help = true; continue; }
    if (key === "--run") { options.run = true; continue; }
    if (!["--data-dir", "--out", "--brief", "--seeds", "--repeats", "--max-calls"].includes(key)
      || !args[index + 1] || args[index + 1].startsWith("--")) throw new Error("Unknown argument or missing value. Use --help.");
    const value = args[++index];
    if (key === "--brief") options.briefs.push(value);
    else if (key === "--data-dir") options.dataDir = value;
    else if (key === "--out") options.outDir = value;
    else {
      if (!/^\d+(,\d+)*$/.test(value) || (key !== "--seeds" && value.includes(","))) throw new Error("Counts and seeds must be integers.");
      const field = { "--seeds": "seeds", "--repeats": "repeats", "--max-calls": "maxCalls" }[key];
      options[field] = key === "--seeds" ? value.split(",").map(Number) : Number(value);
    }
  }
  return options;
}

export async function sensitivityMain(args = process.argv.slice(2)) {
  const options = parseSensitivityArgs(args);
  if (options.help) {
    process.stdout.write(`Discovery batch sensitivity (offline unless --run is supplied)
  node scripts/discovery-sensitivity-runner.mjs --data-dir PRIVATE_SNAPSHOT --out PRIVATE_RUN_DIR --brief "Dinner"
  Add --run --max-calls N only after reviewing the offline call bound.
  Optional: --seeds 1,2 --repeats 2; repeat --brief for more cases.

Original and reversed batch order are compared with shuffled membership/order.
Every layout repeats to measure ordinary model variation; provider cache is bypassed.
Uses the existing OPENAI_API_KEY through the environment or Node's --env-file.
Paid runs require a fresh run.json; uncertain/failed calls are never retried.
`);
    return;
  }
  const result = await runDiscoverySensitivity(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.failedTrials || result.incompleteTrials) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  sensitivityMain().catch(() => { console.error("Sensitivity evaluation could not finish. Check the private snapshot, call cap and fresh output directory. No automatic retry was made."); process.exitCode = 1; });
}
