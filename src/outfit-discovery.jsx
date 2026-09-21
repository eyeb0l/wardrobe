import { useEffect, useId, useRef, useState } from "react";
import { OptimizedImage } from "./OptimizedImage.jsx";
import { orderDiscovery } from "../shared/outfit-discovery.mjs";

function useDiscoveryRequest(fingerprint, active) {
  const controller = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const cancel = () => { controller.current?.abort(); controller.current = null; setBusy(false); setError(""); };
  useEffect(() => { cancel(); return () => controller.current?.abort(); }, [fingerprint, active]);
  const run = async (path, body, accept) => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/outfits/discovery/${path}`, { method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: current.signal });
      const value = await response.json();
      if (!response.ok) throw new Error(typeof value.error === "string" ? value.error : "Suggestions are unavailable. Please try again.");
      if (!current.signal.aborted) accept(value);
    } catch (error) { if (!current.signal.aborted) setError(error.message || "Suggestions are unavailable. Please try again."); }
    finally { if (!current.signal.aborted) setBusy(false); }
  };
  return { busy, error, run, cancel };
}

export function OutfitFinder({ config, fingerprint, active, result, onChange }) {
  const [brief, setBrief] = useState("");
  const id = useId();
  const { busy, error, run, cancel } = useDiscoveryRequest(fingerprint, active);
  if (!config?.enabled) return null;
  const count = result ? orderDiscovery(result.rankings, result).length : 0;
  const clear = () => { cancel(); onChange(null); };
  return <section className="outfit-finder" aria-label="Find a saved look">
    <form onSubmit={(event) => { event.preventDefault(); if (brief.trim() && !busy && config.ready) { onChange(null); void run("rank", { brief }, (value) => onChange({ ...value, fingerprint, style: "match", lessUsed: false })); } }}>
      <label className="outfit-field" htmlFor={id}><span>What are you feeling today?</span><input id={id} type="text" maxLength={500} value={brief} onChange={(event) => { clear(); setBrief(event.target.value); }} placeholder="Dinner, slightly overdressed, but not corporate" disabled={!config.ready} /></label>
      <button className="outfit-secondary" type="submit" disabled={!config.ready || !brief.trim() || busy}>{busy ? "Finding looks…" : "Find a saved look"}</button>
      {result || busy ? <button type="button" className="outfit-text-button" onClick={clear}>Browse all</button> : null}
    </form>
    <p className="outfit-small">{config.ready ? "Rediscover your saved looks from their styling notes and garment details." : "Outfit discovery is not available yet. You can still browse your collection."}</p>
    {error ? <p className="outfit-error" role="alert">{error} Your full collection is shown below.</p> : null}
    {result ? <>
      <div className="outfit-discovery-controls" role="group" aria-label="Refine saved looks">
        {[["match", "Best match"], ["understated", "More understated"], ["statement", "More statement"]].map(([style, label]) => <button key={style} type="button" className="outfit-secondary" aria-pressed={result.style === style} onClick={() => onChange({ ...result, style })}>{label}</button>)}
        <label><input type="checkbox" checked={result.lessUsed} onChange={(event) => onChange({ ...result, lessUsed: event.target.checked })} />Favour pieces in fewer saved looks</label>
      </div>
      <p className="outfit-small" role="status">{count ? `${count} ${count === 1 ? "look" : "looks"} to consider.` : "No clear matches from the recorded details. Try another brief or browse all."}{result.unknownCount ? ` Not enough information to judge ${result.unknownCount} ${result.unknownCount === 1 ? "look" : "looks"}.` : ""} {result.lessUsed ? "Based on saved outfit appearances, not wearing history." : ""}</p>
    </> : null}
  </section>;
}

export function OwnedItemSwaps({ outfit, itemsById, fingerprint, active }) {
  const [garmentId, setGarmentId] = useState(outfit.garmentIds[0] || "");
  const [brief, setBrief] = useState("");
  const [result, setResult] = useState(null);
  const id = useId();
  const { busy, error, run, cancel } = useDiscoveryRequest(fingerprint, active);
  const current = result?.fingerprint === fingerprint ? result : null;
  const rows = current ? orderDiscovery(current.rankings).filter((row) => itemsById.has(row.id)).slice(0, 6) : [];
  const clear = () => { cancel(); setResult(null); };
  return <section className="outfit-swaps" aria-label="Change one piece">
    <h3>Change one piece</h3>
    <p className="outfit-small">Try a replacement you already own, keeping the other pieces in this look.</p>
    <form onSubmit={(event) => { event.preventDefault(); if (brief.trim() && !busy && itemsById.has(garmentId)) { setResult(null); void run("swaps", { outfitId: outfit.id, garmentId, brief }, (value) => setResult({ ...value, fingerprint })); } }}>
      <label className="outfit-field" htmlFor={`${id}-piece`}><span>Piece to replace</span><select id={`${id}-piece`} value={garmentId} onChange={(event) => { clear(); setGarmentId(event.target.value); }}>{outfit.garmentIds.map((piece) => <option key={piece} value={piece} disabled={!itemsById.has(piece)}>{itemsById.get(piece)?.name || "Piece no longer available"}</option>)}</select></label>
      <label className="outfit-field" htmlFor={`${id}-brief`}><span>What would you change?</span><input id={`${id}-brief`} value={brief} maxLength={500} placeholder="Make this look less formal" onChange={(event) => { clear(); setBrief(event.target.value); }} /></label>
      <button className="outfit-secondary" type="submit" disabled={busy || !brief.trim() || !itemsById.has(garmentId)}>{busy ? "Finding alternatives…" : "Choose from my wardrobe"}</button>
    </form>
    {error ? <p className="outfit-error" role="alert">{error}</p> : null}
    {current ? <>
      <p className="outfit-small" role="status">{rows.length ? "Suggested replacements — compare the cutouts with your saved photo. Based on recorded details; the saved outfit stays as it is." : current.candidateCount ? "No clear replacement from the recorded details. Try another direction." : "No other available pieces in this category."}{current.unknownCount ? ` Not enough information to judge ${current.unknownCount} ${current.unknownCount === 1 ? "piece" : "pieces"}.` : ""}</p>
      <div className="outfit-pieces-grid">{rows.map(({ id }) => { const item = itemsById.get(id); return <div className="outfit-piece" key={id}><OptimizedImage src={item.thumbnail || item.image} alt={item.name} sizes="140px" /><p>{item.name}</p></div>; })}</div>
    </> : null}
  </section>;
}
