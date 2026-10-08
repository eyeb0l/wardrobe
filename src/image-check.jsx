import { useEffect, useRef, useState } from "react";
import { uiErrorMessage } from "./ui-error.mjs";
import "./image-check.css";

export function ImageCheck({ endpoint, fingerprint, enabled, disabled = false, active = true, kind = "review" }) {
  const controller = useRef(null);
  const context = useRef(null);
  context.current = JSON.stringify([endpoint, fingerprint, enabled, active]);
  const [state, setState] = useState(null);
  useEffect(() => {
    controller.current?.abort(); controller.current = null;
    // A closed review can stay mounted; release cancelled loading state so it
    // can be checked again when reopened, without starting another request.
    setState(current => current?.busy ? null : current);
    return () => controller.current?.abort();
  }, [endpoint, fingerprint, enabled, active]);
  if (!enabled) return null;
  const current = state?.fingerprint === fingerprint && state?.endpoint === endpoint ? state : null;
  const run = async () => {
    controller.current?.abort();
    const request = new AbortController(); controller.current = request;
    const started = context.current;
    const accept = value => {
      if (!request.signal.aborted && controller.current === request && context.current === started) setState({ ...value, endpoint, fingerprint });
    };
    accept({ busy: true });
    try {
      const response = await fetch(endpoint, { method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" }, body: "{}", signal: request.signal });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "The image check is unavailable.");
      accept({ result });
    } catch (error) { accept({ error: uiErrorMessage(error, "The image check is unavailable. You can still review it yourself.") }); }
  };
  const result = current?.result;
  return <div className="wardrobe-image-check">
    <button type="button" className={kind === "preflight" ? "import-button" : "outfit-secondary"} disabled={disabled || !active || current?.busy} onClick={run}>{current?.busy ? "Checking image…" : kind === "preflight" ? "Check crop quality" : "Check photo against pieces"}</button>
    <p className={kind === "preflight" ? "import-card__detail" : "outfit-small"}>{kind === "preflight" ? "Checks the detected crop against the original image. " : "Optional image check; it can miss garment or anatomy problems. "}Uses paid credits; you make the final decision.</p>
    {current?.error ? <p role="alert" className={kind === "preflight" ? "import-field-error" : "outfit-error"}>{current.error}</p> : null}
    {result ? <div role="status" aria-live="polite">
      <p>{result.status === "no-obvious-issues" ? "No obvious issues found. Compare the image yourself before accepting." : result.status === "needs-review" ? "Some details need a closer look." : "The check is uncertain. Review these details yourself."}</p>
      <ul>{result.checks.map(check => <li key={check.id} data-state={check.state}><strong>{check.label}:</strong> {check.message}</li>)}</ul>
    </div> : null}
  </div>;
}
