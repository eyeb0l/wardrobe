import { useCallback, useEffect, useRef, useState } from 'react';
import { forecastDays } from '../shared/outfit-weather.mjs';

// Forecasts come directly from Open-Meteo (no key). Nothing is requested until
// the wearer chooses a location, which stays on this device only.
const STORAGE_KEY = 'wardrobe:weather:v1';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const STALE_MS = 30 * 60 * 1000;
const DAILY = 'weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,precipitation_probability_max,precipitation_sum';

// Two decimals is roughly 1 km: enough for a forecast, without a precise position.
const coordinate = value => Math.round(value * 100) / 100;
const validLocation = value => value && typeof value.name === 'string' && value.name.trim() && Number.isFinite(value.latitude) && Number.isFinite(value.longitude)
  && Math.abs(value.latitude) <= 90 && Math.abs(value.longitude) <= 180;

export function makeLocation({ name, detail = '', latitude, longitude }) {
  return { name: String(name).slice(0, 120), detail: String(detail || '').slice(0, 160), latitude: coordinate(latitude), longitude: coordinate(longitude) };
}

function readStored() {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (!value || !validLocation(value.location)) return null;
    const forecast = value.forecast && value.forecast.latitude === value.location.latitude && value.forecast.longitude === value.location.longitude
      && Number.isFinite(value.forecast.fetchedAt) && Array.isArray(value.forecast.days) ? value.forecast : null;
    return { location: value.location, forecast };
  } catch { return null; }
}

function writeStored(value) {
  try {
    if (value) localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    else localStorage.removeItem(STORAGE_KEY);
  } catch { /* Private browsing can refuse storage; the forecast still shows this session. */ }
}

async function json(url, signal) {
  let response;
  try { response = await fetch(url, { signal, cache: 'no-store' }); }
  catch (error) { if (signal?.aborted) throw error; throw new Error('The weather service could not be reached. Check your connection and try again.'); }
  const result = await response.json().catch(() => null);
  if (!response.ok || !result) throw new Error('The weather service is unavailable right now. Try again shortly.');
  return result;
}

export async function fetchForecast(location, signal) {
  const query = new URLSearchParams({ latitude: String(location.latitude), longitude: String(location.longitude), daily: DAILY, timezone: 'auto', past_days: '1', forecast_days: '3' });
  const days = forecastDays((await json(`${FORECAST_URL}?${query}`, signal)).daily);
  if (!days.length) throw new Error('The forecast for this location was incomplete. Try again shortly.');
  return { latitude: location.latitude, longitude: location.longitude, fetchedAt: Date.now(), days };
}

export async function searchPlaces(name, signal) {
  const query = new URLSearchParams({ name: name.trim(), count: '5', language: navigator.language?.split('-')[0] || 'en', format: 'json' });
  const result = await json(`${GEOCODING_URL}?${query}`, signal);
  return (Array.isArray(result.results) ? result.results : []).filter(place => Number.isFinite(place?.latitude) && Number.isFinite(place?.longitude) && typeof place.name === 'string')
    .map(place => makeLocation({ name: place.name, detail: [place.admin1, place.country].filter(Boolean).join(', '), latitude: place.latitude, longitude: place.longitude }));
}

export function currentPosition() {
  return new Promise((resolve, reject) => {
    if (!window.isSecureContext || !navigator.geolocation) return reject(new Error('Location is unavailable in this browser. Search for a place instead.'));
    navigator.geolocation.getCurrentPosition(
      position => resolve(makeLocation({ name: 'Current location', latitude: position.coords.latitude, longitude: position.coords.longitude })),
      error => reject(new Error(error.code === 1 ? 'Location permission was declined. Search for a place instead.' : 'Your location could not be found. Search for a place instead.')),
      { enableHighAccuracy: false, timeout: 15_000, maximumAge: 60 * 60 * 1000 },
    );
  });
}

// `days` are the device's [today, tomorrow] dates. Forecast dates follow the
// location's time zone, so a missing day is reported rather than guessed.
export function useWeather(days) {
  const [state, setState] = useState(() => {
    const stored = readStored();
    return { location: stored?.location || null, forecast: stored?.forecast || null, loading: false, error: '' };
  });
  const controller = useRef(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  const load = useCallback(async (location, { force = false } = {}) => {
    if (!location) return;
    const current = stateRef.current.forecast;
    const fresh = current && current.latitude === location.latitude && current.longitude === location.longitude && Date.now() - current.fetchedAt < STALE_MS
      && days.every(date => current.days.some(day => day.date === date));
    if (fresh && !force) return;
    controller.current?.abort();
    const active = controller.current = new AbortController();
    setState(value => ({ ...value, loading: true, error: '' }));
    try {
      const forecast = await fetchForecast(location, active.signal);
      if (active.signal.aborted) return;
      writeStored({ location, forecast });
      setState(value => value.location === location ? { ...value, forecast, loading: false, error: '' } : value);
    } catch (error) {
      if (active.signal.aborted) return;
      setState(value => ({ ...value, loading: false, error: error.message }));
    }
  }, [days]);

  useEffect(() => { void load(stateRef.current.location); }, [load]);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState !== 'hidden') void load(stateRef.current.location); };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => { window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); controller.current?.abort(); };
  }, [load]);

  const setLocation = useCallback(location => {
    controller.current?.abort();
    writeStored(location ? { location, forecast: null } : null);
    setState({ location, forecast: null, loading: false, error: '' });
    if (location) void load(location, { force: true });
  }, [load]);

  const byDate = new Map((state.forecast?.days || []).map(day => [day.date, day]));
  return {
    location: state.location,
    loading: state.loading,
    error: state.error,
    fetchedAt: state.forecast?.fetchedAt || null,
    days: days.map(date => byDate.get(date) || null),
    ready: Boolean(state.location && days.some(date => byDate.has(date))),
    setLocation,
    refresh: () => load(stateRef.current.location, { force: true }),
  };
}
