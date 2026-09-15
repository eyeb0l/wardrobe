import { createCloudStore } from "../scripts/cloud-store.mjs";
import { withStorage } from "../scripts/storage-fs.mjs";
import { createPlugin } from "./plugins.mjs";
import { readTask, saveTask, reservePaidCall } from "./task-store.mjs";

export const INTERRUPTED = "Generation was interrupted. Check API usage before retrying; retry starts a new paid request.";

export async function executeCloudTask(id, step, { store = createCloudStore(), pluginFactory = createPlugin, reserve = reservePaidCall,
  enabled = () => process.env.WARDROBE_HOSTED_ENABLED === "1" && process.env.VERCEL_ENV === "production",
} = {}) {
  return store.withLease(() => withStorage(store, async () => {
    const task = await readTask(id);
    if (["done", "failed"].includes(task.state)) return { more: false };
    if (task.step > step) return { more: true };
    if (task.step < step) throw new Error("Task steps arrived out of order");
    const plugin = await pluginFactory(task.payload.kind);
    try {
      if (!enabled()) {
        await plugin.failTask(task.payload, "Hosted generation is disabled.");
        await saveTask({ ...task, state: "failed", error: "Hosted generation is disabled." });
        return { more: false };
      }
      // Acquiring the shared lease proves an earlier invocation no longer owns
      // the writer. Never repeat a call whose completion was not recorded.
      if (task.state === "running") {
        await plugin.failTask(task.payload, INTERRUPTED);
        await saveTask({ ...task, state: "failed", error: INTERRUPTED });
        return { more: false };
      }
      await reserve();
      await saveTask({ ...task, state: "running", startedAt: new Date().toISOString() });
      const result = await plugin.runTask(task.payload);
      const more = task.payload.kind === "outfit" && result === true;
      // An orphaned task can be reconstructed after its job already recorded
      // processing. runTask deliberately skips that uncertain paid attempt.
      // Reconcile remaining unfinished work before completing delivery; each
      // hook checks the task identity and leaves review/accepted work intact.
      if (!more) await plugin.failTask(task.payload, INTERRUPTED);
      await saveTask({ ...task, state: more ? "pending" : "done", step: step + 1, updatedAt: new Date().toISOString() });
      return { more };
    } catch (error) {
      const message = error.status ? error.message : INTERRUPTED;
      await plugin.failTask(task.payload, message);
      await saveTask({ ...task, state: "failed", error: message });
      return { more: false };
    } finally { await plugin.closeBundle?.(); }
  }));
}
