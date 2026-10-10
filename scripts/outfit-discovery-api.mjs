import path from "node:path";
import { containedFiles } from "./storage-fs.mjs";
import { readManifest, acceptedFilename } from "./outfit-storage.mjs";
import { readLibrary } from "./wardrobe-library.mjs";
import { hashEvidence, decisionsConfig } from "./decisions.mjs";
import { rankWithDecisions } from "./decision-ranking.mjs";
import { decisionUsageLog } from "./decision-usage.mjs";
import { prepareEvidence, evidenceUnchanged } from "./decision-images.mjs";
import { orderDiscovery } from "../shared/outfit-discovery.mjs";
import { rankDiscovery } from "./discovery-ranking.mjs";

const API = "/api/outfits/discovery";
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const text = (value, max) => typeof value === "string" ? value.slice(0, max) : "";
const strings = (value, max = 12) => Array.isArray(value) ? value.filter((item) => typeof item === "string").slice(0, max).map((item) => item.slice(0, 80)) : [];
const parts = { upperbody: "top", lowerbody: "bottom", wholebody_up: "outerwear", shoes: "shoes", accessories_up: "accessories", dresses: "dress" };

// Names supplement the actual visual evidence; never infer fabric from a hex.
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
  const [records, manifest] = await Promise.all([
    readLibrary(path.join(dataDir, "library.json")), readManifest(dataDir),
  ]);
  const candidates = records.filter((item) => item && !item.hidden && !item.deleted && /^[a-z0-9][a-z0-9-]{0,159}$/.test(item.id) && Object.hasOwn(parts, item.part))
    .map((record) => ({ record, filename: record.image?.match?.(/^\/api\/import\/library\/([a-z0-9][a-z0-9._-]*\.(?:png|jpe?g|webp))$/i)?.[1] })).filter(({ filename }) => filename);
  const saved = manifest.outfits.filter((outfit) => outfit.status === "accepted");
  const [files, photos] = await Promise.all([
    containedFiles(path.join(dataDir, "imported"), candidates.map(({ filename }) => filename)),
    containedFiles(path.join(dataDir, "outfit-images"), saved.map((outfit) => acceptedFilename(outfit.image))),
  ]);
  const items = new Map(), itemFiles = new Map();
  for (const { record, filename } of candidates) if (files.has(filename) && !items.has(record.id)) {
    items.set(record.id, record); itemFiles.set(record.id, files.get(filename));
  }
  const outfits = saved.filter((outfit) => photos.has(acceptedFilename(outfit.image)) && outfit.garmentIds.every((id) => items.has(id)));
  const usage = new Map();
  for (const outfit of saved) for (const id of outfit.garmentIds) usage.set(id, (usage.get(id) || 0) + 1);
  const outfitFiles = new Map(outfits.map(outfit => [outfit.id, photos.get(acceptedFilename(outfit.image))]));
  return { items, itemFiles, outfitFiles, outfits, usage, fingerprint: hashEvidence([candidates.filter(({ record, filename }) => items.has(record.id) && files.has(filename)).map(({ record }) => record), saved, [...itemFiles], [...outfitFiles]]) };
}

function outfitMetadata(outfit, items) {
  return { id: outfit.id, name: text(outfit.name, 120), occasions: strings(outfit.occasion), stylingNotes: text(outfit.reason, 600), garments: outfit.garmentIds.map((id) => garment(items.get(id))) };
}

// Shared with the offline-first batch-sensitivity evaluator. All candidates and
// image paths still come from the validated, available private collection.
export async function loadDiscoverySubject(dataDir, input) {
  const source = await snapshot(dataDir);
  let context = { mode: "saved outfits", note: "Compare labeled saved photographs and actual garment cutouts. Colours in metadata are approximate names." };
  let swapOutfit;
  let candidates = source.outfits.map(outfit => outfitMetadata(outfit, source.items));
  let novelty = new Map(source.outfits.map(outfit => [outfit.id, outfit.garmentIds.reduce((sum, id) => sum + 1 / (1 + (source.usage.get(id) || 0)), 0) / outfit.garmentIds.length]));
  if (input.outfitId || input.garmentId) {
    const outfit = source.outfits.find(item => item.id === input.outfitId);
    if (!outfit) throw fail("This saved outfit or one of its pieces is no longer available. Refresh your collection.", 409);
    if (!outfit.garmentIds.includes(input.garmentId)) throw fail("Choose a piece from this outfit to replace.");
    const original = source.items.get(input.garmentId);
    swapOutfit = outfit;
    context = { ...context, mode: "replace one piece", original: garment(original), fixedPieces: outfit.garmentIds.filter(id => id !== original.id).map(id => garment(source.items.get(id))) };
    candidates = [...source.items.values()].filter(item => item.part === original.part && !outfit.garmentIds.includes(item.id)).map(garment);
    novelty = new Map(candidates.map(({ id }) => [id, 1 / (1 + (source.usage.get(id) || 0))]));
  }
  return { source, context, swapOutfit, candidates, novelty, input };
}

export async function prepareDiscoveryBatch({ source, context, swapOutfit, input }, batch, phase) {
  const entries = [];
  const add = (label, file) => { entries.push({ label, file }); return label; };
  const batchContext = { ...structuredClone(context), comparisonStage: phase };
  if (swapOutfit) {
    batchContext.savedPhoto = add("original_outfit", source.outfitFiles.get(swapOutfit.id));
    batchContext.original.visualEvidence = [add("original_piece", source.itemFiles.get(input.garmentId))];
    batchContext.fixedPieces.forEach((piece, index) => { piece.visualEvidence = [add(`fixed_${index}`, source.itemFiles.get(piece.id))]; });
  }
  const garmentLabels = new Map();
  const candidates = batch.map((candidate, index) => {
    const copy = structuredClone(candidate);
    copy.visualEvidence = [add(`candidate_${index}`, (swapOutfit ? source.itemFiles : source.outfitFiles).get(candidate.id))];
    copy.garments?.forEach(piece => {
      if (!garmentLabels.has(piece.id)) garmentLabels.set(piece.id, add(`garment_${garmentLabels.size}`, source.itemFiles.get(piece.id)));
      piece.visualEvidence = [garmentLabels.get(piece.id)];
    });
    return copy;
  });
  return { context: batchContext, candidates, images: await prepareEvidence(entries) };
}

export async function discoverySubjectUnchanged(dataDir, subject, images) {
  return (await snapshot(dataDir)).fingerprint === subject.source.fingerprint && await evidenceUnchanged(images);
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
      if (pathname === `${API}/config` && req.method === "GET") return send(res, 200, decisionsConfig(env));
      if (![`${API}/rank`, `${API}/swaps`].includes(pathname)) throw fail("Not found", 404);
      if (req.method !== "POST") throw fail("Method not allowed", 405);
      if (req.headers?.["sec-fetch-site"] === "cross-site") throw fail("Cross-site requests are not allowed", 403);
      if (req.headers?.origin) {
        let origin;
        try { origin = new URL(req.headers.origin); } catch { throw fail("Invalid request origin", 403); }
        if (!["http:", "https:"].includes(origin.protocol) || origin.host !== req.headers.host) throw fail("Cross-site requests are not allowed", 403);
      }
      if (!req.headers?.["content-type"]?.toLowerCase().startsWith("application/json")) throw fail("Use application/json", 415);
      if (!decisionsConfig(env).ready) throw fail("Outfit discovery is not configured. You can still browse your saved outfits.", 503);
      const input = await readBody(req);
      if (pathname.endsWith("/swaps") && (!input.outfitId || !input.garmentId)) throw fail("Choose a saved outfit and piece to replace.");
      const subject = await loadDiscoverySubject(dataDir, pathname.endsWith("/swaps") ? input : { brief: input.brief });
      const { source, candidates, novelty, swapOutfit } = subject;
      // All independent candidate judgments share one deadline.
      const deadline = Date.now() + Math.min(options.timeoutMs ?? 12_000, 12_000);
      const usedImages = new Map();
      const ensureActive = () => {
        ensureConnected();
        if (Date.now() >= deadline) throw fail("Outfit discovery took too long. Please try again.", 504);
      };
      const scoreBatch = async (batch, { phase, ensureActive: check }) => {
        check();
        const { context, candidates, images } = await prepareDiscoveryBatch(subject, batch, phase);
        for (const image of images) {
          if (usedImages.has(image.file) && usedImages.get(image.file).identity !== image.identity) throw fail("Your wardrobe images changed during the search. Please try again.", 409);
          usedImages.set(image.file, image);
        }
        check();
        const validate = async () => {
          check();
          if (!(await discoverySubjectUnchanged(dataDir, subject, images))) throw fail("Your wardrobe changed during the search. Please try again.", 409);
        };
        return rankWithDecisions({ brief: input.brief, context, candidates, images,
          usageLog: decisionUsageLog(dataDir, swapOutfit ? "owned-piece-swap" : "saved-look-search"),
          namespace: [dataDir, source.fingerprint], env, fetch: options.fetch, withDecisionLease: options.withDecisionLease,
          outsideLease: options.outsideLease ? callback => options.outsideLease(callback, validate) : undefined,
          beforePaidCall: async kind => { await validate(); await options.beforePaidCall?.(kind); check(); }, timeoutMs: Math.max(1, deadline - Date.now()) });
      };
      const result = await rankDiscovery({ candidates, scoreBatch, ensureActive });
      const rankings = result.rankings.map(row => ({ ...row, novelty: novelty.get(row.id) || 0 }));
      ensureConnected();
      // Deletions, edits and changed membership invalidate even an in-flight call.
      if (!(await discoverySubjectUnchanged(dataDir, subject, [...usedImages.values()]))) throw fail("Your wardrobe changed during the search. Please try again.", 409);
      return send(res, 200, { rankings, rankedIds: orderDiscovery(rankings).map(({ id }) => id), unknownCount: result.unknownCount, candidateCount: candidates.length, scoringMethod: result.scoringMethod, cached: result.cached, inputTokens: result.inputTokens });
    } catch (error) {
      if (!res.destroyed && !res.writableEnded) return send(res, error.status || 503, { error: error.status ? error.message : "Outfit discovery is unavailable. You can still browse your saved outfits." });
    } finally {
      req.off?.("aborted", onDisconnect);
      res.off?.("close", onDisconnect);
    }
  }
  return { name: "wardrobe-discovery-api", apply: "serve", configResolved(config) { dataDir = path.resolve(config.root, env.WARDROBE_DATA_DIR || "data"); }, configureServer(server) { server.middlewares.use(handler); }, configurePreviewServer(server) { server.middlewares.use(handler); } };
}
