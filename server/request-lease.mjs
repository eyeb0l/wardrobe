import { readFile } from "../scripts/storage-fs.mjs";
import { CLOUD_ROOT } from "../scripts/cloud-store.mjs";

export async function outsideRequestLease(store, pathname, callback) {
  const imported = pathname.match(/^\/api\/import\/jobs\/([a-f0-9-]{36})\/(?:preflight|stages\/garment\/cleanup-preview)$/i);
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
