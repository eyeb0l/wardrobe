import test from "node:test";
import assert from "node:assert/strict";
import { activeImportJobIds, importPollUrls, nextPollDelay, POLL_BATCH_SIZE, POLL_MIN_MS, POLL_MAX_MS } from "../src/import-polling.mjs";

const job = (id, crop, garment = "pending", modeled = "pending", status = "active") => ({
  id, status, stages: { crop: { status: crop }, garment: { status: garment }, modeled: { status: modeled } },
});

test("import polling fetches only jobs whose generation can advance without a decision", () => {
  const waiting = [
    job("crop-review", "review"),
    job("garment-review", "approved", "review"),
    job("modeled-review", "approved", "approved", "review"),
    job("modeled-ready", "approved", "approved", "ready"),
    job("garment-failed", "approved", "failed"),
    job("modeled-failed", "approved", "approved", "failed"),
    job("complete", "approved", "approved", "approved", "complete"),
    job("rejected", "approved", "approved", "rejected"),
  ];
  const active = [
    ...["pending", "queued", "processing"].map((state) => job(`garment-${state}`, "approved", state)),
    ...["pending", "queued", "processing"].map((state) => job(`modeled-${state}`, "approved", "approved", state)),
  ];
  assert.deepEqual(activeImportJobIds([...waiting, ...active]), active.map(({ id }) => id));
  assert.deepEqual(activeImportJobIds(waiting), []);
});

test("approval, restored pending work and retries resume polling; review stops it", () => {
  const stages = [
    [job("item", "review"), []],
    [job("item", "approved", "pending"), ["item"]],
    [job("item", "approved", "queued"), ["item"]],
    [job("item", "approved", "review"), []],
    [job("item", "approved", "approved", "pending"), ["item"]],
    [job("item", "approved", "approved", "processing"), ["item"]],
    [job("item", "approved", "approved", "failed"), []],
    [job("item", "approved", "approved", "queued"), ["item"]],
    [job("item", "approved", "approved", "review"), []],
  ];
  for (const [state, expected] of stages) assert.deepEqual(activeImportJobIds([state]), expected);
});

test("progress polling reads every active job in one capped request per tick", () => {
  const ids = Array.from({ length: POLL_BATCH_SIZE + 1 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
  assert.deepEqual(importPollUrls("/api/import/jobs", ids.slice(0, 2)), [`/api/import/jobs?ids=${ids[0]},${ids[1]}`]);
  const urls = importPollUrls("/api/import/jobs", ids);
  assert.equal(urls.length, 2);
  assert.equal(urls[0].split("=")[1].split(",").length, POLL_BATCH_SIZE);
  assert.deepEqual(importPollUrls("/api/import/jobs", []), []);
});

test("progress polling backs off while unchanged and resets after progress", () => {
  let delay = POLL_MIN_MS;
  const unchanged = [];
  for (let tick = 0; tick < 4; tick++) unchanged.push(delay = nextPollDelay(delay, false));
  assert.deepEqual(unchanged, [2250, POLL_MAX_MS, POLL_MAX_MS, POLL_MAX_MS]);
  assert.equal(nextPollDelay(delay, true), POLL_MIN_MS);
});
