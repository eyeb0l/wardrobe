import { start } from "workflow/api";
import { waitUntil } from "@vercel/functions";
import { createCloudStore } from "../scripts/cloud-store.mjs";
import { withStorage } from "../scripts/storage-fs.mjs";
import { createPlugin } from "./plugins.mjs";
import { createTask, saveTask, reservePaidCall } from "./task-store.mjs";
import { generateWardrobe } from "./generation-workflow.mjs";
import { recoverOutbox } from "./outbox.mjs";

let lastRecovery = 0;

function json(res, status, value) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "private, no-store");
  res.end(JSON.stringify(value));
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  // Stream large private photographs through the authenticated function rather
  // than returning a buffered payload above Vercel's response size limit.
  const end = res.end.bind(res);
  res.end = (chunk, ...args) => {
    if (Buffer.isBuffer(chunk) && chunk.length > 1024 * 1024) {
      res.removeHeader("Content-Length");
      res.flushHeaders?.();
      for (let offset = 0; offset < chunk.length; offset += 64 * 1024) res.write(chunk.subarray(offset, offset + 64 * 1024));
      return end(undefined, ...args);
    }
    return end(chunk, ...args);
  };
  // Production secrets are never available in a preview. Enable only after
  // verifying Vercel Authentication protects ALL deployment URLs.
  if (process.env.WARDROBE_HOSTED_ENABLED !== "1" || process.env.VERCEL_ENV !== "production") {
    return json(res, 503, { error: "Hosted wardrobe is not enabled for this deployment." });
  }
  const pathname = new URL(req.url, "http://localhost").pathname;
  const kind = pathname.startsWith("/api/import/") ? "import" : pathname.startsWith("/api/outfits") ? "outfit" : pathname.startsWith("/api/shopping/") ? "shopping" : null;
  if (!kind) return json(res, 404, { error: "Not found" });
  if (!["GET", "POST", "DELETE", "PATCH", "PUT"].includes(req.method)) return json(res, 405, { error: "Method not allowed" });
  const readOnly = req.method === "GET";
  if (readOnly && pathname.endsWith("/jobs") && Date.now() - lastRecovery > 30_000) {
    lastRecovery = Date.now();
    waitUntil(recoverOutbox());
  }
  const store = createCloudStore();
  let plugin;
  const serve = () => withStorage(store, async () => {
    plugin = await createPlugin(kind, {
      readOnly,
      scheduleTask: async (payload) => {
        const task = await createTask(payload);
        try {
          const run = await start(generateWardrobe, [task.id]);
          await saveTask({ ...task, runId: run.runId, dispatchedAt: new Date().toISOString() });
        } catch (error) {
          // If dispatch was accepted but acknowledgement was lost, its worker
          // sees this failed record and cannot spend again.
          await plugin.failTask(payload, "Could not start generation. Please retry.");
          await saveTask({ ...task, state: "failed", error: "Could not start generation. Please retry." });
          throw error;
        }
      },
    });
    if (!readOnly && (pathname === "/api/import/jobs" || pathname === "/api/shopping/analyze" || pathname.endsWith("/accessories"))) await reservePaidCall();
    let route;
    plugin.configureServer({ middlewares: { use(fn) { route = fn; } } });
    await route(req, res, () => json(res, 404, { error: "Not found" }));
  });
  try { await (readOnly ? serve() : store.withLease(serve)); }
  catch (error) {
    if (!res.writableEnded) json(res, error.status || 503, { error: error.status ? error.message : "The wardrobe is temporarily unavailable. Please try again." });
  } finally { await plugin?.closeBundle?.(); }
}
