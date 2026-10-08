#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { initializeDecisionEvaluation, runDecisionEvaluation, EvaluationError } from "./decision-evaluation.mjs";

const help = `Decisions image evaluation (offline by default)
  npm run decisions:eval -- --init data/decisions-evaluation/dataset
  npm run decisions:eval -- --manifest PATH --out PRIVATE_RUN_DIR [--cases ID,ID] [--split calibration|confirmation] [--rubric-version 1|2]
  npm run decisions:eval -- --manifest PATH --out PRIVATE_RUN_DIR --run --max-calls 25 [--pricing PRICING_JSON]

Use the existing OPENAI_API_KEY through the environment or Node's --env-file.
Only --run sends images to OpenAI and uses paid credits. A durable call limit
applies across resumes. Sent, failed and uncertain requests are never retried.
Never clear a ledger to resume. Images and human labels must be supplied first.
`;

export function parseEvaluationArgs(args) {
  const result = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (["--help", "--run"].includes(key)) { result[key.slice(2)] = true; continue; }
    if (!["--init", "--manifest", "--out", "--max-calls", "--cases", "--split", "--pricing", "--rubric-version"].includes(key)
      || !args[index + 1] || args[index + 1].startsWith("--")) throw new EvaluationError("Unknown argument or missing value. Use --help.");
    const value = args[++index];
    const name = { "--manifest": "manifestPath", "--out": "outDir", "--max-calls": "maxCalls", "--cases": "caseIds", "--rubric-version": "rubricVersion" }[key] || key.slice(2);
    if (name === "maxCalls") {
      if (!/^[0-9]+$/.test(value)) throw new EvaluationError("--max-calls must be an integer.");
      result[name] = Number(value);
    } else if (name === "rubricVersion") {
      if (!["1", "2"].includes(value)) throw new EvaluationError("--rubric-version must be 1 or 2.");
      result[name] = Number(value);
    } else result[name] = name === "caseIds" ? value.split(",") : value;
  }
  if (result.init && Object.keys(result).some(key => key !== "init")) throw new EvaluationError("--init cannot be combined with run options.");
  return result;
}

export async function evaluationMain(args = process.argv.slice(2)) {
  const options = parseEvaluationArgs(args);
  if (options.help) { process.stdout.write(help); return; }
  if (options.init) { process.stdout.write(`${JSON.stringify(await initializeDecisionEvaluation(options.init), null, 2)}\n`); return; }
  if (options.pricing) options.pricing = JSON.parse(await readFile(options.pricing, "utf8"));
  const report = await runDecisionEvaluation(options);
  process.stdout.write(`${JSON.stringify({ dryRun: report.dryRun, newProviderCalls: report.newProviderCalls, reportPath: report.reportPath, ledgerPath: report.ledgerPath,
    plannedCalls: report.plannedCalls, pendingCalls: report.pendingCalls, pendingLabelsOrImages: report.pendingLabelsOrImages,
    usage: report.providerUsage, latencyMs: report.latencyMs }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  evaluationMain().catch(error => {
    console.error(error instanceof EvaluationError ? error.message : "Evaluation could not finish. Check manifest, contained images, output permissions and ledger integrity. No automatic retry was made.");
    process.exitCode = 1;
  });
}
