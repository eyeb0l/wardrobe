import path from "node:path";
import { containedFiles } from "./storage-fs.mjs";
import { readManifest, acceptedFilename } from "./outfit-storage.mjs";
import { readLibrary } from "./wardrobe-library.mjs";
import { hashMetadata, jevConfig, rankWithJev } from "./jev.mjs";
import { orderDiscovery } from "../shared/outfit-discovery.mjs";

const API = "/api/outfits/discovery";
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const text = (value, max) => typeof value === "string" ? value.slice(0, max) : "";
const strings = (value, max = 12) => Array.isArray(value) ? value.filter((item) => typeof item === "string").slice(0, max).map((item) => item.slice(0, 80)) : [];
const parts = { upperbody: "top", lowerbody: "bottom", wholebody_up: "outerwear", shoes: "shoes", accessories_up: "accessories", dresses: "dress" };

// Approximate colour names only; Jev must not interpret numerical hex colours.
export function colourName(hex) {
  if (typeof hex !== "string" || !/^#[a-f\d]{6}$/i.test(hex)) return "unknown";
  const [r, g, b] = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min, light = (max + min) / 2;
  if (light < .12) return "black";
  if (light > .93) return "white";
  if (delta < .08) return light > .7 ? "light grey" : light < .35 ? "dark grey" : "grey";
  let hue = delta === 0 ? 0 : max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  hue = (hue * 60 + 360) % 360;
  if (hue >= 15 && hue < 65 && light < .42) return "brown";
  if (hue >= 25 && hue < 65 && light > .65 && delta < .4) return "beige or cream";
  if ((hue < 15 || hue >= 330) && light > .65) return "pink";
  const base = hue < 15 ? "red" : hue < 45 ? "orange" : hue < 70 ? "yellow" : hue < 165 ? "green" : hue < 195 ? "teal" : hue < 255 ? "blue" : hue < 290 ? "purple" : hue < 330 ? "pink" : "red";
  return `${light < .3 ? "dark " : light > .72 ? "light " : ""}${base}`;
}

function garment(record) {
  return { id: record.id, category: parts[record.part], name: text(record.name, 120), colours: [colourName(record.color), ...(record.secondaryColor ? [colourName(record.secondaryColor)] : [])], tags: strings(record.tags) };
}

async function snapshot(dataDir) {
  const records = await readLibrary(path.join(dataDir, "library.json"));
  const candidates = records.filter((item) => item && !item.hidden && !item.deleted && /^[a-z0-9][a-z0-9-]{0,159}$/.test(item.id) && Object.hasOwn(parts, item.part))
    .map((record) => ({ record, filename: record.image?.match?.(/^\/api\/import\/library\/([a-z0-9][a-z0-9._-]*\.(?:png|jpe?g|webp))$/i)?.[1] })).filter(({ filename }) => filename);
  const files = await containedFiles(path.join(dataDir, "imported"), candidates.map(({ filename }) => filename));
  const items = new Map();
  for (const { record, filename } of candidates) if (files.has(filename) && !items.has(record.id)) items.set(record.id, record);
  const saved = (await readManifest(dataDir)).outfits.filter((outfit) => outfit.status === "accepted");
  const photos = await containedFiles(path.join(dataDir, "outfit-images"), saved.map((outfit) => acceptedFilename(outfit.image)));
  const outfits = saved.filter((outfit) => photos.has(acceptedFilename(outfit.image)) && outfit.garmentIds.every((id) => items.has(id)));
  const usage = new Map();
  for (const outfit of saved) for (const id of outfit.garmentIds) usage.set(id, (usage.get(id) || 0) + 1);
  return { items, outfits, usage, fingerprint: hashMetadata([candidates.filter(({ record, filename }) => items.has(record.id) && files.has(filename)).map(({ record }) => record), saved, outfits.map((outfit) => outfit.id)]) };
}

function outfitMetadata(outfit, items) {
  return { id: outfit.id, name: text(outfit.name, 120), occasions: strings(outfit.occasion), stylingNotes: text(outfit.reason, 600), garments: outfit.garmentIds.map((id) => garment(items.get(id))) };
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 4096) throw fail("The discovery request is too large.", 413);
    chunks.push(bytes);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw fail("Expected a JSON object."); }
  if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.brief !== "string" || !body.brief.trim() || body.brief.length > 500) throw fail("Describe what you want in 1–500 characters.");
  return { ...body, brief: body.brief.trim().replace(/\s+/g, " ") };
}

export function wardrobeDiscoveryApi(options = {}) {
  const env = { ...process.env, ...options.env };
  let dataDir;
  const send = (res, status, value) => { res.statusCode = status; res.setHeader("Content-Type", "application/json"); res.setHeader("Cache-Control", "private, no-store"); res.end(JSON.stringify(value)); };
  async function handler(req, res, next) {
    const pathname = new URL(req.url, "http://localhost").pathname;
    if (pathname !== API && !pathname.startsWith(`${API}/`)) return next();
    let disconnected = false;
    const onDisconnect = () => { if (!res.writableEnded) disconnected = true; };
    const ensureConnected = () => { if (disconnected || req.aborted || res.destroyed) throw fail("Discovery was cancelled.", 499); };
    req.once?.("aborted", onDisconnect);
    res.once?.("close", onDisconnect);
    try {
      if (pathname === `${API}/config` && req.method === "GET") return send(res, 200, jevConfig(env));
      if (![`${API}/rank`, `${API}/swaps`].includes(pathname)) throw fail("Not found", 404);
      if (req.method !== "POST") throw fail("Method not allowed", 405);
      if (req.headers?.["sec-fetch-site"] === "cross-site") throw fail("Cross-site requests are not allowed", 403);
      if (req.headers?.origin) {
        let origin;
        try { origin = new URL(req.headers.origin); } catch { throw fail("Invalid request origin", 403); }
        if (!["http:", "https:"].includes(origin.protocol) || origin.host !== req.headers.host) throw fail("Cross-site requests are not allowed", 403);
      }
      if (!req.headers?.["content-type"]?.toLowerCase().startsWith("application/json")) throw fail("Use application/json", 415);
      if (!jevConfig(env).ready) throw fail("Outfit discovery is not configured. You can still browse your saved outfits.", 503);
      const input = await readBody(req);
      const source = await snapshot(dataDir);
      let context = { mode: "saved outfits", note: "Only recorded metadata is available. Colours are approximate names. No photographs have been examined." };
      let candidates = source.outfits.map((outfit) => outfitMetadata(outfit, source.items));
      let novelty = new Map(source.outfits.map((outfit) => [outfit.id, outfit.garmentIds.reduce((sum, id) => sum + 1 / (1 + (source.usage.get(id) || 0)), 0) / outfit.garmentIds.length]));
      if (pathname.endsWith("/swaps")) {
        const outfit = source.outfits.find((item) => item.id === input.outfitId);
        if (!outfit) throw fail("This saved outfit or one of its pieces is no longer available. Refresh your collection.", 409);
        if (!outfit.garmentIds.includes(input.garmentId)) throw fail("Choose a piece from this outfit to replace.");
        const original = source.items.get(input.garmentId);
        context = { ...context, mode: "replace one piece", original: garment(original), fixedPieces: outfit.garmentIds.filter((id) => id !== original.id).map((id) => garment(source.items.get(id))) };
        candidates = [...source.items.values()].filter((item) => item.part === original.part && !outfit.garmentIds.includes(item.id)).map(garment);
        novelty = new Map(candidates.map(({ id }) => [id, 1 / (1 + (source.usage.get(id) || 0))]));
      }
      // Small batches bound state size without silently shortlisting the library.
      // One deadline bounds the entire interaction, including cold/cache misses.
      const deadline = Date.now() + Math.min(options.timeoutMs ?? 12_000, 12_000);
      const rankings = [];
      let inputTokens = 0, cached = true;
      for (let offset = 0; offset < candidates.length; offset += 12) {
        ensureConnected();
        if (Date.now() >= deadline) throw fail("Outfit discovery took too long. Please try again.", 504);
        const result = await rankWithJev({ brief: input.brief, context, candidates: candidates.slice(offset, offset + 12), namespace: [dataDir, source.fingerprint], env, fetch: options.fetch, beforePaidCall: async (kind) => { ensureConnected(); await options.beforePaidCall?.(kind); }, timeoutMs: Math.max(1, deadline - Date.now()) });
        rankings.push(...result.rankings.map((row) => ({ ...row, novelty: novelty.get(row.id) || 0 })));
        inputTokens = inputTokens === null || result.inputTokens === null ? null : inputTokens + result.inputTokens;
        cached &&= result.cached;
      }
      ensureConnected();
      // Deletions, edits and changed membership invalidate even an in-flight call.
      if ((await snapshot(dataDir)).fingerprint !== source.fingerprint) throw fail("Your wardrobe changed during the search. Please try again.", 409);
      return send(res, 200, { rankings, rankedIds: orderDiscovery(rankings).map(({ id }) => id), unknownCount: rankings.filter((row) => row.evidence === "unknown").length, candidateCount: candidates.length, cached, inputTokens });
    } catch (error) {
      if (!res.destroyed && !res.writableEnded) return send(res, error.status || 503, { error: error.status ? error.message : "Outfit discovery is unavailable. You can still browse your saved outfits." });
    } finally {
      req.off?.("aborted", onDisconnect);
      res.off?.("close", onDisconnect);
    }
  }
  return { name: "wardrobe-discovery-api", apply: "serve", configResolved(config) { dataDir = path.resolve(config.root, env.WARDROBE_DATA_DIR || "data"); }, configureServer(server) { server.middlewares.use(handler); }, configurePreviewServer(server) { server.middlewares.use(handler); } };
}
