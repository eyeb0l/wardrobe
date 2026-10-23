import { useId, useMemo, useState } from 'react';
import { OptimizedImage } from './OptimizedImage.jsx';
import { garmentWearDates, readySavedLooks } from '../shared/outfit-shortlist.mjs';
import { wardrobeRediscovery } from '../shared/wardrobe-rediscovery.mjs';
import { formatWearDate } from '../shared/outfit-activity.mjs';
import './wardrobe-rediscovery.css';

function HistorySummary({ count, lastWorn }) {
  return <>{count ? `${count} ${count === 1 ? 'day' : 'days'} logged · Last worn ${formatWearDate(lastWorn)}` : 'No wears logged'}</>;
}

function PieceChoice({ item, count, lastWorn, onOpen, onImageError }) {
  const [loaded, setLoaded] = useState(false);
  return <button className="rediscovery-piece" type="button" disabled={!loaded} aria-label={`Wear ${item.name}`} onClick={() => onOpen(item.id)}>
    <OptimizedImage src={item.image} alt="" sizes="100px" loading="eager" onLoad={() => setLoaded(true)} onError={() => onImageError(item.image)} />
    <span><strong>{item.name}</strong><span><HistorySummary count={count} lastWorn={lastWorn} /></span><span>{loaded ? 'Find ready looks' : 'Checking cutout…'}</span></span>
  </button>;
}

export function WardrobeRediscovery({ items, outfits, garmentWears, today, unavailable, onRefresh, onOpen }) {
  const id = useId();
  const [failed, setFailed] = useState(new Set());
  const [attempt, setAttempt] = useState(0);
  const choices = useMemo(() => wardrobeRediscovery(items, outfits, { today, garmentWears, failedImages: failed }).slice(0, 3), [items, outfits, garmentWears, today, failed]);
  const hasFailures = items.some(item => failed.has(item.image));
  return <section className="wardrobe-rediscovery" aria-labelledby={`${id}-title`}>
    <h2 id={`${id}-title`}>Wear a piece again</h2>
    <p>Ready pieces, with the oldest logged wear first. Start with a piece and find a saved look.</p>
    {unavailable ? <p role="status">{unavailable} <button type="button" className="secondary-button" onClick={onRefresh}>Refresh rediscovery</button></p> : <>
      <div className="rediscovery-grid">{choices.map(row => <PieceChoice key={`${row.item.id}-${row.item.image}-${attempt}`} {...row} onOpen={onOpen} onImageError={source => setFailed(current => new Set([...current, source]))} />)}</div>
      {!choices.length ? <p role="status">No Ready pieces with available cutouts in this category.</p> : null}
      <p className="rediscovery-note">Based on Wardrobe entries and wears logged in saved looks and variations. No history does not mean never worn.</p>
      {hasFailures ? <p role="status">Some cutouts could not load and are left out. <button type="button" className="secondary-button" onClick={() => { setFailed(new Set()); setAttempt(value => value + 1); }}>Retry cutouts</button></p> : null}
    </>}
  </section>;
}

function ReadyLook({ outfit, itemsById, days, disabled, onOpen, onPlan, onImageError }) {
  const [loaded, setLoaded] = useState(new Set());
  const sources = [...new Set([outfit.image, ...outfit.garmentIds.map(id => itemsById.get(id).image)])];
  const ready = sources.every(source => loaded.has(source));
  const mark = source => setLoaded(current => new Set([...current, source]));
  return <article className="rediscovery-look" aria-label={outfit.name}>
    <OptimizedImage src={outfit.image} alt={`${outfit.name}, saved look`} sizes="120px" loading="eager" onLoad={() => mark(outfit.image)} onError={() => onImageError(outfit.image)} />
    <div><h4>{outfit.name}</h4><p>{outfit.occasion.map(value => value.replaceAll('-', ' ')).join(' · ')}</p><p>{ready ? 'All pieces are Ready.' : 'Checking images…'}</p>
      <div className="rediscovery-actions"><button className="secondary-button" type="button" disabled={disabled || !ready} onClick={() => onOpen(outfit.id)}>View look</button>{days.map((date, index) => <button key={date} className="secondary-button" type="button" disabled={disabled || !ready} onClick={() => onPlan(outfit.id, date)}>Plan for {index ? 'tomorrow' : 'today'}</button>)}</div>
    </div>
    <span hidden aria-hidden="true">{sources.filter(source => source !== outfit.image).map(source => <img key={source} src={source} alt="" onLoad={() => mark(source)} onError={() => onImageError(source)} />)}</span>
  </article>;
}

export function GarmentRediscovery({ item, itemsById, outfits, garmentWears, days, unavailable, disabled, onRefresh, onOpen, onPlan }) {
  const id = useId();
  const [occasion, setOccasion] = useState('');
  const [failed, setFailed] = useState(new Set());
  const [attempt, setAttempt] = useState(0);
  const dates = useMemo(() => garmentWearDates(outfits, days[0], garmentWears).get(item.id) || [], [outfits, garmentWears, days, item.id]);
  const matching = outfits.filter(outfit => outfit.status === 'accepted' && outfit.garmentIds.includes(item.id));
  const occasions = [...new Set(matching.flatMap(outfit => outfit.occasion))].sort();
  if (occasion && !occasions.includes(occasion)) occasions.push(occasion);
  const ready = readySavedLooks(outfits, itemsById, { garmentId: item.id, occasion, failedImages: failed });
  const matchingCount = matching.filter(outfit => !occasion || outfit.occasion.includes(occasion)).length;
  const hasFailures = [...matching.map(outfit => outfit.image), ...[...itemsById.values()].map(item => item.image)].some(source => failed.has(source));
  return <section className="garment-rediscovery" aria-label="Wear history and ready looks">
    <h3>Wear history</h3>
    {unavailable ? <p role="status">{unavailable} <button className="secondary-button" type="button" onClick={onRefresh}>Refresh rediscovery</button></p> : <>
      <p><HistorySummary count={dates.length} lastWorn={dates[0]} /></p>
      {dates.length ? <details><summary>Logged dates</summary><ul className="garment-wear-dates">{dates.map(date => <li key={date}><time dateTime={date}>{formatWearDate(date)}</time></li>)}</ul></details> : null}
      <p>Across Wardrobe entries, saved looks and variations; each calendar day counts once. No wears logged does not mean never worn.</p>
      <h3>Ready saved looks with this piece</h3>
      <label className="field" htmlFor={`${id}-occasion`}><span>Look occasion</span><select id={`${id}-occasion`} value={occasion} onChange={event => setOccasion(event.target.value)}><option value="">All occasions</option>{occasions.map(value => <option key={value} value={value}>{value.replaceAll('-', ' ')}</option>)}</select></label>
      {disabled ? <p role="status">Save or discard your garment changes before choosing a look.</p> : null}
      <p role="status">{ready.length} ready {ready.length === 1 ? 'look' : 'looks'}{matchingCount > ready.length ? ` · ${matchingCount - ready.length} left out for laundry, unavailable pieces or images` : ''}.</p>
      {!ready.length ? <p>{!matching.length ? 'No saved looks contain this piece yet. Save a look with this piece to find it here.' : 'Try another occasion or mark laundry pieces Ready when they are available.'}</p> : null}
      <div className="rediscovery-looks">{ready.map(outfit => <ReadyLook key={JSON.stringify([outfit.id, outfit.image, outfit.garmentIds.map(id => itemsById.get(id).image), attempt])} outfit={outfit} itemsById={itemsById} days={days} disabled={disabled} onOpen={onOpen} onPlan={onPlan} onImageError={source => setFailed(current => new Set([...current, source]))} />)}</div>
      {hasFailures ? <p role="status">Some images could not load. Those looks are left out. <button className="secondary-button" type="button" onClick={() => { setFailed(new Set()); setAttempt(value => value + 1); }}>Retry look images</button></p> : null}
    </>}
  </section>;
}
