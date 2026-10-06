import { skillStorage } from "./skill-storage.mjs";
import { withStorage } from "./storage-fs.mjs";
import { readDecisionUsage, summarizeDecisionUsage, DECISIONS_LUNA_PRICING } from "./decision-usage.mjs";

try {
  const options = {};
  for (let index = 2; index < process.argv.length; index++) {
    const key = process.argv[index];
    if (!["--target", "--data-dir"].includes(key) || !process.argv[index + 1] || process.argv[index + 1].startsWith("--")) throw new Error("Invalid arguments");
    options[key === "--target" ? "target" : "dataDir"] = process.argv[++index];
  }
  const storage = await skillStorage(options);
  const records = await withStorage(storage.store, () => readDecisionUsage(storage.dataDir));
  const groups = new Map();
  for (const record of records) {
    const dimensions = { purpose: record.purpose, model: record.model, provider: record.provider };
    const key = JSON.stringify(dimensions);
    if (!groups.has(key)) groups.set(key, { dimensions, records: [] });
    groups.get(key).records.push(record);
  }
  process.stdout.write(`${JSON.stringify({ generatedAt: new Date().toISOString(), pricing: DECISIONS_LUNA_PRICING,
    overall: summarizeDecisionUsage(records, DECISIONS_LUNA_PRICING),
    groups: [...groups.values()].map(group => ({ ...group.dimensions, ...summarizeDecisionUsage(group.records, DECISIONS_LUNA_PRICING) })),
    note: "Observed counters and rate-based cost ranges only; missing usage and interrupted dispatches remain unknown. Storage outages may leave incomplete coverage. This is not the provider bill." }, null, 2)}\n`);
} catch {
  console.error("Could not read Decisions usage. Select --target local or cloud and check storage configuration and record integrity.");
  process.exitCode = 1;
}
