import { useId, useMemo, useState } from 'react';
import { ArrowRight } from '@phosphor-icons/react';
import { OptimizedImage } from './OptimizedImage.jsx';
import { formatWearDate, localDate } from '../shared/outfit-activity.mjs';
import { outfitShortlist } from '../shared/outfit-shortlist.mjs';

export function OutfitShortlist({ outfits, itemsById, onOpen, unavailable, onRefresh }) {
  const id = useId();
  const [occasion, setOccasion] = useState('');
  const [mode, setMode] = useState('recent');
  const today = localDate();
  const occasions = [...new Set(outfits.flatMap(outfit => outfit.occasion || []))].sort();
  if (occasion && !occasions.includes(occasion)) occasions.push(occasion);
  const result = useMemo(() => outfitShortlist(outfits, itemsById, { occasion, mode, today }), [outfits, itemsById, occasion, mode, today]);

  return <section className="outfit-shortlist" aria-labelledby={`${id}-title`}>
    <div className="outfit-shortlist-heading"><div><h2 id={`${id}-title`}>What to wear</h2><p>Up to three saved looks for your day.</p></div></div>
    <div className="outfit-shortlist-controls">
      <label className="outfit-field" htmlFor={`${id}-occasion`}><span>Shortlist occasion</span><select id={`${id}-occasion`} value={occasion} onChange={event => setOccasion(event.target.value)}><option value="">All occasions</option>{occasions.map(value => <option key={value} value={value}>{value.replaceAll('-', ' ')}</option>)}</select></label>
      <fieldset className="outfit-shortlist-modes"><legend>Choose from</legend>{[['recent', 'Not worn lately'], ['favourites', 'Favourites']].map(([value, label]) => <label key={value} className={mode === value ? 'selected' : ''}><input type="radio" name={`${id}-mode`} value={value} checked={mode === value} onChange={() => setMode(value)} />{label}</label>)}</fieldset>
    </div>
    <p className="outfit-small">{mode === 'favourites' ? 'Your favourites, with pieces worn longer ago first.' : 'Pieces worn longer ago come first, including wears in other outfits.'}</p>
    {unavailable ? <div><p className="outfit-small" role="status">{unavailable}</p>{onRefresh ? <button type="button" className="outfit-text-button" onClick={() => { void onRefresh(); }}>Refresh wardrobe</button> : null}</div> : <>
      <p className="outfit-small" role="status">{result.choices.length ? `${result.choices.length} ${result.choices.length === 1 ? 'look' : 'looks'} to choose from.` : mode === 'favourites' ? 'No available favourites for this occasion. Try another occasion or favourite a look in your collection.' : 'No available looks for this occasion. Try another occasion or save a look.'}{result.matchingCount > result.distinctCount ? ' Similar variations are grouped.' : ''}</p>
      <div className="outfit-shortlist-grid">{result.choices.map(({ outfit, pieces, lastWorn, unknownCount }) => <article key={outfit.id} className="outfit-shortlist-entry">
        <button className="outfit-shortlist-choice" type="button" onClick={() => onOpen(outfit.id)} aria-label={`Choose ${outfit.name}`}>
          <OptimizedImage src={outfit.image} alt={`${outfit.name}, ${outfit.imageKind === 'cutouts' ? 'cutout preview' : 'modelled outfit'}`} sizes="120px" />
          <span className="outfit-shortlist-copy"><span className="outfit-shortlist-name">{outfit.name}<ArrowRight size={16} aria-hidden="true" /></span>
            <span className="outfit-shortlist-meta">{outfit.favourite ? 'Favourite · ' : ''}{outfit.imageKind === 'cutouts' ? 'Cutout preview · ' : ''}{(outfit.occasion || []).map(value => value.replaceAll('-', ' ')).join(' · ')}</span>
            <span className="outfit-shortlist-reason">{lastWorn ? `Most recent piece wear: ${formatWearDate(lastWorn)}.` : 'No wears logged for these pieces.'}</span>
            {lastWorn && unknownCount ? <span className="outfit-shortlist-meta">{unknownCount} of {pieces.length} pieces {unknownCount === 1 ? 'has' : 'have'} no wears logged.</span> : null}
          </span>
        </button>
        <details className="outfit-shortlist-history"><summary>Piece history</summary><ul>{pieces.map(piece => <li key={piece.id}><strong>{piece.name}</strong><span>{piece.count ? `${piece.count} ${piece.count === 1 ? 'day' : 'days'} logged · Last worn ${formatWearDate(piece.lastWorn)}` : 'No wears logged'}</span></li>)}</ul></details>
      </article>)}</div>
      <details className="outfit-shortlist-history outfit-shortlist-about"><summary>How choices are made</summary><p className="outfit-small">We compare the latest logged wear of any piece in each look, across your whole saved collection. Looks without history follow those with recorded wears; missing history does not mean never worn. A piece counts once per logged day. Similar variations share a choice when their main pieces match.{result.unavailableCount ? ' Looks with unavailable pieces or images are left out.' : ''}</p></details>
    </>}
  </section>;
}
