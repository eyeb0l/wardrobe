import test from "node:test";
import assert from "node:assert/strict";
import { activeImportJobIds } from "../src/import-polling.mjs";

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
