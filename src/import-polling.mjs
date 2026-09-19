// Review/ready stages wait for a user decision. Only generation can advance
// on the server, including the pending handoff after an approval or recovery.
export function activeImportJobIds(jobs) {
  return jobs.filter((job) => {
    if (job.status === "complete" || Object.values(job.stages || {}).some((stage) => stage?.status === "rejected")) return false;
    const { crop, garment, modeled } = job.stages || {};
    return (crop?.status === "approved" && ["pending", "queued", "processing"].includes(garment?.status))
      || ["queued", "processing"].includes(modeled?.status)
      || (garment?.status === "approved" && modeled?.status === "pending");
  }).map((job) => job.id);
}
