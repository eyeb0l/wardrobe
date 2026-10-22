import { useEffect, useId, useState } from 'react';
import { OptimizedImage } from './OptimizedImage.jsx';
import { formatWearDate } from '../shared/outfit-activity.mjs';
import { planningDays, planAvailability } from '../shared/outfit-plans.mjs';

export function usePlanningDays() {
  const [days, setDays] = useState(planningDays);
  useEffect(() => {
    const update = () => setDays(current => {
      const next = planningDays();
      return current[0] === next[0] ? current : next;
    });
    const timer = window.setInterval(update, 30_000);
    window.addEventListener('focus', update);
    document.addEventListener('visibilitychange', update);
    return () => { clearInterval(timer); window.removeEventListener('focus', update); document.removeEventListener('visibilitychange', update); };
  }, []);
  return days;
}

function Availability({ outfit, itemsById, unavailable }) {
  const { missing, laundry } = planAvailability(outfit, itemsById);
  return <p className={`outfit-small ${missing.length || laundry.length ? 'outfit-plan-warning' : ''}`} role="status">{unavailable || (missing.length ? `Unavailable: ${missing.join(' · ')}. Choose another look or change a piece.` : laundry.length ? `In laundry: ${laundry.join(' · ')}. Mark these ready when they are available.` : 'All pieces are ready.')}</p>;
}

function Pieces({ outfit, itemsById }) {
  const [failed, setFailed] = useState(new Set());
  const [attempt, setAttempt] = useState(0);
  return <><div className="outfit-plan-pieces">{outfit.garmentIds.map(id => {
    const item = itemsById.get(id);
    return <div key={id}>{item?.image && !failed.has(item.image) ? <OptimizedImage key={`${item.image}-${attempt}`} src={item.image} alt={item.name} sizes="100px" loading="eager" onError={() => setFailed(current => new Set([...current, item.image]))} /> : <span className="outfit-small">Image unavailable</span>}<span>{item?.name || 'Unavailable piece'}</span></div>;
  })}</div>{failed.size ? <p className="outfit-small">Some cutouts could not load. <button type="button" className="outfit-text-button" onClick={() => { setFailed(new Set()); setAttempt(value => value + 1); }}>Retry cutouts</button></p> : null}</>;
}

export function OutfitPlans({ plans, outfits, itemsById, days, busy, unavailable, onRefresh, onChoose, onClear, onOpen, onVariation, onWear }) {
  const id = useId();
  const byId = new Map(outfits.map(outfit => [outfit.id, outfit]));
  const past = plans.filter(plan => plan.date < days[0] && !byId.get(plan.outfitId)?.wearHistory?.some(entry => entry.date === plan.date));
  const card = (date, pastPlan = false) => {
    const plan = plans.find(plan => plan.date === date), outfit = byId.get(plan?.outfitId);
    const wore = outfit?.wearHistory?.some(entry => entry.date === date);
    return <article className="outfit-plan-card" key={date} aria-label={pastPlan ? `Plan for ${formatWearDate(date)}` : date === days[0] ? 'Today’s plan' : 'Tomorrow’s plan'}>
      <p className="outfit-count">{pastPlan ? formatWearDate(date) : date === days[0] ? 'Today' : 'Tomorrow'}</p>
      {plan ? <>
        <h3>{outfit?.name || 'Saved look unavailable'}</h3>
        {outfit ? <><p className="outfit-small">{outfit.occasion.map(value => value.replaceAll('-', ' ')).join(' · ')}</p><Pieces key={outfit.id} outfit={outfit} itemsById={itemsById} /></> : null}
        <Availability outfit={outfit} itemsById={itemsById} unavailable={unavailable} />
        <p className="outfit-small">{wore ? 'Wear logged for this date.' : pastPlan ? 'Past plan · No wear confirmed.' : 'Planned only · No wear confirmed.'}</p>
        <div className="outfit-plan-actions">
          {outfit && date <= days[0] ? <button type="button" className="outfit-primary" disabled={busy || !!unavailable || wore} onClick={() => onWear(outfit, date)}>{wore ? 'Wear confirmed' : 'Wore this'}</button> : null}
          {outfit ? <button type="button" className="outfit-text-button" onClick={() => onOpen(outfit.id)}>View look</button> : null}
          {!pastPlan ? <button type="button" className="outfit-secondary" disabled={busy || !!unavailable} onClick={() => onChoose(date)}>Change look</button> : null}
          {outfit && !pastPlan ? <button type="button" className="outfit-text-button" disabled={busy || !!unavailable} onClick={() => onVariation(outfit, date)}>Change one piece</button> : null}
          {outfit ? <button type="button" className="outfit-text-button" disabled={busy || !!unavailable} onClick={() => onChoose(date === days[1] ? days[0] : days[1], outfit.id, date)}>{date === days[1] ? 'Move to today' : 'Move to tomorrow'}</button> : null}
          <button type="button" className="outfit-text-button" disabled={busy || !!unavailable} onClick={() => onClear(date)}>Clear plan</button>
        </div>
      </> : <><h3>Leave one less decision for later.</h3><p className="outfit-small">Choose a saved look. You can change it any time.</p><button type="button" className="outfit-secondary" disabled={busy || !!unavailable || !outfits.length} onClick={() => onChoose(date)}>Choose look</button></>}
    </article>;
  };
  return <section className="outfit-plans" aria-labelledby={`${id}-title`}>
    <div className="outfit-shortlist-heading"><div><h2 id={`${id}-title`}>Your plans</h2><p>One saved look for each day. Confirm after you wear it.</p></div></div>
    {unavailable ? <p className="outfit-small" role="status">{unavailable} <button type="button" className="outfit-text-button" onClick={onRefresh}>Refresh plans and wardrobe</button></p> : null}
    <div className="outfit-plan-grid">{days.map(date => card(date))}</div>
    {past.length ? <details className="outfit-shortlist-history"><summary>Unconfirmed past plans ({past.length})</summary><div className="outfit-plan-grid">{past.map(plan => card(plan.date, true))}</div></details> : null}
  </section>;
}

export function PlanChooser({ date, fromDate, initialId, plans, outfits, itemsById, days, busy, unavailable, error, onRefresh, onSave }) {
  const id = useId();
  const [outfitId, setOutfitId] = useState(initialId || plans.find(plan => plan.date === date)?.outfitId || '');
  const outfit = outfits.find(item => item.id === outfitId);
  const current = outfits.find(item => item.id === plans.find(plan => plan.date === date)?.outfitId);
  const invalid = !days.includes(date);
  return <form className="outfit-plan-form" onSubmit={event => { event.preventDefault(); void onSave({ date, outfitId, ...(fromDate ? { fromDate } : {}) }); }}>
    <p className="outfit-small">{formatWearDate(date)} · Planning does not log a wear or reserve garments.</p>
    <label className="outfit-field" htmlFor={`${id}-look`}><span>Saved look</span><select id={`${id}-look`} value={outfitId} disabled={busy || !!fromDate} onChange={event => setOutfitId(event.target.value)}><option value="">Choose a look</option>{outfits.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    {outfit ? <><Pieces key={outfit.id} outfit={outfit} itemsById={itemsById} /><Availability outfit={outfit} itemsById={itemsById} unavailable={unavailable} /></> : null}
    {current && (fromDate || current.id !== outfitId) ? <p className="outfit-small">Saving will replace {current.name} in this day’s plan.</p> : null}
    {fromDate ? <p className="outfit-small">This moves the plan from {formatWearDate(fromDate)}. Any logged wear stays on its original date.</p> : null}
    {invalid ? <p role="alert" className="outfit-error">The day has changed. Close this dialog and choose today or tomorrow again.</p> : null}
    {unavailable ? <p role="status" className="outfit-small">{unavailable} <button type="button" className="outfit-text-button" onClick={onRefresh}>Refresh plans and wardrobe</button></p> : null}
    {error ? <p role="alert" className="outfit-error">{error}</p> : null}
    <button type="submit" className="outfit-primary" disabled={busy || invalid || !!unavailable || !outfit || !!planAvailability(outfit, itemsById).missing.length}>{busy ? 'Saving…' : fromDate ? 'Move plan' : 'Save plan'}</button>
  </form>;
}
