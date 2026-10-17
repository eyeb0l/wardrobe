// Review/ready stages wait for a user decision. Only generation can advance
// on the server, including the pending handoff after an approval or recovery.
export function activeImportJobIds(jobs) {
  return jobs.filter((job) => {
    if (job.status === "complete" || Object.values(job.stages || {}).some((stage) => stage?.status === "rejected")) return false;
    const { crop, garment, modeled } = job.stages || {};
    return (crop?.status === "approved" && ["pending", "queued", "processing", "cleaning"].includes(garment?.status))
      || ["queued", "processing"].includes(modeled?.status)
      || (garment?.status === "approved" && modeled?.status === "pending");
  }).map((job) => job.id);
}

// One request per tick covers every polled job; the server caps each read.
export const POLL_BATCH_SIZE = 32;
export function importPollUrls(api, ids) {
  const urls = [];
  for (let start = 0; start < ids.length; start += POLL_BATCH_SIZE) {
    urls.push(`${api}?ids=${ids.slice(start, start + POLL_BATCH_SIZE).map(encodeURIComponent).join(",")}`);
  }
  return urls;
}

// Poll promptly after progress, then back off gently while nothing changes.
export const POLL_MIN_MS = 1500;
export const POLL_MAX_MS = 3000;
export function nextPollDelay(previous, changed) {
  return changed ? POLL_MIN_MS : Math.min(POLL_MAX_MS, Math.round(previous * 1.5));
}
