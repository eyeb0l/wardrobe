import { start } from "workflow/api";
import { withStorage, readdir } from "../scripts/storage-fs.mjs";
import { createCloudStore } from "../scripts/cloud-store.mjs";
import { DATA_ROOT, createPlugin } from "./plugins.mjs";
import { createTask, readTask, saveTask } from "./task-store.mjs";
import { generateWardrobe } from "./generation-workflow.mjs";

// Reuse task identities after a lost dispatch acknowledgement. Executions are
// serialized and fenced by the task runner, so duplicate delivery is harmless.
export async function dispatchTask(task) {
  const run = await start(generateWardrobe, [task.id]);
  await saveTask({ ...task, runId: run.runId, dispatchedAt: new Date().toISOString() });
}

export async function recoverOutbox() {
  const store = createCloudStore();
  try {
    await store.withLease(() => withStorage(store, async () => {
      for (const kind of ["import", "outfit"]) {
        const plugin = await createPlugin(kind);
        try {
          for (const payload of await plugin.pendingTasks()) {
            try {
              const existing = await readTask(payload.taskId);
              if (existing.state === "failed") await plugin.failTask(payload, existing.error);
            }
            catch (error) {
              if (error.code !== "ENOENT") throw error;
              await createTask(payload);
            }
          }
        } finally { await plugin.closeBundle?.(); }
      }
      const names = await readdir(`${DATA_ROOT}/.tasks`).catch((error) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      for (const name of names) {
        if (!/^[a-f0-9-]{36}\.json$/i.test(name)) continue;
        const task = await readTask(name.slice(0, -5));
        if (["done", "failed"].includes(task.state)) continue;
        if (task.runId && Date.now() - Date.parse(task.dispatchedAt || task.createdAt) < 15 * 60_000) continue;
        await dispatchTask(task);
      }
    }));
  } catch (error) {
    // Another active writer has ownership. A later poll can resume recovery.
    if (error.code !== "EBUSY") console.error("Wardrobe outbox recovery unavailable", error.code || "storage");
  }
}
