import { useState } from "react";
import { inLaundry } from "../shared/garment-availability.mjs";
import { uiErrorMessage } from "./ui-error.mjs";
import "./worn-laundry.css";

export function WornLaundry({ entry, itemsById, busy, onChange, wardrobeError, onRefresh, buttonClass = "outfit-secondary" }) {
  const [selected, setSelected] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const pieces = entry.garmentIds.map(id => itemsById.get(id)).filter(item => item && !item.hidden && !item.deleted);
  const ids = pieces.filter(item => !inLaundry(item) && selected.includes(item.id)).map(item => item.id);
  return <details className="outfit-wear-history outfit-laundry worn-laundry">
    <summary>Send pieces to laundry (optional)</summary>
    <p className="outfit-small">Select the pieces from this logged wear that need washing. Laundry changes are separate from wear history.</p>
    <fieldset className="outfit-worn-pieces" disabled={busy || saving || !!wardrobeError}><legend>Pieces for laundry</legend>{pieces.map(item => <label key={item.id}><input type="checkbox" disabled={inLaundry(item)} checked={!inLaundry(item) && selected.includes(item.id)} onChange={event => setSelected(current => event.target.checked ? [...current, item.id] : current.filter(id => id !== item.id))} />{item.name}{inLaundry(item) ? " · In laundry" : ""}</label>)}</fieldset>
    {wardrobeError ? <div><p className="outfit-error" role="alert">Refresh your wardrobe before changing availability.</p><button type="button" className="outfit-text-button" disabled={saving || busy} onClick={() => { void onRefresh?.(); }}>Refresh wardrobe</button></div> : null}
    {error ? <p className="outfit-error" role="alert">{error}</p> : null}
    {notice ? <p className="outfit-small" role="status">{notice}</p> : null}
    <button className={buttonClass} type="button" disabled={busy || saving || !ids.length || !!wardrobeError} onClick={async () => {
      setSaving(true); setError(""); setNotice("");
      try {
        const saved = await onChange(ids, "laundry");
        setSelected([]); setNotice(`${saved.length} ${saved.length === 1 ? "piece sent" : "pieces sent"} to laundry.`);
      } catch (error) { setError(uiErrorMessage(error)); }
      finally { setSaving(false); }
    }}>{saving ? "Saving…" : "Send selected to laundry"}</button>
  </details>;
}
