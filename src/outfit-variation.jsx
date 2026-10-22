import { useId, useState } from "react";
import { OptimizedImage } from "./OptimizedImage.jsx";

const supported = ["upperbody", "lowerbody", "wholebody_up", "shoes", "accessories_up"];

export function OutfitVariation({ outfit, itemsById, initialSwap, busy, error, onSave, onCancel }) {
  const id = useId();
  const [replacedId, setReplacedId] = useState(initialSwap?.garmentId || outfit.garmentIds[0]);
  const [replacementId, setReplacementId] = useState(initialSwap?.replacementId || "");
  const [name, setName] = useState(`${outfit.name.slice(0, 106)} · variation`);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const changed = () => setRequestId(crypto.randomUUID());
  const original = itemsById.get(replacedId);
  const alternatives = [...itemsById.values()].filter(item => !item.hidden && !item.deleted && item.image && item.part === original?.part && !outfit.garmentIds.includes(item.id));
  const replacement = alternatives.find(item => item.id === replacementId);
  const previewIds = outfit.garmentIds.map(piece => piece === replacedId && replacement ? replacement.id : piece);
  const available = outfit.garmentIds.every(piece => { const item = itemsById.get(piece); return item && !item.hidden && !item.deleted && item.image && supported.includes(item.part); });
  return <form onSubmit={(event) => {
    event.preventDefault();
    if (!busy && available && replacement && name.trim()) onSave(outfit, { requestId, name: name.trim(), replacedGarmentId: replacedId, replacementGarmentId: replacement.id, expectedGarmentIds: outfit.garmentIds, expectedImage: outfit.image });
  }}>
    <div className="outfit-detail-layout">
      <section className="outfit-cutout-preview" aria-label="Variation cutout preview">
        <div className="outfit-cutout-grid">{previewIds.map(piece => {
          const item = itemsById.get(piece);
          return <figure key={piece} className={piece === replacement?.id ? "is-replacement" : ""}>
            {item?.image ? <OptimizedImage src={item.image} alt={item.name} sizes="(max-width: 580px) 150px, 300px" /> : <div className="outfit-photo-fallback">Piece unavailable</div>}
            <figcaption>{item?.name || "Piece unavailable"}{piece === replacement?.id ? <span>Replacement</span> : null}</figcaption>
          </figure>;
        })}</div>
        <p className="outfit-small">Cutout preview · {replacement ? "Your new combination" : "Choose a replacement to preview"}</p>
      </section>
      <div className="outfit-detail-copy outfit-variation-controls">
        <p className="outfit-form-intro">Replace one piece from {outfit.name}. Save a separate look using these cutouts, then add a modelled photo if you want one.</p>
        {!available ? <p className="outfit-error" role="alert">A piece is unavailable or unsupported. Variations need a top-and-bottom look with available wardrobe cutouts.</p> : null}
        <label className="outfit-field" htmlFor={`${id}-piece`}><span>Piece to replace</span><select id={`${id}-piece`} disabled={busy} value={replacedId} onChange={(event) => { setReplacedId(event.target.value); setReplacementId(""); changed(); }}>{outfit.garmentIds.map(piece => <option key={piece} value={piece}>{itemsById.get(piece)?.name || "Piece unavailable"}</option>)}</select></label>
        <fieldset className="outfit-replacement-picker" disabled={busy || !available}>
          <legend>Choose a replacement</legend>
          {alternatives.length ? <div className="outfit-replacement-options">{alternatives.map(item => <label key={item.id} className={replacement?.id === item.id ? "selected" : ""}>
            <OptimizedImage src={item.thumbnail || item.image} alt="" sizes="120px" />
            <span><input type="radio" name={`${id}-replacement`} value={item.id} checked={replacement?.id === item.id} onChange={() => { setReplacementId(item.id); changed(); }} />{item.name}</span>
          </label>)}</div> : <p className="outfit-small">No other available pieces in this category. Choose another piece to replace.</p>}
        </fieldset>
        <label className="outfit-field" htmlFor={`${id}-name`}><span>Variation name</span><input id={`${id}-name`} value={name} maxLength={120} required disabled={busy} onChange={(event) => { setName(event.target.value); changed(); }} /></label>
        {error ? <p className="outfit-error" role="alert">{error}</p> : null}
        <p className="outfit-small">Saves the cutouts without an AI request. Your original outfit stays in your collection.</p>
        <div className="outfit-action-row"><button type="submit" className="outfit-primary" disabled={busy || !available || !replacement || !name.trim()}>{busy ? "Saving…" : "Save variation"}</button><button type="button" className="outfit-secondary" disabled={busy} onClick={onCancel}>Cancel</button></div>
      </div>
    </div>
  </form>;
}
