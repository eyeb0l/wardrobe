import { useId, useMemo, useState } from 'react';
import { ArrowRight } from '@phosphor-icons/react';
import { OptimizedImage } from './OptimizedImage.jsx';
import { formatWearDate, localDate } from '../shared/outfit-activity.mjs';
import { outfitShortlist } from '../shared/outfit-shortlist.mjs';
import { WEATHER_DAY_LABELS, WeatherFitLine } from './outfit-weather.jsx';

// Check only the current candidates, not the entire wardrobe. Failed sources
// remove every affected look; ranking then fills the slot with the next choice.
function ShortlistEntry({ outfit, pieces, lastWorn, unknownCount, weatherFit, itemsById, onOpen, onImageError }) {
  const [loaded, setLoaded] = useState(() => new Set());
  const sources = [...new Set([outfit.image, ...pieces.map(piece => itemsById.get(piece.id).image)])];
  const ready = sources.every(source => loaded.has(source));
  const markLoaded = source => setLoaded(current => current.has(source) ? current : new Set([...current, source]));
  return <article className="outfit-shortlist-entry">
        <button className="outfit-shortlist-choice" type="button" disabled={!ready} aria-busy={!ready} onClick={() => onOpen(outfit.id)} aria-label={`Choose ${outfit.name}`}>
          <OptimizedImage src={outfit.image} alt={`${outfit.name}, ${outfit.imageKind === 'cutouts' ? 'cutout preview' : 'modelled outfit'}`} sizes="120px" loading="eager" onLoad={() => markLoaded(outfit.image)} onError={() => onImageError(outfit.image)} />
          <span className="outfit-shortlist-copy"><span className="outfit-shortlist-name">{outfit.name}<ArrowRight size={16} aria-hidden="true" /></span>
            <span className="outfit-shortlist-meta">{outfit.favourite ? 'Favourite · ' : ''}{outfit.imageKind === 'cutouts' ? 'Cutout preview · ' : ''}{(outfit.occasion || []).map(value => value.replaceAll('-', ' ')).join(' · ')}</span>
            <span className="outfit-shortlist-reason">{lastWorn ? `Most recent piece wear: ${formatWearDate(lastWorn)}.` : 'No wears logged for these pieces.'}</span>
            {weatherFit ? <WeatherFitLine fit={weatherFit} compact /> : null}
            {lastWorn && unknownCount ? <span className="outfit-shortlist-meta">{unknownCount} of {pieces.length} pieces {unknownCount === 1 ? 'has' : 'have'} no wears logged.</span> : null}
            {!ready ? <span className="outfit-shortlist-meta">Checking images…</span> : null}
          </span>
        </button>
        <span hidden aria-hidden="true">{sources.filter(source => source !== outfit.image).map(source => <img key={source} src={source} alt="" loading="eager" onLoad={() => markLoaded(source)} onError={() => onImageError(source)} />)}</span>
        <details className="outfit-shortlist-history"><summary>Piece history</summary><ul>{pieces.map(piece => <li key={piece.id}><strong>{piece.name}</strong><span>{piece.count ? `${piece.count} ${piece.count === 1 ? 'day' : 'days'} logged · Last worn ${formatWearDate(piece.lastWorn)}` : 'No wears logged'}</span></li>)}</ul></details>
      </article>;
}

// With today's look already planned, the shortlist folds to one line: the plan answers the question.
export function OutfitShortlist({ garmentWears, outfits, itemsById, onOpen, unavailable, onRefresh, weather, onAddWeather, plannedToday = null }) {
  const id = useId();
  const [showIdeas, setShowIdeas] = useState(false);
  const [showRules, setShowRules] = useState(false);
  const expanded = !plannedToday || showIdeas;
  const [occasion, setOccasion] = useState('');
  const [mode, setMode] = useState('recent');
  const [weatherDayIndex, setWeatherDayIndex] = useState(0);
  const weatherDay = weather?.ready && weatherDayIndex >= 0 ? weather.days[weatherDayIndex] : null;
  const weatherDayLabel = weatherDayIndex === 1 ? 'tomorrow’s' : 'today’s';
  const missingWeather = outfits.filter(outfit => !outfit.weather).length;
  const [failedImages, setFailedImages] = useState(() => new Set());
  const [imageAttempt, setImageAttempt] = useState(0);
  const currentFailures = useMemo(() => new Set([...outfits.map(outfit => outfit.image), ...[...itemsById.values()].map(item => item.image)].filter(source => failedImages.has(source))), [outfits, itemsById, failedImages]);
  const today = localDate();
  const occasions = [...new Set(outfits.flatMap(outfit => outfit.occasion || []))].sort();
  if (occasion && !occasions.includes(occasion)) occasions.push(occasion);
  const result = useMemo(() => outfitShortlist(outfits, itemsById, { occasion, mode, today, garmentWears, failedImages: currentFailures, weatherDay }), [outfits, garmentWears, itemsById, occasion, mode, today, currentFailures, weatherDay]);

  const controls = <div className="outfit-shortlist-controls">
      <label className="outfit-field" htmlFor={`${id}-occasion`}><span>Shortlist occasion</span><select id={`${id}-occasion`} value={occasion} onChange={event => setOccasion(event.target.value)}><option value="">All occasions</option>{occasions.map(value => <option key={value} value={value}>{value.replaceAll('-', ' ')}</option>)}</select></label>
      <fieldset className="outfit-shortlist-modes"><legend>Choose from</legend>{[['recent', 'Not worn lately'], ['favourites', 'Favourites']].map(([value, label]) => <label key={value} className={mode === value ? 'selected' : ''}><input type="radio" name={`${id}-mode`} value={value} checked={mode === value} onChange={() => setMode(value)} />{label}</label>)}</fieldset>
      {weather?.ready ? <fieldset className="outfit-shortlist-modes"><legend>Match weather</legend>{[[0, WEATHER_DAY_LABELS[0]], [1, WEATHER_DAY_LABELS[1]], [-1, 'Off']].map(([value, label]) => <label key={value} className={weatherDayIndex === value ? 'selected' : ''}><input type="radio" name={`${id}-weather`} value={value} checked={weatherDayIndex === value} disabled={value >= 0 && !weather.days[value]} onChange={() => setWeatherDayIndex(value)} />{label}</label>)}</fieldset> : null}
    </div>;
  const ordering = !result.choices.length ? '' : weatherDay ? `${mode === 'favourites' ? 'Favourites' : 'Looks'} that suit ${weatherDayLabel} weather come first, then pieces worn longest ago.` : mode === 'favourites' ? 'Your favourites, with pieces worn longest ago first.' : 'Pieces worn longest ago come first.';
  const empty = result.laundryCount ? `No ready ${mode === 'favourites' ? 'favourites' : 'looks'} for this occasion. Mark pieces ready when they are available again.` : mode === 'favourites' ? 'No available favourites for this occasion. Try another occasion or favourite a look in your collection.' : 'No available looks for this occasion. Try another occasion or save a look.';

  return <section className={`outfit-shortlist${expanded ? '' : ' collapsed'}`} aria-labelledby={`${id}-title`}>
    <div className="outfit-shortlist-top">
    <div className="outfit-shortlist-heading"><h2 id={`${id}-title`}>What to wear</h2>{plannedToday ? <p><span>{plannedToday.name} is planned for today.</span><button type="button" className="outfit-text-button" aria-expanded={expanded} onClick={() => setShowIdeas(value => !value)}>{expanded ? 'Hide other ideas' : 'Other ideas for today'}</button></p> : null}</div>
    {expanded ? controls : null}
    </div>
    {!expanded ? null : unavailable ? <div className="outfit-shortlist-notes"><p className="outfit-small" role="status">{unavailable}</p>{onRefresh ? <button type="button" className="outfit-text-button" onClick={() => { void onRefresh(); }}>Refresh wardrobe</button> : null}</div> : <>
      <div className="outfit-shortlist-notes">
      <p className="outfit-small outfit-shortlist-status">
        <span role="status">{result.choices.length ? `${result.choices.length} ${result.choices.length === 1 ? 'look' : 'looks'} to choose from.` : empty}{result.matchingCount > result.distinctCount ? ' Similar variations are grouped.' : ''}{ordering ? ` ${ordering}` : ''}</span>
        {result.weatherCounts.unsuitable ? <span role="status">{result.weatherCounts.unsuitable} {result.weatherCounts.unsuitable === 1 ? 'look is' : 'looks are'} left out because {result.weatherCounts.unsuitable === 1 ? 'it doesn’t' : 'they don’t'} suit {weatherDayLabel} weather. <button type="button" className="outfit-text-button" onClick={() => setWeatherDayIndex(-1)}>Include {result.weatherCounts.unsuitable === 1 ? 'it' : 'them'}</button></span> : null}
        {weatherDay && missingWeather ? <span role="status">{missingWeather} saved {missingWeather === 1 ? 'look has' : 'looks have'} no weather details, so {missingWeather === 1 ? 'it follows' : 'they follow'} looks that suit the forecast. {onAddWeather ? <button type="button" className="outfit-text-button" onClick={onAddWeather}>Add weather details</button> : null}</span> : null}
        {result.laundryCount ? <span role="status">{result.laundryCount} {result.laundryCount === 1 ? 'look is' : 'looks are'} left out because pieces are in laundry.</span> : null}
        <button type="button" className="outfit-text-button" aria-expanded={showRules} aria-controls={`${id}-rules`} onClick={() => setShowRules(value => !value)}>How choices are made</button>
      </p>
      {showRules ? <p id={`${id}-rules`} className="outfit-small outfit-shortlist-about">We compare the latest logged wear of any piece in each look, across Wardrobe entries, saved looks and variations. Looks without history follow those with recorded wears; missing history does not mean never worn. A piece counts once per logged day. Similar variations share a choice when their main pieces match. With Match weather on, each look’s comfortable feels-like range and rain suitability are compared with the forecast: looks that suit the day come first, workable ones next, then looks without weather details, and clearly unsuitable looks are left out.{result.unavailableCount ? ' Looks with unavailable pieces or images are left out.' : ''}</p> : null}
      </div>
      <div className="outfit-shortlist-grid">{result.choices.map(row => <ShortlistEntry key={JSON.stringify([row.outfit.id, row.outfit.image, row.pieces.map(piece => itemsById.get(piece.id).image), imageAttempt])} {...row} itemsById={itemsById} onOpen={onOpen} onImageError={source => setFailedImages(current => current.has(source) ? current : new Set([...current, source]))} />)}</div>
      {currentFailures.size ? <p className="outfit-small" role="status">Some images could not load. Those looks are left out. <button className="outfit-text-button" type="button" onClick={() => { setFailedImages(new Set()); setImageAttempt(value => value + 1); }}>Retry images</button></p> : null}
    </>}
  </section>;
}
