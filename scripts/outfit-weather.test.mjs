import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { API, harness, plan } from "./test-helpers/outfit-harness.mjs";
import { validateManifest } from "./outfit-storage.mjs";
import { forecastDays, normalizeWeather, weatherFit, validStoredWeather } from "../shared/outfit-weather.mjs";
import { outfitShortlist } from "../shared/outfit-shortlist.mjs";

const mild = { minTempC: 10, maxTempC: 18, rain: "light", note: "Light knit and loafers." };
const day = (overrides = {}) => ({ date: "2026-11-01", code: 3, high: 15, low: 9, feelsHigh: 14, feelsLow: 8, rainChance: 10, precipitation: 0, ...overrides });
const respond = (value) => Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(value) }] }] });

test("weather details normalize only plausible whole-degree ranges", () => {
  assert.deepEqual(normalizeWeather({ ...mild, note: "  Light knit.  " }), { ...mild, note: "Light knit." });
  assert.deepEqual(normalizeWeather({ minTempC: 2, maxTempC: 9, rain: "suited" }), { minTempC: 2, maxTempC: 9, rain: "suited", note: "" });
  for (const invalid of [null, [], { ...mild, minTempC: 18 }, { ...mild, minTempC: 10.5 }, { ...mild, maxTempC: 46 }, { ...mild, minTempC: -21 },
    { ...mild, rain: "sometimes" }, { ...mild, note: "a\nb" }, { ...mild, note: "x".repeat(201) }, { ...mild, minTempC: "10" }]) assert.equal(normalizeWeather(invalid), null, JSON.stringify(invalid));
  assert.equal(validStoredWeather({ ...mild, source: "estimated", updatedAt: "2026-11-01T10:00:00.000Z" }), true);
  assert.equal(validStoredWeather({ ...mild, source: "guessed", updatedAt: "2026-11-01T10:00:00.000Z" }), false);
  assert.equal(validStoredWeather({ ...mild, source: "edited", updatedAt: "2026-11-01T10:00:00.000Z", extra: true }), false);
});

test("Open-Meteo daily forecasts become rounded days and skip incomplete entries", () => {
  const days = forecastDays({
    time: ["2026-11-01", "2026-11-02", "2026-11-03"], weather_code: [61, 0, 3],
    temperature_2m_max: [14.6, 17.2, null], temperature_2m_min: [8.4, 6.5, 5],
    apparent_temperature_max: [12.4, null, 3], apparent_temperature_min: [5.5, 4.1, 1],
    precipitation_probability_max: [72, null, 0], precipitation_sum: [3.26, 0, 0],
  });
  assert.deepEqual(days, [
    { date: "2026-11-01", code: 61, high: 15, low: 8, feelsHigh: 12, feelsLow: 6, rainChance: 72, precipitation: 3.3 },
    { date: "2026-11-02", code: 0, high: 17, low: 7, feelsHigh: 17, feelsLow: 4, rainChance: null, precipitation: 0 },
  ]);
  assert.deepEqual(forecastDays(null), []);
});

test("weather fit compares feels-like ranges and downgrades for rain", () => {
  assert.equal(weatherFit(mild, null), null);
  assert.equal(weatherFit(undefined, day()).level, "unknown");
  assert.equal(weatherFit(mild, day()).level, "good");
  assert.equal(weatherFit(mild, day({ feelsLow: 3, feelsHigh: 12 })).level, "fair");
  assert.match(weatherFit(mild, day({ feelsLow: 3, feelsHigh: 12 })).reasons[0], /down to 3°/);
  assert.equal(weatherFit(mild, day({ feelsLow: 12, feelsHigh: 22 })).level, "fair");
  assert.equal(weatherFit(mild, day({ feelsLow: -2, feelsHigh: 6 })).level, "poor");
  assert.match(weatherFit(mild, day({ feelsLow: -2, feelsHigh: 6 })).reasons[0], /too cold/);
  assert.equal(weatherFit(mild, day({ feelsLow: 21, feelsHigh: 28 })).level, "poor");
  // Rain: suited looks ignore it, light-only and dry-day looks are downgraded.
  const wet = { rainChance: 80, precipitation: 6, code: 63 };
  assert.equal(weatherFit({ ...mild, rain: "suited" }, day(wet)).level, "good");
  assert.equal(weatherFit(mild, day(wet)).level, "fair");
  assert.equal(weatherFit({ ...mild, rain: "avoid" }, day(wet)).level, "fair");
  assert.equal(weatherFit({ ...mild, rain: "avoid" }, day({ ...wet, feelsLow: 3 })).level, "poor");
  assert.equal(weatherFit({ ...mild, rain: "avoid" }, day({ rainChance: 40 })).level, "fair");
  assert.equal(weatherFit({ ...mild, rain: "avoid" }, day({ code: 73, rainChance: 0 })).level, "fair", "snow counts as wet");
});

test("the shortlist puts weather-suited looks first, leaves out unsuitable ones and counts missing details", () => {
  const itemsById = new Map(["t1", "t2", "t3", "t4", "b1", "b2", "b3", "b4"].map((id) => [id, { id, name: id, part: id.startsWith("t") ? "upperbody" : "lowerbody", image: `/${id}.png` }]));
  const look = (id, garmentIds, weather, extra = {}) => ({ id, name: id, status: "accepted", image: `/${id}.png`, occasion: ["casual"], garmentIds, ...(weather ? { weather } : {}), ...extra });
  const outfits = [
    // Oldest wear first without weather, so the reordering is visible.
    look("summer", ["t1", "b1"], { minTempC: 20, maxTempC: 32, rain: "avoid", note: "" }, { wearHistory: [{ id: "1", date: "2026-01-01", garmentIds: ["t1", "b1"] }] }),
    look("unknown", ["t2", "b2"], null, { wearHistory: [{ id: "2", date: "2026-02-01", garmentIds: ["t2", "b2"] }] }),
    look("workable", ["t3", "b3"], { minTempC: 12, maxTempC: 20, rain: "light", note: "" }, { wearHistory: [{ id: "3", date: "2026-03-01", garmentIds: ["t3", "b3"] }] }),
    look("ideal", ["t4", "b4"], { minTempC: 6, maxTempC: 16, rain: "suited", note: "" }, { wearHistory: [{ id: "4", date: "2026-10-01", garmentIds: ["t4", "b4"] }] }),
  ];
  const options = { today: "2026-11-01" };
  const without = outfitShortlist(outfits, itemsById, options);
  assert.deepEqual(without.choices.map((row) => row.outfit.id), ["summer", "unknown", "workable"]);
  assert.deepEqual(without.weatherCounts, { unsuitable: 0, unknown: 0 });
  assert.equal(without.choices[0].weatherFit, null);
  const withWeather = outfitShortlist(outfits, itemsById, { ...options, weatherDay: day({ feelsLow: 7, feelsHigh: 14 }) });
  assert.deepEqual(withWeather.choices.map((row) => [row.outfit.id, row.weatherFit.level]), [["ideal", "good"], ["workable", "fair"], ["unknown", "unknown"]]);
  assert.deepEqual(withWeather.weatherCounts, { unsuitable: 1, unknown: 1 });
  assert.equal(withWeather.matchingCount, 3);
});

test("stored outfits accept weather details and reject malformed ones", () => {
  const outfit = { id: "look", name: "Look", occasion: ["casual"], garmentIds: ["top"], status: "accepted", image: "outfit-images/look.png" };
  assert.doesNotThrow(() => validateManifest({ version: 1, outfits: [{ ...outfit, weather: { ...mild, source: "generated", updatedAt: "2026-11-01T10:00:00.000Z" } }] }));
  assert.throws(() => validateManifest({ version: 1, outfits: [{ ...outfit, weather: { ...mild, minTempC: 30, source: "edited", updatedAt: "2026-11-01T10:00:00.000Z" } }] }), /outfits\[0\]\.weather/);
  assert.throws(() => validateManifest({ version: 1, outfits: [{ ...outfit, weather: null }] }), /outfits\[0\]\.weather/);
});

test("generated outfits request, keep and save weather suitability", async (t) => {
  const h = await harness(t, { analysis: [{ ...plan(1), weather: mild }, { ...plan(2), weather: { ...mild, minTempC: 25 } }] });
  const job = await h.settled((await h.create(2)).id);
  const analysis = h.requests.find((entry) => entry.kind === "analysis").request;
  const schema = analysis.text.format.schema.properties.outfits.items;
  assert.ok(schema.required.includes("weather"));
  assert.deepEqual(schema.properties.weather.required, ["minTempC", "maxTempC", "rain", "note"]);
  assert.match(analysis.input[0].content[0].text, /Weather suitability: minTempC and maxTempC/);
  const [first, second] = job.outfits;
  assert.deepEqual({ ...first.weather, updatedAt: undefined }, { ...mild, source: "generated", updatedAt: undefined });
  assert.equal(second.weather, undefined, "an implausible estimate is dropped without failing the plan");
  assert.equal(job.status, "review");
  await h.action(job, first, "approve");
  const saved = (await h.request("GET", API)).outfits.find((outfit) => outfit.id === first.id);
  assert.deepEqual(saved.weather, first.weather);
});

test("weather estimates fill missing details for saved looks without overwriting others", async (t) => {
  const h = await harness(t);
  const manifestFile = path.join(h.dataDir, "outfits.json");
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  const edited = { minTempC: 0, maxTempC: 8, rain: "suited", note: "", source: "edited", updatedAt: "2026-10-01T10:00:00.000Z" };
  manifest.outfits[2].weather = edited;
  await writeFile(manifestFile, JSON.stringify(manifest));
  h.setAnalysis((request) => {
    const ids = request.text.format.schema.properties.outfits.items.properties.id.enum;
    return respond({ outfits: ids.map((id, index) => ({ id, weather: { ...mild, minTempC: 5 + index } })) });
  });
  const result = await h.request("POST", `${API}/weather/estimate`, { outfitIds: ["original-1", "original-2", "original-3", "missing-look"] });
  assert.deepEqual(result.outfits.map((outfit) => [outfit.id, outfit.weather.minTempC, outfit.weather.source]), [["original-1", 5, "estimated"], ["original-2", 6, "estimated"]]);
  assert.deepEqual(result.skipped.sort(), ["missing-look", "original-3"]);
  assert.match(result.outfits[0].image, /^\/api\/outfits\/images\//);
  const request = h.requests.filter((entry) => entry.kind === "analysis").at(-1).request;
  const images = request.input[0].content.filter((part) => part.type === "input_image");
  assert.equal(images.length, 2);
  assert.ok(images.every((image) => image.detail === "low" && image.image_url.startsWith("data:image/jpeg;base64,")));
  assert.match(request.input[0].content[0].text, /"pieces":\[\{"name":"top-1","part":"upperbody"/);
  const collection = (await h.request("GET", API)).outfits;
  assert.deepEqual(collection.find((outfit) => outfit.id === "original-3").weather, edited);
  assert.equal(collection.find((outfit) => outfit.id === "original-1").weather.minTempC, 5);
  // Nothing left to estimate makes no provider call.
  const calls = h.requests.length;
  assert.deepEqual(await h.request("POST", `${API}/weather/estimate`, { outfitIds: ["original-1"] }), { outfits: [], skipped: ["original-1"] });
  assert.equal(h.requests.length, calls);
});

test("weather estimates validate requests and provider output", async (t) => {
  const h = await harness(t);
  for (const body of [{}, { outfitIds: [] }, { outfitIds: ["a", "a"] }, { outfitIds: ["../x"] }, { outfitIds: ["a", "b", "c", "d", "e", "f", "g"] }]) {
    await h.request("POST", `${API}/weather/estimate`, body, 400);
  }
  for (const invalid of [
    { outfits: [{ id: "original-1", weather: { ...mild, minTempC: 30 } }] },
    { outfits: [{ id: "original-2", weather: mild }] },
    { outfits: [] },
  ]) {
    h.setAnalysis(() => respond(invalid));
    const { status, result } = await h.request("POST", `${API}/weather/estimate`, { outfitIds: ["original-1"] }, null);
    assert.equal(status, 502);
    assert.match(result.error, /invalid weather details/);
  }
  assert.equal((await h.request("GET", API)).outfits.find((outfit) => outfit.id === "original-1").weather, undefined);
});

test("weather estimates require a key, run one at a time and skip looks changed meanwhile", async (t) => {
  const offline = await harness(t, { env: { OPENAI_API_KEY: "" } });
  const missing = await offline.request("POST", `${API}/weather/estimate`, { outfitIds: ["original-1"] }, null);
  assert.equal(missing.status, 503);
  assert.match(missing.result.error, /add weather details to a look yourself/);

  const h = await harness(t);
  let release, entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  h.setAnalysis(async () => { entered(); await gate; return respond({ outfits: [{ id: "original-1", weather: mild }, { id: "original-2", weather: mild }] }); });
  const running = h.request("POST", `${API}/weather/estimate`, { outfitIds: ["original-1", "original-2"] });
  await started;
  const busy = await h.request("POST", `${API}/weather/estimate`, { outfitIds: ["original-3"] }, null);
  assert.equal(busy.status, 429);
  // A manual edit made during the provider call wins.
  const manual = await h.request("POST", `${API}/original-2/weather`, { weather: { minTempC: -5, maxTempC: 5, rain: "suited", note: "Coat" }, expectedUpdatedAt: null });
  release();
  const result = await running;
  assert.deepEqual(result.outfits.map((outfit) => outfit.id), ["original-1"]);
  assert.deepEqual(result.skipped, ["original-2"]);
  assert.deepEqual((await h.request("GET", API)).outfits.find((outfit) => outfit.id === "original-2").weather, manual.weather);
});

test("weather details can be edited, cleared and are protected from stale edits", async (t) => {
  const h = await harness(t);
  const saved = await h.request("POST", `${API}/original-1/weather`, { weather: { ...mild, note: " Linen shirt " }, expectedUpdatedAt: null });
  assert.equal(saved.weather.source, "edited");
  assert.equal(saved.weather.note, "Linen shirt");
  assert.ok(Date.parse(saved.weather.updatedAt));
  assert.match(saved.image, /^\/api\/outfits\/images\//);
  const stale = await h.request("POST", `${API}/original-1/weather`, { weather: mild, expectedUpdatedAt: null }, null);
  assert.equal(stale.status, 409);
  await h.request("POST", `${API}/original-1/weather`, { weather: { ...mild, minTempC: 19 }, expectedUpdatedAt: saved.weather.updatedAt }, 400);
  await h.request("POST", `${API}/original-1/weather`, { weather: mild }, 409);
  await h.request("POST", `${API}/unknown-look/weather`, { weather: mild, expectedUpdatedAt: null }, 404);
  const cleared = await h.request("POST", `${API}/original-1/weather`, { weather: null, expectedUpdatedAt: saved.weather.updatedAt });
  assert.equal(cleared.weather, undefined);
  const file = JSON.parse(await readFile(path.join(h.dataDir, "outfits.json"), "utf8"));
  assert.equal("weather" in file.outfits[0], false);
  assert.equal(file.outfits[0].image, "outfit-images/original-1.png", "stored image references stay unchanged");
  // Weather details survive a restart.
  await h.request("POST", `${API}/original-2/weather`, { weather: mild, expectedUpdatedAt: null });
  await h.restart();
  assert.equal((await h.request("GET", API)).outfits.find((outfit) => outfit.id === "original-2").weather.minTempC, 10);
});
