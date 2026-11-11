import { useId, useRef, useState } from "react";
import { Camera } from "@phosphor-icons/react";
import { CARE_FIELDS, CARE_NOTES_LIMIT, careSummary } from "../shared/garment-care.mjs";
import { IMAGE_ACCEPT, isImageUpload } from "./image-upload.mjs";
import { prepareShoppingImage } from "./shopping-image.mjs";
import { wardrobeRequest } from "./wardrobe-sync.mjs";
import { uiErrorMessage } from "./ui-error.mjs";
import "./care-label.css";

// Care instructions are part of the item draft: a scan only fills the form,
// and nothing is saved until the person reviews it and chooses Save.
export function CareLabelEditor({ care, onChange }) {
  const id = useId();
  const input = useRef(null);
  const scanVersion = useRef(0);
  const [scanning, setScanning] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const value = care || {};
  const summary = careSummary(care);
  const set = (key, next) => onChange({ ...value, [key]: next || undefined });

  const scan = async file => {
    if (!file) return;
    const version = ++scanVersion.current;
    setError(""); setStatus("");
    if (!isImageUpload(file)) { setError("Choose a JPEG, PNG, WebP or HEIC photo of the label."); return; }
    setScanning(true);
    try {
      const image = await prepareShoppingImage(file);
      const { care: read } = await wardrobeRequest("/api/import/care-label/scan", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ imageDataUrl: image.dataUrl }),
      });
      if (version !== scanVersion.current) return;
      // Fill what the label shows; leave anything it doesn't mention as it was.
      onChange({ ...value, ...read });
      const count = Object.keys(read).filter(key => key !== "notes").length;
      setStatus(`Read ${count} ${count === 1 ? "instruction" : "instructions"} from the label. Check them, then save.`);
    } catch (error) {
      if (version === scanVersion.current) setError(uiErrorMessage(error));
    } finally {
      if (version === scanVersion.current) setScanning(false);
    }
  };

  return <details className="care-label">
    <summary><span className="care-label-title">Care label</span><span className="care-label-summary">{summary.length ? summary.join(" · ") : value.notes ? "Notes added" : "Not added"}</span></summary>
    <div className="care-label-body">
      <div className="care-label-scan">
        <input ref={input} id={`${id}-photo`} className="visually-hidden" type="file" accept={IMAGE_ACCEPT} capture="environment" tabIndex={-1} aria-hidden="true"
          onChange={event => { const [file] = event.target.files || []; event.target.value = ""; void scan(file); }} />
        <button type="button" className="secondary-button" disabled={scanning} onClick={() => input.current?.click()}><Camera size={16} aria-hidden="true" />{scanning ? "Reading label…" : "Scan care label"}</button>
        <p>Take or choose a close photo of the symbols. The photo isn’t kept.</p>
      </div>
      {error ? <p className="care-label-error" role="alert">{error}</p> : null}
      <p className="care-label-status" role="status">{status}</p>
      <div className="care-label-fields">
        {CARE_FIELDS.map(field => <label key={field.key} className="field"><span>{field.label}</span>
          <select value={value[field.key] || ""} disabled={scanning} onChange={event => set(field.key, event.target.value)}>
            <option value="">Not specified</option>
            {field.options.map(([option, label]) => <option key={option} value={option}>{label}</option>)}
          </select>
        </label>)}
        <label className="field care-label-notes"><span>Care notes</span>
          <textarea rows={2} maxLength={CARE_NOTES_LIMIT} value={value.notes || ""} disabled={scanning} placeholder="For example, wash inside out" onChange={event => set("notes", event.target.value)} />
        </label>
      </div>
      {summary.length || value.notes ? <button type="button" className="garment-wear-link care-label-clear" disabled={scanning} onClick={() => { setStatus("Care label cleared. Save to keep this change."); setError(""); onChange(null); }}>Clear care label</button> : null}
    </div>
  </details>;
}
