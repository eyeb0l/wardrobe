import test from "node:test";
import assert from "node:assert/strict";
import { createViewResource } from "../src/view-resource.mjs";

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("a retained view reuses fresh data, refreshes after its TTL, and allows a forced focus refresh", async () => {
  let now = 0, reads = 0;
  const values = [];
  const resource = createViewResource({ load: async () => ++reads, onValue: (value) => values.push(value), onError: assert.fail, now: () => now });
  await resource.refresh();
  now = 29_999;
  await resource.refresh();
  assert.equal(reads, 1);
  now = 30_000;
  await resource.refresh();
  await resource.refresh({ force: true });
  assert.deepEqual(values, [1, 2, 3]);
});

test("overlapping return, focus and refresh actions share a pending read", async () => {
  const response = deferred();
  let reads = 0;
  const resource = createViewResource({ load: () => { reads++; return response.promise; }, onValue: () => {}, onError: assert.fail });
  const first = resource.refresh();
  assert.equal(resource.refresh({ force: true }), first);
  response.resolve({ ready: true });
  await first;
  assert.equal(reads, 1);
});

test("settings can finish and enable readiness while history is still pending", async () => {
  const historyResponse = deferred();
  const loaded = [];
  const settings = createViewResource({ load: async () => ({ ready: true }), onValue: () => loaded.push("settings"), onError: assert.fail });
  const history = createViewResource({ load: () => historyResponse.promise, onValue: () => loaded.push("history"), onError: assert.fail });
  const pendingHistory = history.refresh();
  await settings.refresh();
  assert.deepEqual(loaded, ["settings"]);
  historyResponse.resolve({ jobs: [] });
  await pendingHistory;
  assert.deepEqual(loaded, ["settings", "history"]);
});

test("hiding a view aborts requests and fences late values and loading changes", async () => {
  const old = deferred(), next = deferred();
  const values = [], loading = [], signals = [];
  const resource = createViewResource({
    load: (signal) => { signals.push(signal); return signals.length === 1 ? old.promise : next.promise; },
    onValue: (value) => values.push(value), onError: assert.fail, onLoading: (value) => loading.push(value),
  });
  const previous = resource.refresh();
  await Promise.resolve();
  resource.cancel();
  assert.equal(signals[0].aborted, true);
  const resumed = resource.refresh();
  old.resolve("stale");
  await previous;
  assert.deepEqual(values, []);
  assert.deepEqual(loading, [true, false, true]);
  next.resolve("current");
  await resumed;
  assert.deepEqual(values, ["current"]);
  assert.deepEqual(loading, [true, false, true, false]);
});

test("mutation invalidation discards pending pre-mutation data and bypasses freshness", async () => {
  const old = deferred();
  let reads = 0;
  const values = [];
  const resource = createViewResource({ load: () => ++reads === 1 ? old.promise : Promise.resolve("updated"), onValue: (value) => values.push(value), onError: assert.fail });
  const previous = resource.refresh();
  await Promise.resolve();
  resource.invalidate();
  await resource.refresh();
  old.resolve("before mutation");
  await previous;
  assert.deepEqual(values, ["updated"]);
  resource.invalidate();
  await resource.refresh();
  assert.equal(reads, 3);
});

test("errors are retryable on return and cancelled errors are not shown", async () => {
  const errors = [], cancelled = deferred();
  let reads = 0;
  const resource = createViewResource({
    load: () => ++reads === 1 ? Promise.reject(new Error("Offline")) : reads === 2 ? cancelled.promise : Promise.resolve("ready"),
    onValue: () => {}, onError: (error) => errors.push(error.message),
  });
  await assert.rejects(resource.refresh(), /Offline/);
  const pending = resource.refresh();
  await Promise.resolve();
  resource.cancel();
  cancelled.reject(new Error("Aborted request"));
  await pending;
  await resource.refresh();
  assert.deepEqual(errors, ["Offline"]);
  assert.equal(reads, 3);
});
