import { useEffect, useId, useRef, useState } from 'react';
import { OptimizedImage } from './OptimizedImage.jsx';
import { matchingSavedLook, wornLookIssue, WORN_LOOK_PARTS } from '../shared/worn-look.mjs';
import { formatWearDate } from '../shared/outfit-activity.mjs';
import { inLaundry } from '../shared/garment-availability.mjs';
import { uiErrorMessage } from './ui-error.mjs';
import './worn-look.css';

export function WornLook({ source, entry, itemsById, outfits, busy, unavailable, onRefresh, onSave, onOpen, onClose }) {
  const dialog = useRef(null);
  const id = useId();
  const [selected, setSelected] = useState(source.garmentIds);
  const [name, setName] = useState('');
  const [occasion, setOccasion] = useState('casual');
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(new Set());
  const [failed, setFailed] = useState(new Set());
  const [attempt, setAttempt] = useState(0);
  const close = useRef(onClose); close.current = onClose;
  const saving = useRef(busy); saving.current = busy;
  useEffect(() => {
    const node = dialog.current, previous = document.activeElement, overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden'; node.showModal();
    return () => { node.close(); document.body.style.overflow = overflow; if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  const pieces = selected.map(piece => itemsById.get(piece));
  const issue = wornLookIssue(pieces) || (pieces.some(piece => !piece.image) ? 'A selected cutout is unavailable. Refresh your wardrobe.' : '');
  const blocked = !entry ? 'This wear entry was removed. Close this preview and refresh your wear history.' : unavailable;
  const ready = !issue && pieces.every(piece => loaded.has(piece.image) && !failed.has(piece.image));
  const matching = matchingSavedLook(outfits, selected);
  const occasions = [...new Set(['casual', 'work', 'dinner', 'smart-casual', ...outfits.flatMap(outfit => outfit.occasion || [])])].sort();
  const changed = () => { setRequestId(crypto.randomUUID()); setError(''); setResult(null); };
  const show = result?.outfit || matching;
  return <dialog ref={dialog} className="worn-look-modal" aria-labelledby={`${id}-title`} onCancel={event => { event.preventDefault(); if (!saving.current) close.current(); }}>
    <header><div><p>Worn on {formatWearDate(source.date)}</p><h2 id={`${id}-title`}>Save what you wore</h2></div><button className="secondary-button" type="button" disabled={busy} onClick={onClose}>Close</button></header>
    <p>Choose the pieces you wore together, preview their cutouts, and save a look for another day.</p>
    <form className="worn-look-layout" onSubmit={async event => {
      event.preventDefault();
      if (busy || blocked || !ready || matching || !name.trim() || !occasion.trim()) return;
      setError('');
      try { setResult(await onSave(source.id, { requestId, name: name.trim(), occasion: occasion.trim(), garmentIds: selected, expectedPieces: pieces.map(({ id, revision }) => ({ id, revision })) })); }
      catch (error) { setError(uiErrorMessage(error)); if (error.status === 409) setRequestId(crypto.randomUUID()); }
    }}>
      <section className="worn-look-preview" aria-label="Worn look cutout preview">
        <div className="worn-look-grid">{pieces.slice(0, 5).slice().sort((a, b) => WORN_LOOK_PARTS.indexOf(a?.part) - WORN_LOOK_PARTS.indexOf(b?.part)).map((piece, index) => <figure key={`${piece?.id || selected[index]}-${piece?.image}-${attempt}`}>
          {piece?.image && !failed.has(piece.image) ? <OptimizedImage src={piece.image} alt={piece.name} loading="eager" sizes="(max-width: 580px) 150px, 250px" onLoad={() => setLoaded(current => new Set([...current, piece.image]))} onError={() => setFailed(current => new Set([...current, piece.image]))} /> : <div className="worn-look-missing">Cutout unavailable</div>}
          <figcaption>{piece?.name || 'Piece no longer in wardrobe'}{piece && inLaundry(piece) ? <span>In laundry</span> : null}</figcaption>
        </figure>)}</div>
        {!selected.length ? <p>Choose pieces to preview a combination.</p> : null}
        <p>Cutout preview · Saves without an AI request.</p>
        {failed.size ? <p role="status">A cutout could not load. <button className="secondary-button" type="button" onClick={() => { setFailed(new Set()); setLoaded(new Set()); setAttempt(value => value + 1); }}>Retry cutouts</button></p> : null}
      </section>
      <div className="worn-look-fields">
        <fieldset disabled={busy}><legend>Pieces in this look</legend>{source.garmentIds.map(piece => <label className="worn-look-piece" key={piece}><input type="checkbox" checked={selected.includes(piece)} onChange={event => { setSelected(current => event.target.checked ? [...current, piece] : current.filter(id => id !== piece)); changed(); }} />{itemsById.get(piece)?.name || 'Piece no longer in wardrobe'}</label>)}<button className="worn-look-link" type="button" onClick={() => { setSelected([]); changed(); }}>Clear selection</button></fieldset>
        <label className="field" htmlFor={`${id}-name`}><span>Look name</span><input id={`${id}-name`} value={name} required maxLength={120} disabled={busy} onChange={event => { setName(event.target.value); changed(); }} /></label>
        <label className="field" htmlFor={`${id}-occasion`}><span>Look occasion</span><input id={`${id}-occasion`} list={`${id}-occasions`} value={occasion} required maxLength={50} disabled={busy} onChange={event => { setOccasion(event.target.value); changed(); }} /><datalist id={`${id}-occasions`}>{occasions.map(value => <option key={value} value={value} />)}</datalist></label>
        {blocked ? <p role="status">{blocked} {entry ? <button className="secondary-button" type="button" disabled={busy} onClick={onRefresh}>Refresh wardrobe and looks</button> : null}</p> : null}
        {issue ? <p role="status">{issue}</p> : !ready ? <p role="status">Checking selected cutouts…</p> : null}
        {error ? <p role="alert">{error}</p> : null}
        {show && !blocked ? <div className="worn-look-result" role="status"><p>{result?.created ? 'Look saved' : 'Already saved'}: <strong>{show.name}</strong>.</p><button className="secondary-button" type="button" disabled={busy} onClick={() => onOpen(show.id)}>Open saved look</button></div> : null}
        <p>Saving keeps the original wear entry, wear counts and laundry state. Looks with laundry pieces become eligible for the shortlist when those pieces are Ready.</p>
        <button className="secondary-button" type="submit" disabled={busy || !!blocked || !ready || !!matching || !name.trim() || !occasion.trim()}>{busy ? 'Saving…' : 'Save look'}</button>
      </div>
    </form>
  </dialog>;
}
