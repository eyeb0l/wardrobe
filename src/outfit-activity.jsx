import { useId, useState } from "react";
import { Check, Heart } from "@phosphor-icons/react";
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

export function OutfitActivity({ outfit, itemsById, busy, error, notice, onChange }) {
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
