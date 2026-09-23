import { createCloudStore } from "../scripts/cloud-store.mjs";
import { withStorage, readFile } from "../scripts/storage-fs.mjs";
import { randomUUID } from "node:crypto";
import { createPlugin } from "./plugins.mjs";
import { readTask, saveTask, reservePaidCall } from "./task-store.mjs";
import { hostedEnabled } from "./hosted-enabled.mjs";

export const INTERRUPTED = "Generation was interrupted. Check API usage before retrying; retry starts a new paid request.";

// Reuse only this worker's storage client and bounded immutable-byte cache.
// Paths still resolve from the database; each invocation acquires its own lease.
let workerStore;
const defaultStore = () => workerStore ??= createCloudStore();

export async function executeCloudTask(id, step, { store = defaultStore(), pluginFactory = createPlugin, reserve = reservePaidCall,
  enabled = hostedEnabled,
} = {}) {
  return store.withLease(() => withStorage(store, async () => {
    const task = await readTask(id);
    if (["done", "failed"].includes(task.state)) return { more: false };
    if (task.step > step) return { more: true };
    if (task.step < step) throw new Error("Task steps arrived out of order");
    // Duplicate workflow deliveries must wait while another invocation is
    // outside the storage lease. Expired paid work is never dispatched again.
    if (task.state === "running" && Date.parse(task.activeUntil) > Date.now()) return { busy: true };
    const owner = randomUUID();
    const outsideLease = async callback => {
      if (!store.withoutLease) return callback();
      const jobPath = `/wardrobe-data/${task.payload.kind === "import" ? "jobs" : "outfit-jobs"}/${task.payload.jobId}/job.json`;
      const revision = await readFile(jobPath, "utf8");
      const activeUntil = new Date(Date.now() + 260_000).toISOString();
      await saveTask({ ...await readTask(id), owner, activeUntil });
      return store.withoutLease(callback, async () => {
        const fresh = await readTask(id);
        if (fresh.owner !== owner || fresh.state !== "running" || Date.parse(fresh.activeUntil) <= Date.now()
          || revision !== await readFile(jobPath, "utf8")) {
          throw Object.assign(new Error("Task or source changed during processing"), { code: "ESTALE" });
        }
      });
    };
    const plugin = await pluginFactory(task.payload.kind, { beforePaidCall: reserve, outsideLease });
    try {
      if (!enabled()) {
        await plugin.failTask(task.payload, "Hosted generation is disabled.");
        await saveTask({ ...task, state: "failed", error: "Hosted generation is disabled." });
        return { more: false };
      }
      // A live detached owner was excluded above. An expired paid attempt
      // remains uncertain; only saved-source cleanup is safe to repeat.
      const cleanupResumable = task.state === "running" && task.payload.kind === "import" && task.payload.stageName === "garment"
        && JSON.parse(await readFile(`/wardrobe-data/jobs/${task.payload.jobId}/job.json`, "utf8").catch(error => { if (error.code === "ENOENT") return "{}"; throw error; })).stages?.garment?.status === "cleaning";
      if (task.state === "running" && !cleanupResumable) {
        await plugin.failTask(task.payload, INTERRUPTED);
        await saveTask({ ...task, state: "failed", error: INTERRUPTED });
        return { more: false };
      }
      await saveTask({ ...task, state: "running", owner, startedAt: new Date().toISOString() });
      const result = await plugin.runTask(task.payload);
      const more = (task.payload.kind === "outfit" && result === true)
        || (task.payload.kind === "import" && result?.job?.stages?.garment?.status === "cleaning");
      // An orphaned task can be reconstructed after its job already recorded
      // processing. runTask deliberately skips that uncertain paid attempt.
      // Reconcile remaining unfinished work before completing delivery; each
      // hook checks the task identity and leaves review/accepted work intact.
      // An import that actually ran already persisted review/failed state.
      // Avoid reloading it solely to discover there is nothing to reconcile.
      const importSettled = task.payload.kind === "import" && result?.skipped === false
        && ["review", "failed"].includes(result.job?.stages?.[task.payload.stageName]?.status);
      if (!more && !importSettled) await plugin.failTask(task.payload, INTERRUPTED);
      await saveTask({ ...task, state: more ? "pending" : "done", step: step + 1, updatedAt: new Date().toISOString() });
      return { more };
    } catch (error) {
      // A revision failure revokes the invocation's writer. Let recovery settle
      // its durable record; never let an old worker overwrite a newer job.
      if (error.code === "ESTALE") throw error;
      const message = error.status ? error.message : INTERRUPTED;
      await plugin.failTask(task.payload, message);
      await saveTask({ ...task, state: "failed", error: message });
      return { more: false };
    } finally { await plugin.closeBundle?.(); }
  }));
}
