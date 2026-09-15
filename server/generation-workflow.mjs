import { sleep, RetryableError } from "workflow";
import { executeCloudTask } from "./task-runner.mjs";

async function runGenerationStep(id, step) {
  "use step";
  try { return await executeCloudTask(id, step); }
  catch (error) {
    if (error.status === 409 || error.code === "WARDROBE_LEASE_BUSY") return { busy: true };
    // The durable task record makes retry safe: an uncertain started operation
    // is failed for explicit review, never automatically sent to the API again.
    throw new RetryableError("The generation store is temporarily unavailable", { retryAfter: "10s" });
  }
}

export async function generateWardrobe(id) {
  "use workflow";
  for (let step = 0; step < 14;) {
    const result = await runGenerationStep(id, step);
    if (result.busy) { await sleep("5s"); continue; }
    if (!result.more) return;
    step += 1;
  }
}
