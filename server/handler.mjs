import { start } from "workflow/api";
import { waitUntil } from "@vercel/functions";
import { createCloudStore } from "../scripts/cloud-store.mjs";
import { withStorage } from "../scripts/storage-fs.mjs";
import { createPlugin, DATA_ROOT } from "./plugins.mjs";
import { sendDisplayImage, sendOriginalImage } from "../scripts/display-image.mjs";
import { createTask, saveTask, reservePaidCall } from "./task-store.mjs";
import { generateWardrobe } from "./generation-workflow.mjs";
import { recoverOutbox } from "./outbox.mjs";
import { maintenance } from "./maintenance.mjs";

let lastRecovery = 0;
let imageStore;
// Reuse only the byte cache/client across warm requests. Each path lookup and
// route authorization is still fresh; writer ownership uses AsyncLocalStorage.
const requestStore = () => imageStore ??= createCloudStore();

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
  const requestUrl = new URL(req.url, "http://localhost");
  const pathname = requestUrl.pathname;
  if (pathname === "/api/maintenance/storage") return maintenance(req, res, createCloudStore());
  const kind = pathname.startsWith("/api/import/") ? "import" : pathname.startsWith("/api/outfits") ? "outfit" : pathname.startsWith("/api/shopping/") ? "shopping" : null;
  if (!kind) return json(res, 404, { error: "Not found" });
  if (!["GET", "POST", "DELETE", "PATCH", "PUT"].includes(req.method)) return json(res, 405, { error: "Method not allowed" });
  const readOnly = req.method === "GET";
  if (readOnly && pathname.endsWith("/jobs") && Date.now() - lastRecovery > 30_000) {
    lastRecovery = Date.now();
    waitUntil(recoverOutbox());
  }
  const store = requestStore();
  let plugin;
  const serve = () => withStorage(store, async () => {
    // The library's image route only requires an existing file in imported/.
    // Avoid loading every import job for each gallery thumbnail. Authentication
    // and the production gate above still apply to every request.
    const libraryImage = pathname.match(/^\/api\/import\/library\/([\w.-]+\.(?:png|jpe?g|webp))$/i);
    if (readOnly && libraryImage) {
      const file = `${DATA_ROOT}/imported/${libraryImage[1]}`;
      if (await sendDisplayImage(req, res, file, requestUrl)) return;
      await sendOriginalImage(req, res, file);
      return;
    }
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
  const waiting = new AbortController();
  const disconnected = () => { if (!res.writableEnded) waiting.abort(); };
  req.once("aborted", disconnected);
  res.once("close", disconnected);
  if (req.aborted || res.destroyed) waiting.abort();
  // A finished image can be visible while its worker is recording completion.
  // Keep this action pending through that short handoff instead of returning
  // an error that forces the user to click again. Long-running work still wins.
  try { await (readOnly ? serve() : store.withLease(serve, { waitMs: 8_000, signal: waiting.signal })); }
  catch (error) {
    if (!res.writableEnded && !waiting.signal.aborted) json(res, error.status || 503, { error: error.status ? error.message : "The wardrobe is temporarily unavailable. Please try again." });
  } finally {
    req.off("aborted", disconnected);
    res.off("close", disconnected);
    await plugin?.closeBundle?.();
  }
}
