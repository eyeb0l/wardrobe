// Each retained view owns its resources: freshness lasts only for this mount.
// Cancelling a hidden view also fences late responses from transports that ignore abort.
export function createViewResource({ load, onValue, onError, onLoading = () => {}, now = Date.now, freshForMs = 30_000 }) {
  let lastSuccess = null;
  let pending = null;

  const cancel = () => {
    if (!pending) return;
    const previous = pending;
    pending = null;
    previous.controller.abort();
    onLoading(false);
  };

  return {
    refresh({ force = false } = {}) {
      if (pending) return pending.promise;
      if (!force && lastSuccess !== null && now() - lastSuccess < freshForMs) return Promise.resolve();
      const attempt = { controller: new AbortController() };
      pending = attempt;
      onLoading(true);
      attempt.promise = Promise.resolve().then(() => load(attempt.controller.signal)).then((value) => {
        if (pending !== attempt) return;
        lastSuccess = now();
        onValue(value);
        return value;
      }, (error) => {
        if (pending !== attempt) return;
        lastSuccess = null;
        onError(error);
        throw error;
      }).finally(() => {
        if (pending !== attempt) return;
        pending = null;
        onLoading(false);
      });
      return attempt.promise;
    },
    cancel,
    invalidate() { lastSuccess = null; cancel(); },
  };
}
