// Weather suitability for saved looks, and how a look fits a day's forecast.
// Temperatures are feels-like degrees Celsius for the outfit exactly as worn,
// without unlisted layers. Shared by the API, storage validation and the UI.

export const RAIN_SUITABILITY = ['suited', 'light', 'avoid'];
export const WEATHER_SOURCES = ['generated', 'estimated', 'edited'];
export const WEATHER_TEMPERATURE = { min: -20, max: 45 };
export const WEATHER_NOTE_LENGTH = 200;

// Structured-output schema used by outfit planning and by estimates for saved
// looks. Keep it self-contained JSON: benchmark tooling evaluates it offline.
export const WEATHER_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['minTempC', 'maxTempC', 'rain', 'note'],
  properties: {
    minTempC: { type: 'integer', minimum: WEATHER_TEMPERATURE.min, maximum: WEATHER_TEMPERATURE.max },
    maxTempC: { type: 'integer', minimum: WEATHER_TEMPERATURE.min, maximum: WEATHER_TEMPERATURE.max },
    rain: { type: 'string', enum: RAIN_SUITABILITY },
    note: { type: 'string', maxLength: WEATHER_NOTE_LENGTH },
  },
};

export const WEATHER_GUIDANCE = 'Weather suitability: minTempC and maxTempC are the coolest and warmest feels-like daytime temperatures in °C at which this exact outfit is comfortable outdoors, without adding unlisted layers; keep at least 4 °C between them. rain is "suited" only when footwear, fabrics, hems and any outer layer cope with steady rain; "light" for brief showers; "avoid" when rain would spoil or soak the look (for example suede, silk, open shoes, long delicate hems or no cover). note is one short plain sentence naming the deciding pieces.';

const integer = value => Number.isInteger(value) && value >= WEATHER_TEMPERATURE.min && value <= WEATHER_TEMPERATURE.max;

// Returns the editable fields, trimmed, or null when anything is invalid.
export function normalizeWeather(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { minTempC, maxTempC, rain } = value;
  const note = value.note === undefined ? '' : value.note;
  if (!integer(minTempC) || !integer(maxTempC) || minTempC >= maxTempC) return null;
  if (!RAIN_SUITABILITY.includes(rain)) return null;
  if (typeof note !== 'string' || note.length > WEATHER_NOTE_LENGTH || /[\r\n]/.test(note)) return null;
  return { minTempC, maxTempC, rain, note: note.trim() };
}

export function weatherRecord(value, source, updatedAt) {
  const weather = normalizeWeather(value);
  return weather && { ...weather, source, updatedAt };
}

export function validStoredWeather(value) {
  return Boolean(normalizeWeather(value)) && WEATHER_SOURCES.includes(value.source)
    && typeof value.updatedAt === 'string' && Number.isFinite(Date.parse(value.updatedAt))
    && Object.keys(value).every(key => ['minTempC', 'maxTempC', 'rain', 'note', 'source', 'updatedAt'].includes(key));
}

// WMO weather interpretation codes, as reported by Open-Meteo.
const CONDITIONS = [
  [[0], 'Clear', 'clear'], [[1], 'Mostly clear', 'clear'], [[2], 'Partly cloudy', 'partly'], [[3], 'Overcast', 'cloud'],
  [[45, 48], 'Fog', 'fog'], [[51, 53, 55, 56, 57], 'Drizzle', 'rain'], [[61, 63, 66, 80, 81], 'Rain', 'rain'],
  [[65, 67, 82], 'Heavy rain', 'rain'], [[71, 73, 75, 77, 85, 86], 'Snow', 'snow'], [[95, 96, 99], 'Thunderstorms', 'storm'],
];

export function weatherCondition(code) {
  const match = CONDITIONS.find(([codes]) => codes.includes(code));
  return match ? { label: match[1], kind: match[2] } : { label: 'Forecast', kind: 'cloud' };
}

const finite = value => typeof value === 'number' && Number.isFinite(value);

// Parse an Open-Meteo daily forecast into rounded per-date conditions.
export function forecastDays(daily) {
  if (!daily || !Array.isArray(daily.time)) return [];
  const at = (key, index) => Array.isArray(daily[key]) && finite(daily[key][index]) ? daily[key][index] : null;
  return daily.time.flatMap((date, index) => {
    const high = at('temperature_2m_max', index), low = at('temperature_2m_min', index);
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || high === null || low === null) return [];
    const feelsHigh = at('apparent_temperature_max', index), feelsLow = at('apparent_temperature_min', index);
    const rainChance = at('precipitation_probability_max', index), precipitation = at('precipitation_sum', index);
    const code = at('weather_code', index);
    return [{
      date, code, high: Math.round(high), low: Math.round(low),
      feelsHigh: Math.round(feelsHigh ?? high), feelsLow: Math.round(feelsLow ?? low),
      rainChance: rainChance === null ? null : Math.round(rainChance),
      precipitation: precipitation === null ? null : Math.round(precipitation * 10) / 10,
    }];
  });
}

export function dayWetness(day) {
  const snow = weatherCondition(day.code).kind === 'snow';
  if (snow || (day.rainChance ?? 0) >= 60 || (day.precipitation ?? 0) >= 2) return 'wet';
  if ((day.rainChance ?? 0) >= 30 || (day.precipitation ?? 0) >= 0.5) return 'showers';
  return 'dry';
}

const LEVELS = ['good', 'fair', 'poor'];
const worse = (level, floor) => LEVELS[Math.max(LEVELS.indexOf(level), LEVELS.indexOf(floor))];
const degrees = value => `${value}°`;

// Compare a look's comfortable range with the day's feels-like range. Daily
// lows usually fall overnight, so a cooler low is tolerated more than heat.
export function weatherFit(weather, day) {
  if (!day) return null;
  const range = normalizeWeather(weather);
  if (!range) return { level: 'unknown', summary: 'No weather details yet', reasons: [] };
  const low = day.feelsLow, high = day.feelsHigh;
  const reasons = [];
  let level;
  if (high < range.minTempC) { level = 'poor'; reasons.push(`Likely too cold: feels ${degrees(low)}–${degrees(high)}, this look suits ${degrees(range.minTempC)}–${degrees(range.maxTempC)}.`); }
  else if (low > range.maxTempC) { level = 'poor'; reasons.push(`Likely too warm: feels ${degrees(low)}–${degrees(high)}, this look suits ${degrees(range.minTempC)}–${degrees(range.maxTempC)}.`); }
  else if (range.minTempC - low > 4) { level = 'fair'; reasons.push(`Chilly at times: down to ${degrees(low)}. Bring a layer.`); }
  else if (high - range.maxTempC > 2) { level = 'fair'; reasons.push(`Warm at times: up to ${degrees(high)}.`); }
  else { level = 'good'; reasons.push(`Suits feels-like ${degrees(low)}–${degrees(high)}.`); }
  const wetness = dayWetness(day);
  const chance = day.rainChance === null ? '' : ` (${day.rainChance}%)`;
  if (range.rain === 'avoid' && wetness === 'wet') { level = level === 'good' ? 'fair' : 'poor'; reasons.push(`Rain likely${chance}; best kept for a dry day.`); }
  else if (range.rain === 'avoid' && wetness === 'showers') { level = worse(level, 'fair'); reasons.push(`Showers possible${chance}; this look prefers a dry day.`); }
  else if (range.rain === 'light' && wetness === 'wet') { level = worse(level, 'fair'); reasons.push(`Rain likely${chance}; this look handles light showers only.`); }
  const summary = { good: 'Good for the weather', fair: 'Workable with care', poor: 'Not ideal for the weather' }[level];
  return { level, summary, reasons };
}

export const RAIN_LABELS = { suited: 'Fine in rain', light: 'Light showers only', avoid: 'Best on dry days' };
export const SOURCE_LABELS = { generated: 'Estimated when this look was generated', estimated: 'Estimated from the photo and pieces', edited: 'Set by you' };

export function weatherRangeText(weather) {
  const range = normalizeWeather(weather);
  return range ? `${degrees(range.minTempC)}–${degrees(range.maxTempC)} · ${RAIN_LABELS[range.rain]}` : '';
}
