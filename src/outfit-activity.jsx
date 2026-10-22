import { useId, useState } from "react";
import { Check, Heart } from "@phosphor-icons/react";
import { inLaundry } from "../shared/garment-availability.mjs";
import { uiErrorMessage } from "./ui-error.mjs";
import { formatWearDate, localDate, wearSummary } from "../shared/outfit-activity.mjs";

export function FavouriteButton({ outfit, busy, onChange, compact = false }) {
  return <button type="button" className={compact ? "outfit-favourite" : "outfit-secondary"}
    aria-label={`${outfit.favourite ? "Remove" : "Add"} ${outfit.name} ${outfit.favourite ? "from" : "to"} favourites`}
    aria-pressed={!!outfit.favourite} disabled={busy} onClick={() => onChange(outfit, "favourite", { favourite: !outfit.favourite })}>
    <Heart size={18} weight={outfit.favourite ? "fill" : "regular"} aria-hidden="true" />
    {!compact ? outfit.favourite ? "Favourited" : "Favourite" : null}
  </button>;
}

export function WearSummary({ outfit }) {
  const { count, lastWorn } = wearSummary(outfit);
  return <>{count ? `${count} ${count === 1 ? "wear" : "wears"} logged · Last worn ${formatWearDate(lastWorn)}` : "No wears logged"}</>;
}

export function OutfitActivity({ outfit, itemsById, busy, error, notice, onChange, onAvailabilityChange, wardrobeError, onRefreshWardrobe }) {
  const id = useId();
  const [date, setDate] = useState(localDate);
  const [pieces, setPieces] = useState(outfit.garmentIds);
  const today = localDate();
  const history = [...(outfit.wearHistory || [])].sort((a, b) => b.date.localeCompare(a.date));
  const todayEntry = history.find((event) => event.date === today);
  const dateEntry = history.find((event) => event.date === date);
  return <section className="outfit-activity" aria-label="Favourites and wearing history">
    <div className="outfit-action-row">
      <FavouriteButton outfit={outfit} busy={busy} onChange={onChange} />
      <button type="button" className="outfit-secondary" disabled={busy || !!todayEntry} onClick={() => onChange(outfit, "wears", { date: today })}>
        <Check size={17} aria-hidden="true" />{todayEntry ? "Worn today" : "Wore this today"}
      </button>
    </div>
    <p className="outfit-small"><WearSummary outfit={outfit} /></p>
    {notice?.outfitId === outfit.id ? <div className="outfit-activity-notice" role="status"><span>{notice.text}</span>{notice.eventId && history.some((event) => event.id === notice.eventId) ? <button type="button" className="outfit-text-button" disabled={busy} onClick={() => onChange(outfit, `wears/${notice.eventId}/remove`, {})}>Undo</button> : null}</div> : null}
    {error ? <p className="outfit-error" role="alert">{error}</p> : null}
    {todayEntry && onAvailabilityChange ? <WornLaundry key={todayEntry.id} entry={todayEntry} itemsById={itemsById} busy={busy} onChange={onAvailabilityChange} wardrobeError={wardrobeError} onRefresh={onRefreshWardrobe} /> : null}
    <details className="outfit-wear-history">
      <summary>Log another date or edit history</summary>
      <form onSubmit={(event) => { event.preventDefault(); void onChange(outfit, "wears", { date, garmentIds: pieces }); }}>
        <label className="outfit-field" htmlFor={`${id}-date`}><span>Date worn</span><input id={`${id}-date`} type="date" value={date} min="1900-01-01" max={today} required disabled={busy} onChange={(event) => setDate(event.target.value)} /></label>
        <fieldset disabled={busy} className="outfit-worn-pieces"><legend>Pieces you wore</legend>{outfit.garmentIds.map((garmentId) => <label key={garmentId}><input type="checkbox" checked={pieces.includes(garmentId)} onChange={(event) => setPieces((current) => event.target.checked ? [...current, garmentId] : current.filter((value) => value !== garmentId))} />{itemsById.get(garmentId)?.name || "Piece no longer in your wardrobe"}</label>)}</fieldset>
        <button type="submit" className="outfit-secondary" disabled={busy || !date || date > today || !pieces.length || !!dateEntry}>{dateEntry ? "Already logged for this date" : "Log wear"}</button>
      </form>
      {history.length ? <><p className="outfit-small">To correct an entry, remove it and log it again with the right date and pieces.</p><ul>{history.map((event) => <li key={event.id}><div><time dateTime={event.date}>{formatWearDate(event.date)}</time><p>{event.garmentIds.map((garmentId) => itemsById.get(garmentId)?.name || "Unavailable piece").join(" · ")}</p></div><button type="button" className="outfit-text-button" disabled={busy} aria-label={`Remove wear on ${formatWearDate(event.date)}`} onClick={() => onChange(outfit, `wears/${event.id}/remove`, {})}>Remove</button></li>)}</ul></> : null}
    </details>
  </section>;
}


function WornLaundry({ entry, itemsById, busy, onChange, wardrobeError, onRefresh }) {
  const [selected, setSelected] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const pieces = entry.garmentIds.map(id => itemsById.get(id)).filter(item => item && !item.hidden && !item.deleted);
  const ids = pieces.filter(item => !inLaundry(item) && selected.includes(item.id)).map(item => item.id);
  return <details className="outfit-wear-history outfit-laundry">
    <summary>Send pieces to laundry (optional)</summary>
    <p className="outfit-small">Select the pieces from today's wear that need washing. Laundry changes are separate from wear history.</p>
    <fieldset className="outfit-worn-pieces" disabled={busy || saving || !!wardrobeError}><legend>Pieces for laundry</legend>{pieces.map(item => <label key={item.id}><input type="checkbox" disabled={inLaundry(item)} checked={!inLaundry(item) && selected.includes(item.id)} onChange={event => setSelected(current => event.target.checked ? [...current, item.id] : current.filter(id => id !== item.id))} />{item.name}{inLaundry(item) ? " · In laundry" : ""}</label>)}</fieldset>
    {wardrobeError ? <div><p className="outfit-error" role="alert">Refresh your wardrobe before changing availability.</p><button type="button" className="outfit-text-button" disabled={saving || busy} onClick={() => { void onRefresh?.(); }}>Refresh wardrobe</button></div> : null}
    {error ? <p className="outfit-error" role="alert">{error}</p> : null}
    {notice ? <p className="outfit-small" role="status">{notice}</p> : null}
    <button className="outfit-secondary" type="button" disabled={busy || saving || !ids.length || !!wardrobeError} onClick={async () => {
      setSaving(true); setError(""); setNotice("");
      try {
        const saved = await onChange(ids, "laundry");
        setSelected([]); setNotice(`${saved.length} ${saved.length === 1 ? "piece sent" : "pieces sent"} to laundry.`);
      } catch (error) { setError(uiErrorMessage(error)); }
      finally { setSaving(false); }
    }}>{saving ? "Saving…" : "Send selected to laundry"}</button>
  </details>;
}
