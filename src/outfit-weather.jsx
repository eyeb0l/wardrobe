import { useEffect, useId, useRef, useState } from 'react';
import { Cloud, CloudFog, CloudLightning, CloudRain, CloudSnow, CloudSun, MapPin, Sun } from '@phosphor-icons/react';
import { RAIN_LABELS, RAIN_SUITABILITY, SOURCE_LABELS, WEATHER_NOTE_LENGTH, WEATHER_TEMPERATURE, normalizeWeather, weatherCondition, weatherFit } from '../shared/outfit-weather.mjs';
import { currentPosition, searchPlaces } from './weather.mjs';
import { uiErrorMessage } from './ui-error.mjs';
import './outfit-weather.css';

const ICONS = { clear: Sun, partly: CloudSun, cloud: Cloud, fog: CloudFog, rain: CloudRain, snow: CloudSnow, storm: CloudLightning };
export const WEATHER_DAY_LABELS = ['Today', 'Tomorrow'];
export const WEATHER_BATCH = 6;

async function post(path, body, signal) {
  const response = await fetch(path, { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(uiErrorMessage(result.error, 'The request could not be completed. Please try again.')), { status: response.status });
  return result;
}

function WeatherDay({ label, day, loading }) {
  if (!day) return <div className="outfit-weather-day"><span className="outfit-weather-day-name">{label}</span><span className="outfit-weather-meta">{loading ? 'Loading forecast…' : 'Forecast unavailable'}</span></div>;
  const condition = weatherCondition(day.code);
  const Icon = ICONS[condition.kind];
  const rain = day.rainChance === null ? '' : ` · ${day.rainChance}% rain`;
  return <div className="outfit-weather-day" role="group" aria-label={`${label}: ${condition.label}, high ${day.high}°, low ${day.low}°${day.rainChance === null ? '' : `, ${day.rainChance}% chance of rain`}, feels like ${day.feelsLow}° to ${day.feelsHigh}°`}>
    <span className="outfit-weather-day-name" aria-hidden="true">{label}</span>
    <Icon size={22} aria-hidden="true" />
    <span className="outfit-weather-temps" aria-hidden="true"><strong>{day.high}°</strong> / {day.low}°</span>
    <span className="outfit-weather-meta" aria-hidden="true">{condition.label}{rain} · feels {day.feelsLow}–{day.feelsHigh}°</span>
  </div>;
}

// Compact forecast beside "Your plans". Nothing is fetched until a location is chosen.
export function WeatherPanel({ weather, onChangeLocation, disabled = false }) {
  if (!weather.location) return <aside className="outfit-weather outfit-weather-empty" aria-label="Weather">
    <div><p className="outfit-weather-title">Weather</p>
    <p className="outfit-weather-meta">Add a location to match your looks to the forecast.</p></div>
    <button type="button" className="outfit-secondary" onClick={onChangeLocation} disabled={disabled}><MapPin size={16} aria-hidden="true" />Add location</button>
  </aside>;
  return <aside className="outfit-weather" aria-label="Weather" aria-busy={weather.loading}>
    <div className="outfit-weather-header">
      <p className="outfit-weather-title"><MapPin size={14} aria-hidden="true" /><span>{weather.location.name}</span></p>
      <button type="button" className="outfit-text-button" onClick={onChangeLocation} disabled={disabled} aria-label={`Change weather location, currently ${weather.location.name}`}>Change</button>
      <p className="outfit-weather-credit">Forecast by <a href="https://open-meteo.com/" target="_blank" rel="noreferrer">Open-Meteo</a></p>
    </div>
    {weather.days.map((day, index) => <WeatherDay key={WEATHER_DAY_LABELS[index]} label={WEATHER_DAY_LABELS[index]} day={day} loading={weather.loading} />)}
    {weather.error ? <p className="outfit-weather-meta outfit-plan-warning outfit-weather-error" role="status">{weather.error} <button type="button" className="outfit-text-button" onClick={() => { void weather.refresh(); }}>Retry forecast</button></p> : null}
  </aside>;
}

export function WeatherLocationForm({ weather, onDone }) {
  const id = useId();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const controller = useRef(null);
  const closed = useRef(false);
  useEffect(() => {
    closed.current = false;
    return () => { closed.current = true; controller.current?.abort(); };
  }, []);
  const choose = location => { closed.current = true; weather.setLocation(location); onDone(); };
  // Geolocation cannot be aborted, so a result arriving after the form closed
  // (including after Stop using weather) is ignored.
  const locate = async () => {
    controller.current?.abort();
    setBusy('locate'); setError('');
    try {
      const location = await currentPosition();
      if (!closed.current) choose(location);
    } catch (failure) { if (!closed.current) { setError(failure.message); setBusy(''); } }
  };
  const search = async event => {
    event.preventDefault();
    if (!query.trim()) return;
    controller.current?.abort();
    const active = controller.current = new AbortController();
    setBusy('search'); setError('');
    try {
      const places = await searchPlaces(query, active.signal);
      if (!active.signal.aborted) setResults(places);
    } catch (failure) { if (!active.signal.aborted) setError(failure.message); }
    finally { if (!active.signal.aborted) setBusy(''); }
  };
  return <div className="outfit-weather-form">
    <p className="outfit-form-intro">Forecasts come from Open-Meteo, a free weather service. Your location stays on this device and is sent to Open-Meteo, rounded to about 1 km, only to fetch the forecast.</p>
    <button type="button" className="outfit-secondary" onClick={locate} disabled={!!busy}><MapPin size={16} aria-hidden="true" />{busy === 'locate' ? 'Finding your location…' : 'Use my location'}</button>
    <form className="outfit-weather-search" role="search" onSubmit={search}>
      <label className="outfit-field" htmlFor={`${id}-place`}><span>Or search for a place</span><input id={`${id}-place`} type="search" value={query} maxLength={100} autoComplete="address-level2" placeholder="Town or city" onChange={event => setQuery(event.target.value)} disabled={busy === 'locate'} /></label>
      <button type="submit" className="outfit-primary" disabled={!!busy || !query.trim()}>{busy === 'search' ? 'Searching…' : 'Search'}</button>
    </form>
    {error ? <p role="alert" className="outfit-error">{error}</p> : null}
    {results ? results.length ? <ul className="outfit-weather-places" aria-label="Matching places">{results.map(place => <li key={`${place.latitude},${place.longitude},${place.name}`}>
      <button type="button" className="outfit-secondary" onClick={() => choose(place)}><strong>{place.name}</strong>{place.detail ? <span>{place.detail}</span> : null}</button>
    </li>)}</ul> : <p className="outfit-small" role="status">No places found. Try a nearby town or check the spelling.</p> : null}
    {weather.location ? <p className="outfit-small">Currently {weather.location.name}{weather.location.detail ? `, ${weather.location.detail}` : ''}. <button type="button" className="outfit-text-button" onClick={() => choose(null)}>Stop using weather</button></p> : null}
  </div>;
}

export function WeatherFitLine({ fit, label, compact = false }) {
  if (!fit) return null;
  if (fit.level === 'unknown') return <p className="outfit-weather-fit unknown">{label ? `${label}: ` : ''}No weather details for this look yet.</p>;
  return <p className={`outfit-weather-fit ${fit.level}`}><strong>{label ? `${label}: ` : ''}{fit.summary}.</strong>{compact ? ` ${fit.reasons[0]}` : ` ${fit.reasons.join(' ')}`}</p>;
}

function WeatherForm({ outfit, busy, onSave, onCancel }) {
  const id = useId();
  const current = normalizeWeather(outfit.weather);
  const [values, setValues] = useState(() => ({ minTempC: String(current?.minTempC ?? 10), maxTempC: String(current?.maxTempC ?? 20), rain: current?.rain ?? 'light', note: current?.note ?? '' }));
  const parsed = { minTempC: Number(values.minTempC), maxTempC: Number(values.maxTempC), rain: values.rain, note: values.note.replace(/[\r\n]+/g, ' ') };
  const valid = values.minTempC.trim() !== '' && values.maxTempC.trim() !== '' && normalizeWeather(parsed);
  const set = key => event => setValues(value => ({ ...value, [key]: event.target.value }));
  return <form className="outfit-weather-edit" onSubmit={event => { event.preventDefault(); if (valid) onSave(valid); }}>
    <div className="outfit-weather-edit-row">
      <label className="outfit-field" htmlFor={`${id}-min`}><span>Coolest (°C)</span><input id={`${id}-min`} type="number" inputMode="numeric" step="1" min={WEATHER_TEMPERATURE.min} max={WEATHER_TEMPERATURE.max} value={values.minTempC} onChange={set('minTempC')} disabled={busy} required /></label>
      <label className="outfit-field" htmlFor={`${id}-max`}><span>Warmest (°C)</span><input id={`${id}-max`} type="number" inputMode="numeric" step="1" min={WEATHER_TEMPERATURE.min} max={WEATHER_TEMPERATURE.max} value={values.maxTempC} onChange={set('maxTempC')} disabled={busy} required /></label>
    </div>
    <label className="outfit-field" htmlFor={`${id}-rain`}><span>In rain</span><select id={`${id}-rain`} value={values.rain} onChange={set('rain')} disabled={busy}>{RAIN_SUITABILITY.map(value => <option key={value} value={value}>{RAIN_LABELS[value]}</option>)}</select></label>
    <label className="outfit-field" htmlFor={`${id}-note`}><span>Note <em>optional</em></span><input id={`${id}-note`} type="text" maxLength={WEATHER_NOTE_LENGTH} value={values.note} onChange={set('note')} disabled={busy} placeholder="Wool coat and closed boots" /></label>
    {!valid ? <p className="outfit-small" role="status">Use whole degrees from {WEATHER_TEMPERATURE.min} to {WEATHER_TEMPERATURE.max} °C, with the coolest below the warmest.</p> : <p className="outfit-small">Feels-like temperatures you would be comfortable in, wearing exactly these pieces.</p>}
    <div className="outfit-weather-actions">
      <button type="submit" className="outfit-primary" disabled={busy || !valid}>{busy ? 'Saving…' : 'Save weather details'}</button>
      <button type="button" className="outfit-text-button" onClick={onCancel} disabled={busy}>Cancel</button>
    </div>
  </form>;
}

// Weather section in a saved look's details: view, edit, clear or estimate.
export function OutfitWeather({ outfit, weather, hasApiKey, disabled = false, onSaved, onConflict }) {
  // Holds the revision the editor started from, so a refresh while editing
  // still conflicts instead of overwriting another device's change.
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const range = normalizeWeather(outfit.weather);
  const run = async (key, action) => {
    setBusy(key); setError('');
    try { await action(); }
    catch (failure) { setError(uiErrorMessage(failure)); if (failure.status === 409) { setEditing(null); await onConflict?.(); } }
    finally { setBusy(''); }
  };
  const save = value => run('save', async () => {
    const saved = await post(`/api/outfits/${encodeURIComponent(outfit.id)}/weather`, { weather: value, expectedUpdatedAt: editing.expectedUpdatedAt });
    onSaved([saved]); setEditing(null);
  });
  const estimate = () => run('estimate', async () => {
    const result = await post('/api/outfits/weather/estimate', { outfitIds: [outfit.id] });
    if (result.outfits.length) onSaved(result.outfits);
    else { setError('This look changed or already has weather details. Showing the latest.'); await onConflict?.(); }
  });
  const locked = disabled || !!busy;
  return <section className="outfit-weather-details" aria-label="Weather suitability">
    <h3>Weather</h3>
    {editing ? <WeatherForm outfit={outfit} busy={busy === 'save'} onSave={save} onCancel={() => { setEditing(null); setError(''); }} />
      : range ? <>
        <p className="outfit-weather-range"><strong>{range.minTempC}°–{range.maxTempC}°</strong> feels-like · {RAIN_LABELS[range.rain]}</p>
        {range.note ? <p className="outfit-small">{range.note}</p> : null}
        <p className="outfit-weather-meta">{SOURCE_LABELS[outfit.weather.source]}.</p>
        {weather?.ready ? weather.days.map((day, index) => day ? <WeatherFitLine key={WEATHER_DAY_LABELS[index]} label={WEATHER_DAY_LABELS[index]} fit={weatherFit(outfit.weather, day)} /> : null) : null}
        <div className="outfit-weather-actions">
          <button type="button" className="outfit-text-button" onClick={() => { setEditing({ expectedUpdatedAt: outfit.weather?.updatedAt ?? null }); setError(''); }} disabled={locked}>Edit weather details</button>
          <button type="button" className="outfit-text-button" onClick={() => run('clear', async () => { onSaved([await post(`/api/outfits/${encodeURIComponent(outfit.id)}/weather`, { weather: null, expectedUpdatedAt: outfit.weather.updatedAt })]); })} disabled={locked}>{busy === 'clear' ? 'Removing…' : 'Remove'}</button>
        </div>
      </> : <>
        <p className="outfit-small">No weather details yet. Add the temperatures and rain this look suits to match it to the forecast.</p>
        <div className="outfit-weather-actions">
          {hasApiKey ? <button type="button" className="outfit-secondary" onClick={estimate} disabled={locked}>{busy === 'estimate' ? 'Estimating…' : 'Estimate weather details'}</button> : null}
          <button type="button" className="outfit-text-button" onClick={() => { setEditing({ expectedUpdatedAt: outfit.weather?.updatedAt ?? null }); setError(''); }} disabled={locked}>Add them yourself</button>
        </div>
        {hasApiKey ? <p className="outfit-weather-meta">Estimating sends this look’s photo and piece details to the AI service and may incur charges.</p> : null}
      </>}
    {error ? <p className="outfit-error" role="alert">{error}</p> : null}
  </section>;
}

// Estimate weather details for saved looks without them, a few at a time, so
// progress is saved after each batch and stopping keeps what was finished.
export function WeatherBackfill({ outfits, hasApiKey, onSaved }) {
  const [run, setRun] = useState(null);
  const controller = useRef(null);
  const stopping = useRef(false);
  useEffect(() => () => { stopping.current = true; controller.current?.abort(); }, []);
  const missing = outfits.filter(outfit => !outfit.weather);
  const start = async () => {
    const queue = missing.map(outfit => outfit.id);
    stopping.current = false;
    setRun({ total: queue.length, done: 0, skipped: 0, running: true, error: '', stopped: false });
    for (let index = 0; index < queue.length; index += WEATHER_BATCH) {
      if (stopping.current) break;
      const active = controller.current = new AbortController();
      try {
        const result = await post('/api/outfits/weather/estimate', { outfitIds: queue.slice(index, index + WEATHER_BATCH) }, active.signal);
        if (active.signal.aborted) return;
        onSaved(result.outfits);
        setRun(value => ({ ...value, done: value.done + result.outfits.length, skipped: value.skipped + result.skipped.length }));
      } catch (failure) {
        if (active.signal.aborted) return;
        setRun(value => ({ ...value, running: false, error: uiErrorMessage(failure) }));
        return;
      }
    }
    setRun(value => ({ ...value, running: false, stopped: stopping.current }));
  };
  const processed = run ? run.done + run.skipped : 0;
  return <div className="outfit-weather-backfill">
    <p className="outfit-form-intro">Estimate the feels-like temperatures and rain each saved look suits, from its photo and the details of its pieces. New generated looks include these automatically.</p>
    {!run ? <p role="status">{missing.length ? `${missing.length} saved ${missing.length === 1 ? 'look needs' : 'looks need'} weather details.` : 'Every saved look has weather details.'}</p> : null}
    {run ? <div className="outfit-weather-progress">
      <progress max={run.total} value={processed} aria-label="Weather estimate progress" />
      <p role="status" aria-live="polite">{run.running ? `Estimating… ${processed} of ${run.total} done.` : run.error ? `${run.done} of ${run.total} looks updated before an error.` : run.stopped ? `Stopped. ${run.done} of ${run.total} looks updated.` : `Done. ${run.done} ${run.done === 1 ? 'look' : 'looks'} updated.`}{run.skipped ? ` ${run.skipped} skipped because they changed or already had details.` : ''}</p>
    </div> : null}
    {run?.error ? <p className="outfit-error" role="alert">{run.error}</p> : null}
    {!hasApiKey ? <p className="outfit-small" role="status">Estimates are unavailable until the generation service is connected. You can add weather details to any look from its details.</p> : null}
    <div className="outfit-form-actions">
      <p className="outfit-form-note">This sends look photos and piece details to the AI service, {WEATHER_BATCH} looks per request, and may incur charges. Your edits are never overwritten.</p>
      {run?.running ? <button type="button" className="outfit-secondary" onClick={() => { stopping.current = true; setRun(value => ({ ...value, stopping: true })); }} disabled={run.stopping}>{run.stopping ? 'Stopping after this batch…' : 'Stop'}</button>
        : <button type="button" className="outfit-primary" onClick={() => { void start(); }} disabled={!hasApiKey || !missing.length}>{!missing.length ? 'Nothing left to estimate' : run?.error ? `Try again for ${missing.length} ${missing.length === 1 ? 'look' : 'looks'}` : `Estimate ${missing.length} ${missing.length === 1 ? 'look' : 'looks'}`}</button>}
    </div>
  </div>;
}
