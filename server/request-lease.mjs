import { readFile } from "../scripts/storage-fs.mjs";
import { CLOUD_ROOT } from "../scripts/cloud-store.mjs";

export const independentDecisionLeases = pathname => [
  "/api/outfits/discovery/rank", "/api/outfits/discovery/swaps", "/api/shopping/analyze",
].includes(pathname);

// Shopping only reads the wardrobe; its quota reservation takes its own short
// lease. Never hold the shared writer through a provider or retailer request.
export const leaseFreeRequests = pathname => independentDecisionLeases(pathname)
  || ["/api/shopping/gaps", "/api/shopping/import-website"].includes(pathname);

export async function outsideRequestLease(store, pathname, callback, validate) {
  // Parallel discovery decisions need independent owners, not concurrent
  // suspensions of one request-wide owner. Their caller validates its evidence.
  if (independentDecisionLeases(pathname)) return store.withoutLease(callback, validate);
  // New imports write fresh job IDs, and accessory ideas recheck their photo
  // identity before saving, so either may publish after any unrelated change.
  if (pathname === "/api/import/jobs" || /^\/api\/outfits\/[a-z0-9-]{1,160}\/accessories$/.test(pathname)) {
    return store.withoutLease(callback, validate || (async () => {}));
  }
  const imported = pathname.match(/^\/api\/import\/jobs\/([a-f0-9-]{36})\/(?:preflight|detection\/retry|stages\/garment\/cleanup-preview)$/i);
  const outfit = pathname.match(/^\/api\/outfits\/jobs\/([a-f0-9-]{36})\/outfits\/[a-z0-9-]+\/check$/i);
  if (!imported && !outfit) return callback();
  const file = `${CLOUD_ROOT}/${imported ? "jobs" : "outfit-jobs"}/${(imported || outfit)[1]}/job.json`;
  const revision = await readFile(file, "utf8");
  // Provider calls and cleanup use captured image bytes. A manual action can
  // proceed meanwhile, but its new revision must fence the old invocation.
  return store.withoutLease(callback, async () => {
    const current = await readFile(file, "utf8").catch(error => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (revision !== current) throw Object.assign(new Error("The item changed. Reload its latest preview."), { code: "ESTALE", status: 409 });
  });
}
