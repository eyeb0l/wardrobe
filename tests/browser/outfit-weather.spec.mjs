import { test as base, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import sharp from 'sharp';

const artwork = async (color, index) => `data:image/png;base64,${(await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="#eee8de"/><path d="${index % 2 ? 'M140 65 H260 L285 345 H220 L200 165 L180 345 H115Z' : 'M135 70 L175 55 Q200 82 225 55 L265 70 L320 150 L280 180 L255 150 L260 330 H140 L145 150 L120 180 L80 150Z'}" fill="${color}"/></svg>`)).png().toBuffer()).toString('base64')}`;
const colours = ['#35495a', '#c5b79a', '#827455', '#a76e58', '#5b4d6b', '#2f3e36', '#b48a6a', '#7a8792'];
const photos = await Promise.all(colours.map(artwork));
const pieces = [['coat-top', 'Charcoal roll neck', 'upperbody'], ['coat-bottom', 'Wool trousers', 'lowerbody'], ['linen-top', 'Linen shirt', 'upperbody'], ['linen-bottom', 'Linen shorts', 'lowerbody'],
  ['knit-top', 'Soft knit', 'upperbody'], ['knit-bottom', 'Straight jeans', 'lowerbody'], ['plain-top', 'Plain tee', 'upperbody'], ['plain-bottom', 'Chinos', 'lowerbody']]
  .map(([id, name, part], index) => ({ id, name, part, color: colours[index], image: photos[index], tags: [], revision: id }));
const wear = (date, garmentIds) => [{ id: crypto.randomUUID(), date, garmentIds, createdAt: `${date}T12:00:00Z` }];
const weather = (minTempC, maxTempC, rain, note) => ({ minTempC, maxTempC, rain, note, source: 'generated', updatedAt: '2026-10-01T10:00:00.000Z' });
const saved = [
  { id: 'linen-look', name: 'Linen lunch', garmentIds: ['linen-top', 'linen-bottom'], image: photos[2], weather: weather(20, 30, 'avoid', 'Linen and sandals for warm, dry days.'), wearHistory: wear('2026-01-10', ['linen-top', 'linen-bottom']) },
  { id: 'plain-look', name: 'Plain Tuesday', garmentIds: ['plain-top', 'plain-bottom'], image: photos[6], wearHistory: wear('2026-03-10', ['plain-top', 'plain-bottom']) },
  { id: 'knit-look', name: 'Soft knit errands', garmentIds: ['knit-top', 'knit-bottom'], image: photos[4], weather: weather(10, 18, 'light', 'A mid-weight knit with jeans.'), wearHistory: wear('2026-05-10', ['knit-top', 'knit-bottom']) },
  { id: 'coat-look', name: 'Wool coat walk', garmentIds: ['coat-top', 'coat-bottom'], image: photos[0], weather: weather(2, 12, 'suited', 'Wool layers with closed boots.'), wearHistory: wear('2026-09-10', ['coat-top', 'coat-bottom']) },
].map(outfit => ({ ...outfit, status: 'accepted', occasion: ['casual'], reason: 'Familiar wardrobe pieces.' }));

// 2026-10-22 (today): cool and wet. 2026-10-23 (tomorrow): warm and dry.
const forecast = {
  daily: {
    time: ['2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24'], weather_code: [3, 61, 1, 2],
    temperature_2m_max: [12, 13.2, 23.6, 18], temperature_2m_min: [5, 6.1, 15.4, 10],
    apparent_temperature_max: [10, 11.6, 25.2, 17], apparent_temperature_min: [3, 4.6, 15.1, 9],
    precipitation_probability_max: [20, 70, 0, 10], precipitation_sum: [0, 4.2, 0, 0],
  },
};
const cors = { 'access-control-allow-origin': '*' };

const test = base.extend({
  wardrobe: async ({ page, context }, use, info) => {
    const state = { items: structuredClone(pieces), outfits: structuredClone(saved), plans: [], plansRevision: 'initial', hasApiKey: false, forecastRequests: [], geocodeRequests: [], weatherPosts: [], estimates: [], failForecast: 0, failEstimate: 0, expected: [] };
    const health = { errors: [], failedRequests: [], httpErrors: [] };
    const expectedUrl = url => state.expected.some(pattern => pattern.test(url));
    page.on('pageerror', error => health.errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error' && !expectedUrl(message.location().url || '') && !state.expected.some(pattern => pattern.test(message.text()))) health.errors.push(message.text()); });
    page.on('requestfailed', request => { if (!request.failure()?.errorText.includes('ERR_ABORTED')) health.failedRequests.push(request.url()); });
    page.on('response', response => { if (response.status() >= 400 && !expectedUrl(response.url())) health.httpErrors.push(response.url()); });
    await page.clock.setFixedTime(new Date('2026-10-22T12:00:00Z'));
    await context.setExtraHTTPHeaders({ 'Accept-Language': 'en-GB' });
    await context.addInitScript(() => localStorage.setItem('wardrobe:welcome:v1', 'complete'));
    await context.route('https://api.open-meteo.com/**', route => {
      state.forecastRequests.push(new URL(route.request().url()));
      if (state.failForecast > 0) { state.failForecast -= 1; return route.fulfill({ status: 503, headers: cors, json: { error: true } }); }
      return route.fulfill({ headers: cors, json: forecast });
    });
    await context.route('https://geocoding-api.open-meteo.com/**', route => {
      const url = new URL(route.request().url());
      state.geocodeRequests.push(url);
      const results = url.searchParams.get('name') === 'Nowhere' ? undefined : [
        { name: 'London', latitude: 51.50853, longitude: -0.12574, country: 'United Kingdom', admin1: 'England' },
        { name: 'London', latitude: 42.98339, longitude: -81.23304, country: 'Canada', admin1: 'Ontario' },
      ];
      return route.fulfill({ headers: cors, json: results ? { results } : {} });
    });
    await context.route('**/api/**', async route => {
      const p = new URL(route.request().url()).pathname, method = route.request().method();
      if (p === '/api/import/wardrobe') return route.fulfill({ json: state.items });
      if (p === '/api/import/jobs') return route.fulfill({ json: [] });
      if (p === '/api/import/config') return route.fulfill({ json: { ready: false, hasApiKey: false, modelReferences: [] } });
      if (p === '/api/outfits/config') return route.fulfill({ json: { ready: false, hasApiKey: state.hasApiKey, modelReferences: [] } });
      if (p === '/api/outfits/discovery/config') return route.fulfill({ json: { ready: false, enabled: false } });
      if (p === '/api/outfits/jobs') return route.fulfill({ json: { jobs: [] } });
      if (p === '/api/outfits') return route.fulfill({ json: { outfits: state.outfits, plans: state.plans, plansRevision: state.plansRevision } });
      if (p.endsWith('/accessories')) return route.fulfill({ json: { hasApiKey: false } });
      if (p === '/api/outfits/plans' && method === 'POST') {
        const body = route.request().postDataJSON();
        state.plans = state.plans.filter(plan => plan.date !== body.date);
        if (body.outfitId !== null) state.plans.push({ date: body.date, outfitId: body.outfitId });
        state.plansRevision = crypto.randomUUID();
        return route.fulfill({ json: { plans: state.plans, plansRevision: state.plansRevision } });
      }
      if (p === '/api/outfits/weather/estimate' && method === 'POST') {
        const body = route.request().postDataJSON();
        state.estimates.push(body.outfitIds);
        if (state.failEstimate > 0) { state.failEstimate -= 1; return route.fulfill({ status: 502, json: { error: 'The API returned invalid weather details. Please try again.' } }); }
        const updated = state.outfits.filter(outfit => body.outfitIds.includes(outfit.id) && !outfit.weather);
        for (const outfit of updated) outfit.weather = { ...weather(6, 16, 'light', 'Estimated in test.'), source: 'estimated' };
        return route.fulfill({ json: { outfits: updated, skipped: body.outfitIds.filter(id => !updated.some(outfit => outfit.id === id)) } });
      }
      const edit = p.match(/^\/api\/outfits\/([^/]+)\/weather$/);
      if (edit && method === 'POST') {
        const body = route.request().postDataJSON(), outfit = state.outfits.find(item => item.id === edit[1]);
        state.weatherPosts.push({ id: edit[1], ...body });
        if ((outfit.weather?.updatedAt ?? null) !== body.expectedUpdatedAt) return route.fulfill({ status: 409, json: { error: 'This look’s weather details changed elsewhere. Review the current details and try again.' } });
        if (body.weather === null) delete outfit.weather;
        else outfit.weather = { ...body.weather, source: 'edited', updatedAt: new Date(Date.now() + state.weatherPosts.length).toISOString() };
        return route.fulfill({ json: outfit });
      }
      health.errors.push(`Unexpected API ${method} ${p}`);
      return route.fulfill({ status: 500, json: {} });
    });
    await page.goto('/outfits');
    await expect(page).toHaveTitle('Open Wardrobe');
    await expect(page.getByRole('region', { name: 'Your plans' })).toBeVisible();
    await use(state);
    await expect(page.locator('vite-error-overlay')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await writeFile(info.outputPath('browser-health.json'), JSON.stringify(health, null, 2));
    expect(health).toEqual({ errors: [], failedRequests: [], httpErrors: [] });
  },
});

const panel = page => page.getByRole('region', { name: 'Your plans' }).getByRole('complementary', { name: 'Weather' });
const shortlist = page => page.getByRole('region', { name: 'What to wear' });
const choices = page => shortlist(page).getByRole('button', { name: /^Choose / });
const plan = (page, tomorrow = false) => page.getByRole('region', { name: 'Your plans' }).getByRole('article', { name: tomorrow ? 'Tomorrow’s plan' : 'Today’s plan' });
const storedLocation = location => localStorage.setItem('wardrobe:weather:v1', JSON.stringify({ location }));
const london = { name: 'London', detail: 'England, United Kingdom', latitude: 51.51, longitude: -0.13 };

test('choose a weather location, match plans and the shortlist to the forecast, and reuse it after reload', async ({ page, wardrobe }, info) => {
  await expect(panel(page).getByText('Add a location to match your looks to the forecast.')).toBeVisible();
  await expect(choices(page)).toHaveText([/Linen lunch/, /Plain Tuesday/, /Soft knit errands/]);
  expect(wardrobe.forecastRequests).toHaveLength(0);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: info.outputPath('weather-not-set.png') });

  await panel(page).getByRole('button', { name: 'Add location' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add weather' });
  await expect(dialog.getByText(/rounded to about 1 km/)).toBeVisible();
  await dialog.getByRole('searchbox', { name: 'Or search for a place' }).fill('Nowhere');
  await dialog.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(dialog.getByText('No places found. Try a nearby town or check the spelling.')).toBeVisible();
  await dialog.getByRole('searchbox', { name: 'Or search for a place' }).fill('London');
  await dialog.getByRole('button', { name: 'Search', exact: true }).click();
  await dialog.getByRole('button', { name: 'London England, United Kingdom' }).click();
  await expect(dialog).not.toBeVisible();

  await expect(panel(page).getByText('London', { exact: true })).toBeVisible();
  await expect(panel(page).getByRole('group', { name: 'Today: Rain, high 13°, low 6°, 70% chance of rain, feels like 5° to 12°' })).toBeVisible();
  await expect(panel(page).getByRole('group', { name: 'Tomorrow: Mostly clear, high 24°, low 15°, 0% chance of rain, feels like 15° to 25°' })).toBeVisible();
  const request = wardrobe.forecastRequests.at(-1);
  expect([request.searchParams.get('latitude'), request.searchParams.get('longitude'), request.searchParams.get('timezone')]).toEqual(['51.51', '-0.13', 'auto']);

  // Today: the coat suits the cold rain, the knit is workable, linen is left out.
  await expect(choices(page)).toHaveText([/Wool coat walk.*Good for the weather/, /Soft knit errands.*Workable with care/, /Plain Tuesday.*No weather details/]);
  await expect(shortlist(page).getByText('1 look is left out because it doesn’t suit today’s weather.', { exact: false })).toBeVisible();
  await expect(shortlist(page).getByText('1 saved look has no weather details', { exact: false })).toBeVisible();
  await shortlist(page).getByRole('radio', { name: 'Tomorrow', exact: true }).check();
  await expect(choices(page)).toHaveText([/Linen lunch.*Workable/, /Soft knit errands.*Workable/, /Plain Tuesday/]);
  await expect(shortlist(page).getByText('doesn’t suit tomorrow’s weather', { exact: false })).toBeVisible();
  await shortlist(page).getByRole('radio', { name: 'Off', exact: true }).check();
  await expect(choices(page)).toHaveText([/Linen lunch/, /Plain Tuesday/, /Soft knit errands/]);
  await expect(choices(page).first()).not.toContainText('weather');
  await shortlist(page).getByRole('radio', { name: 'Today', exact: true }).check();

  // Plans show how each planned look fits that day's forecast.
  await plan(page).getByRole('button', { name: 'Choose look', exact: true }).click();
  const chooser = page.getByRole('dialog', { name: 'Plan for today', exact: true });
  await chooser.getByRole('combobox', { name: 'Saved look' }).selectOption('linen-look');
  await expect(chooser.getByText(/Not ideal for the weather\..*Likely too cold/)).toBeVisible();
  await chooser.getByRole('combobox', { name: 'Saved look' }).selectOption('coat-look');
  await chooser.getByRole('button', { name: 'Save plan', exact: true }).click();
  await expect(plan(page).getByText(/Good for the weather\. Suits feels-like 5°–12°\./)).toBeVisible();
  await plan(page, true).getByRole('button', { name: 'Choose look', exact: true }).click();
  const tomorrow = page.getByRole('dialog', { name: 'Plan for tomorrow', exact: true });
  await tomorrow.getByRole('combobox', { name: 'Saved look' }).selectOption('coat-look');
  await tomorrow.getByRole('button', { name: 'Save plan', exact: true }).click();
  await expect(plan(page, true).getByText(/Not ideal for the weather\. Likely too warm/)).toBeVisible();

  await page.getByRole('region', { name: 'Your plans' }).screenshot({ path: info.outputPath('weather-plans.png') });
  await shortlist(page).screenshot({ path: info.outputPath('weather-shortlist.png') });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: info.outputPath('weather-first-viewport.png') });

  // The location stays on this device; a fresh cached forecast is reused.
  const requests = wardrobe.forecastRequests.length;
  await page.reload();
  await expect(panel(page).getByRole('group', { name: /^Today: Rain, high 13°/ })).toBeVisible();
  expect(wardrobe.forecastRequests).toHaveLength(requests);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('wardrobe:weather:v1')).location)).toEqual(london);
});

test('use the device location, recover from a forecast failure and stop using weather', async ({ page, context, wardrobe }) => {
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: 53.480759, longitude: -2.242631 });
  wardrobe.failForecast = 1;
  wardrobe.expected.push(/api\.open-meteo\.com/);
  await panel(page).getByRole('button', { name: 'Add location' }).click();
  await page.getByRole('dialog', { name: 'Add weather' }).getByRole('button', { name: 'Use my location' }).click();
  await expect(panel(page).getByText('Current location', { exact: true })).toBeVisible();
  await expect(panel(page).getByRole('status')).toHaveText(/The weather service is unavailable right now\. Try again shortly\./);
  await expect(panel(page).getByText('Forecast unavailable')).toHaveCount(2);
  await expect(shortlist(page).getByRole('group', { name: 'Match weather' })).toHaveCount(0);
  await panel(page).getByRole('button', { name: 'Retry forecast' }).click();
  await expect(panel(page).getByRole('group', { name: /^Today: Rain/ })).toBeVisible();
  expect(wardrobe.forecastRequests.map(url => [url.searchParams.get('latitude'), url.searchParams.get('longitude')])).toEqual([['53.48', '-2.24'], ['53.48', '-2.24']]);
  await expect(shortlist(page).getByRole('group', { name: 'Match weather' })).toBeVisible();

  await panel(page).getByRole('button', { name: 'Change weather location, currently Current location' }).click();
  const dialog = page.getByRole('dialog', { name: 'Weather location' });
  await dialog.getByRole('button', { name: 'Stop using weather' }).click();
  await expect(panel(page).getByRole('button', { name: 'Add location' })).toBeVisible();
  await expect(choices(page)).toHaveText([/Linen lunch/, /Plain Tuesday/, /Soft knit errands/]);
  expect(await page.evaluate(() => localStorage.getItem('wardrobe:weather:v1'))).toBeNull();
});

test('add weather details by hand, estimate the rest in batches and recover from an estimate error', async ({ page, wardrobe }, info) => {
  wardrobe.hasApiKey = true;
  wardrobe.outfits.push(...Array.from({ length: 6 }, (_, index) => ({ ...structuredClone(saved[1]), id: `extra-${index + 1}`, name: `Extra look ${index + 1}`, weather: undefined, wearHistory: [] })));
  await page.evaluate(storedLocation, london);
  await page.reload();
  await expect(panel(page).getByRole('group', { name: /^Today: Rain/ })).toBeVisible();

  await page.getByRole('button', { name: 'View Plain Tuesday', exact: true }).click();
  const details = page.getByRole('dialog', { name: 'Plain Tuesday', exact: true });
  const section = details.getByRole('region', { name: 'Weather suitability' });
  await expect(section.getByText('No weather details yet.', { exact: false })).toBeVisible();
  await expect(section.getByText(/may incur charges/)).toBeVisible();
  await section.getByRole('button', { name: 'Add them yourself' }).click();
  await section.getByRole('spinbutton', { name: 'Coolest (°C)' }).fill('16');
  await section.getByRole('spinbutton', { name: 'Warmest (°C)' }).fill('14');
  await expect(section.getByRole('button', { name: 'Save weather details' })).toBeDisabled();
  await section.getByRole('spinbutton', { name: 'Coolest (°C)' }).fill('4');
  await section.getByRole('combobox', { name: 'In rain' }).selectOption('suited');
  await section.getByRole('textbox', { name: 'Note optional' }).fill('Chinos with a rain shell.');
  await section.getByRole('button', { name: 'Save weather details' }).click();
  await expect(section.getByText('4°–14°', { exact: true })).toBeVisible();
  await expect(section.getByText('Set by you.')).toBeVisible();
  await expect(section.getByText(/^Today: Good for the weather\. Suits/)).toBeVisible();
  await expect(section.getByText(/^Tomorrow: Not ideal for the weather\. Likely/)).toBeVisible();
  expect(wardrobe.weatherPosts.at(-1)).toEqual({ id: 'plain-look', weather: { minTempC: 4, maxTempC: 14, rain: 'suited', note: 'Chinos with a rain shell.' }, expectedUpdatedAt: null });
  wardrobe.savedUpdatedAt = wardrobe.outfits.find(outfit => outfit.id === 'plain-look').weather.updatedAt;
  await section.screenshot({ path: info.outputPath('weather-details.png') });

  // An edit started before another device's change conflicts even after a
  // refresh delivers that change, and the latest details are shown.
  wardrobe.expected.push(/\/api\/outfits\/plain-look\/weather/, /409 \(Conflict\)/);
  await section.getByRole('button', { name: 'Edit weather details' }).click();
  Object.assign(wardrobe.outfits.find(outfit => outfit.id === 'plain-look').weather, { note: 'Changed on another device.', updatedAt: '2026-10-22T12:30:00.000Z' });
  const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/outfits' && response.request().method() === 'GET');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await refreshed;
  await section.getByRole('spinbutton', { name: 'Warmest (°C)' }).fill('15');
  await section.getByRole('button', { name: 'Save weather details' }).click();
  await expect(section.getByRole('alert')).toHaveText('This look’s weather details changed elsewhere. Review the current details and try again.');
  await expect(section.getByText('Changed on another device.')).toBeVisible();
  expect(wardrobe.weatherPosts.at(-1).expectedUpdatedAt).toBe(wardrobe.savedUpdatedAt);
  // A stale removal is rejected the same way.
  wardrobe.outfits.find(outfit => outfit.id === 'plain-look').weather.updatedAt = '2026-10-22T13:00:00.000Z';
  await section.getByRole('button', { name: 'Remove' }).click();
  await expect(section.getByRole('alert')).toHaveText('This look’s weather details changed elsewhere. Review the current details and try again.');
  await section.getByRole('button', { name: 'Remove' }).click();
  await expect(section.getByText('No weather details yet.', { exact: false })).toBeVisible();
  await details.getByRole('button', { name: 'Close' }).click();

  await expect(shortlist(page).getByText('7 saved looks have no weather details', { exact: false })).toBeVisible();
  wardrobe.failEstimate = 1;
  wardrobe.expected.push(/\/api\/outfits\/weather\/estimate/, /502 \(Bad Gateway\)/);
  await shortlist(page).getByRole('button', { name: 'Add weather details' }).click();
  const backfill = page.getByRole('dialog', { name: 'Add weather details' });
  await expect(backfill.getByText('7 saved looks need weather details.')).toBeVisible();
  await backfill.getByRole('button', { name: 'Estimate 7 looks' }).click();
  await expect(backfill.getByRole('alert')).toHaveText('The API returned invalid weather details. Please try again.');
  await backfill.getByRole('button', { name: 'Try again for 7 looks' }).click();
  await expect(backfill.getByText('Done. 7 looks updated.')).toBeVisible();
  expect(wardrobe.estimates.map(ids => ids.length)).toEqual([6, 6, 1]);
  expect(wardrobe.estimates[1]).toEqual(['plain-look', 'extra-1', 'extra-2', 'extra-3', 'extra-4', 'extra-5']);
  await expect(backfill.getByRole('button', { name: 'Nothing left to estimate' })).toBeDisabled();
  await backfill.screenshot({ path: info.outputPath('weather-backfill.png') });
  await backfill.getByRole('button', { name: 'Close' }).click();
  await expect(shortlist(page).getByText('have no weather details', { exact: false })).toHaveCount(0);
  await expect(choices(page).first()).toContainText('Good for the weather');
});
