// A reload may find a durable dispatch marker after the original request was
// interrupted. Observe it briefly; never turn that marker into another paid call.
export const DETECTION_RETRY_WAIT_MS = 240_000;

export function isDetectionRetryRunning(job, now = Date.now()) {
  const attempt = job?.detectionRetryAttempt;
  if (attempt?.status !== "started") return false;
  const createdAt = Date.parse(attempt.createdAt);
  return Number.isFinite(createdAt) && now >= createdAt && now - createdAt < DETECTION_RETRY_WAIT_MS;
}
