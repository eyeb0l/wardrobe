import { useId, useRef, useState } from 'react';
import { validWearDate, formatWearDate } from '../shared/outfit-activity.mjs';
import { garmentWearDates } from '../shared/outfit-shortlist.mjs';
import { WornLaundry } from './worn-laundry.jsx';
import { uiErrorMessage } from './ui-error.mjs';
import './garment-wear-controls.css';

export function GarmentWearControls({ ids, outfits, garmentWears, today, itemsById, busy, unavailable, onRefresh, onLog, onRemove, onAvailabilityChange, wardrobeError, onRefreshWardrobe }) {
  const id = useId();
  const [date, setDate] = useState(today);
  const pending = useRef(null);
  const [error, setError] = useState('');
  const [lastId, setLastId] = useState('');
  const [lastDate, setLastDate] = useState('');
  const [notice, setNotice] = useState('');
  const history = garmentWearDates(outfits, today, garmentWears);
  const entry = garmentWears.find(event => event.id === lastId);
  const allLogged = value => !!ids.length && ids.every(piece => history.get(piece)?.includes(value));
  const log = async value => {
    if (busy || unavailable || !ids.length) return;
    setError(''); setNotice('');
    const key = JSON.stringify([value, [...ids].sort()]);
    if (pending.current?.key !== key) pending.current = { key, id: crypto.randomUUID() };
    try {
      const event = await onLog({ requestId: pending.current.id, date: value, garmentIds: ids, timezoneOffset: new Date().getTimezoneOffset() });
      setLastId(event.id); setLastDate(event.date); pending.current = null;
    } catch (error) {
      setError(uiErrorMessage(error));
      if (error.status === 409) pending.current = null;
    }
  };
  const remove = async event => {
    setError(''); setNotice('');
    try { await onRemove(event.id); setNotice('Wardrobe wear entry removed. Other records for the same day remain.'); }
    catch (error) { setError(uiErrorMessage(error)); }
  };
  const entries = garmentWears.filter(event => event.garmentIds.some(piece => ids.includes(piece))).slice().sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
  return <section className="garment-wear-controls" aria-label="Log garment wear">
    <div className="garment-wear-actions"><button type="button" className="secondary-button" disabled={busy || !!unavailable || !ids.length || allLogged(today)} onClick={() => log(today)}>{allLogged(today) ? 'Worn today' : ids.length === 1 ? 'Wore this today' : 'Wore these today'}</button><span>{ids.length} {ids.length === 1 ? 'piece' : 'pieces'} selected</span></div>
    {unavailable ? <p role="status">{unavailable} <button type="button" className="secondary-button" onClick={onRefresh} disabled={busy}>Refresh wear history</button></p> : null}
    {entry ? <>
      <p className="garment-wear-notice" role="status">Wear logged for {formatWearDate(entry.date)}. <button className="garment-wear-link" type="button" disabled={busy || !!unavailable} onClick={() => remove(entry)}>Undo</button></p>
      <WornLaundry key={entry.id} entry={entry} itemsById={itemsById} busy={busy || !!unavailable} onChange={onAvailabilityChange} wardrobeError={wardrobeError} onRefresh={onRefreshWardrobe} buttonClass="secondary-button" />
    </> : lastId && !error ? <p role="status">The entry for {formatWearDate(lastDate)} is no longer recorded.</p> : null}
    {error ? <p role="alert" className="garment-wear-error">{error}</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
    <details>
      <summary>Log another date or edit Wardrobe entries</summary>
      <form onSubmit={event => { event.preventDefault(); void log(date); }}>
        <label className="field" htmlFor={`${id}-date`}><span>Date worn</span><input id={`${id}-date`} type="date" min="1900-01-01" max={today} value={date} disabled={busy} required onChange={event => { setDate(event.target.value); pending.current = null; setError(''); }} /></label>
        <p>A piece counts once per day, including wears in saved outfits.</p>
        <button className="secondary-button" type="submit" disabled={busy || !!unavailable || !ids.length || !validWearDate(date) || date > today || allLogged(date)}>{allLogged(date) ? 'Already logged for this date' : 'Log wear'}</button>
      </form>
      {!unavailable && entries.length ? <><p>Removing a Wardrobe entry removes that entry for all its listed pieces. Outfit logs stay in outfit history.</p><ul>{entries.map(event => <li key={event.id}><div><time dateTime={event.date}>{formatWearDate(event.date)}</time><p>{event.garmentIds.map(piece => itemsById.get(piece)?.name || 'Piece no longer in wardrobe').join(' · ')}</p></div><button type="button" className="garment-wear-link" disabled={busy} aria-label={`Remove Wardrobe entry on ${formatWearDate(event.date)} for ${event.garmentIds.length} ${event.garmentIds.length === 1 ? 'piece' : 'pieces'}`} onClick={() => remove(event)}>Remove entry</button></li>)}</ul></> : null}
    </details>
  </section>;
}
