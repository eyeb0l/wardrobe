import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { mkdir, readFile, readdir } from './storage-fs.mjs';
import { atomicJson } from './outfit-storage.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const token = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,100}$/.test(value) ? value : null;
const refusalCodes = new Set(['content_policy_violation', 'moderation_blocked', 'safety_violation', 'safety_system', 'content_filter', 'refusal']);
let warned = false;
async function persist(dataDir, record) {
  try {
    const dir = path.join(dataDir, 'generation-telemetry');
    await mkdir(dir, { recursive: true });
    await atomicJson(path.join(dir, `${record.id}.json`), record);
  } catch {
    // A telemetry outage must never cause another paid generation or lose an image.
    if (!warned) { warned = true; console.warn('Generation telemetry could not be saved; reporting coverage may be incomplete.'); }
  }
}
export function garmentTelemetry(item) {
  const text = `${item.name || ''} ${(Array.isArray(item.tags) ? item.tags : []).join(' ')}`.toLowerCase();
  const subtype = /\bbodysuits?\b/.test(text) ? 'bodysuit' : /\bskirts?\b/.test(text) ? 'skirt' : null;
  return { id: item.id, category: item.part || 'unknown', subtype, subtypeSource: subtype ? 'name-or-tags-v1' : null };
}
export function providerTelemetry(baseUrl) {
  try { return new URL(baseUrl).hostname.toLowerCase(); } catch { return 'unknown'; }
}
export function apiTelemetry(response, result) {
  const code = token(result?.error?.code);
  const type = token(result?.error?.type);
  const data = Array.isArray(result?.data) ? result.data : [];
  const output = Array.isArray(result?.output) ? result.output : [];
  const explicitRefusal = Boolean(result?.refusal || data.some(item => item?.refusal)
    || output.some(item => item?.type === 'refusal' || (Array.isArray(item?.content) && item.content.some(content => content?.type === 'refusal'))));
  return { httpStatus: response.status, apiCode: code, apiType: type,
    refused: explicitRefusal || refusalCodes.has(code) || refusalCodes.has(type) };
}

export function generationAttempt(dataDir, context) {
  let record;
  return {
    async start({ model, baseUrl, prompt, images = [] }) {
      record = { version: 1, kind: 'attempt', id: randomUUID(), ...context,
        provider: providerTelemetry(baseUrl), model, promptHash: hash(prompt),
        referencesHash: hash(images.map(image => hash(image)).join(':')), startedAt: new Date().toISOString(),
        outcome: 'unknown', httpStatus: null, apiCode: null, apiType: null };
      await persist(dataDir, record);
    },
    observe(response, result) { if (record) Object.assign(record, apiTelemetry(response, result)); },
    async finish(succeeded, error) {
      if (!record) return;
      record.outcome = record.refused ? 'refused' : succeeded ? 'succeeded' : 'technical_failure';
      record.errorKind = succeeded ? null : token(error?.name) || 'Error';
      record.finishedAt = new Date().toISOString();
      await persist(dataDir, record);
    },
  };
}

export async function manualTelemetry(dataDir, context, uploadId, action) {
  await persist(dataDir, { version: 1, kind: 'manual', ...context,
    id: hash(`${context.episodeId}:${uploadId}:${action}`), uploadId, action, at: new Date().toISOString() });
}

export async function readTelemetry(dataDir) {
  const dir = path.join(dataDir, 'generation-telemetry');
  let names;
  try { names = await readdir(dir); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  // Fail visibly on corrupt records rather than silently biasing the denominator.
  const files = names.filter(name => /^[a-f0-9-]+\.json$/.test(name));
  const records = [];
  for (let offset = 0; offset < files.length; offset += 50) {
    records.push(...await Promise.all(files.slice(offset, offset + 50).map(async name => JSON.parse(await readFile(path.join(dir, name), 'utf8')))));
  }
  if (records.some(record => !record || record.version !== 1 || typeof record.id !== 'string' || typeof record.episodeId !== 'string' || !record.episodeId
    || !Array.isArray(record.garments) || record.garments.some(g => !g || typeof g.id !== 'string' || typeof g.category !== 'string')
    || (record.kind === 'attempt' ? !['succeeded', 'refused', 'technical_failure', 'unknown'].includes(record.outcome)
      || !Number.isInteger(record.attemptNumber) || record.attemptNumber < 1 || !Number.isFinite(Date.parse(record.startedAt))
      : record.kind !== 'manual' || !['uploaded', 'approved'].includes(record.action) || !Number.isFinite(Date.parse(record.at))))) throw new Error('Invalid generation telemetry record');
  return records;
}
const rate = (numerator, denominator) => ({ numerator, denominator, rate: denominator ? numerator / denominator : null });
function metrics(episodes, hardRefusalAttempts) {
  const generated = episodes.filter(ep => ep.attempts.length);
  const firstKnown = generated.filter(ep => ep.attempts[0].attemptNumber === 1 && ep.attempts[0].outcome !== 'unknown');
  const initiallyRefused = firstKnown.filter(ep => ep.attempts[0].outcome === 'refused');
  const retried = initiallyRefused.filter(ep => ep.attempts.slice(1).some(a => a.outcome !== 'unknown'));
  const secondKnown = initiallyRefused.filter(ep => ep.attempts[1]?.attemptNumber === 2 && ep.attempts[1].outcome !== 'unknown');
  const recovered = ep => ep.attempts.slice(1).some(a => a.outcome === 'succeeded');
  const sameModelRecovered = ep => ep.attempts.slice(1).some(a => a.outcome === 'succeeded' && a.model === ep.attempts[0].model && a.provider === ep.attempts[0].provider);
  const hard = initiallyRefused.filter(ep => ep.attempts.length >= hardRefusalAttempts && ep.attempts.every((a, index) => a.outcome === 'refused' && a.attemptNumber === index + 1));
  const attempts = generated.flatMap(ep => ep.attempts);
  const fallback = ep => ep.manual.some(e => e.action === 'uploaded' && ep.attempts.some(a => a.outcome === 'refused' && a.startedAt <= e.at) && !ep.attempts.some(a => a.outcome === 'succeeded' && a.startedAt <= e.at));
  return {
    episodes: episodes.length, imageEpisodes: generated.length, incompleteEpisodes: generated.filter(ep => ep.attempts.some((a, index) => a.attemptNumber !== index + 1)).length, smallSample: firstKnown.length < 30,
    firstAttemptSuccess: rate(firstKnown.filter(ep => ep.attempts[0].outcome === 'succeeded').length, firstKnown.length),
    firstAttemptRefusal: rate(initiallyRefused.length, firstKnown.length),
    attemptRefusal: rate(attempts.filter(a => a.outcome === 'refused').length, attempts.filter(a => a.outcome !== 'unknown').length),
    secondAttemptRecovery: rate(secondKnown.filter(ep => ep.attempts[1].outcome === 'succeeded').length, secondKnown.length),
    eventualRetryRecovery: rate(retried.filter(recovered).length, retried.length),
    sameModelRetryRecovery: rate(retried.filter(sameModelRecovered).length, retried.length),
    recoveryAmongAllInitiallyRefused: rate(initiallyRefused.filter(recovered).length, initiallyRefused.length),
    observedHardRefusal: rate(hard.length, firstKnown.length),
    initiallyRefused: initiallyRefused.length,
    refusedWithoutRetry: initiallyRefused.filter(ep => ep.attempts.length === 1).length,
    unknownAttempts: attempts.filter(a => a.outcome === 'unknown').length,
    technicalFailures: attempts.filter(a => a.outcome === 'technical_failure').length,
    retriesWithChangedInputs: generated.filter(ep => ep.attempts.slice(1).some(a => a.promptHash !== ep.attempts[0].promptHash || a.referencesHash !== ep.attempts[0].referencesHash || a.model !== ep.attempts[0].model || a.provider !== ep.attempts[0].provider)).length,
    manualUploadEpisodes: episodes.filter(ep => ep.manual.some(e => e.action === 'uploaded')).length,
    manualApprovedEpisodes: episodes.filter(ep => ep.manual.some(e => e.action === 'approved')).length,
    manualAfterRefusalEpisodes: episodes.filter(fallback).length,
    manualFallbackUsage: rate(episodes.filter(fallback).length, generated.filter(ep => ep.attempts.some(a => a.outcome === 'refused')).length),
  };
}
export function summarizeTelemetry(records, { hardRefusalAttempts = 3 } = {}) {
  if (!Number.isInteger(hardRefusalAttempts) || hardRefusalAttempts < 2) throw new Error('Hard refusal threshold must be at least two attempts');
  const groups = new Map();
  for (const record of records) {
    if (!groups.has(record.episodeId)) groups.set(record.episodeId, { attempts: [], manual: [] });
    groups.get(record.episodeId)[record.kind === 'attempt' ? 'attempts' : 'manual'].push(record);
  }
  const episodes = [...groups.values()];
  for (const ep of episodes) ep.attempts.sort((a, b) => a.attemptNumber - b.attemptNumber || a.startedAt.localeCompare(b.startedAt));
  const cohorts = new Map();
  for (const ep of episodes) {
    const first = ep.attempts[0] || ep.manual[0];
    const categories = new Set((first.garments || []).flatMap(g => [`category:${g.category}`, ...(g.subtype ? [`subtype:${g.subtype}`] : [])]));
    for (const category of ['all', ...categories]) {
      const dimensions = { provider: first.provider || null, model: first.model || null, generationType: first.generationType, category };
      const key = JSON.stringify(dimensions);
      if (!cohorts.has(key)) cohorts.set(key, { dimensions, episodes: [] });
      cohorts.get(key).episodes.push(ep);
    }
  }
  const apiOutcomes = new Map();
  for (const record of records.filter(record => record.kind === 'attempt')) {
    const dimensions = { provider: record.provider, model: record.model, generationType: record.generationType, outcome: record.outcome, httpStatus: record.httpStatus, apiCode: record.apiCode, apiType: record.apiType };
    const key = JSON.stringify(dimensions);
    if (!apiOutcomes.has(key)) apiOutcomes.set(key, { ...dimensions, count: 0 });
    apiOutcomes.get(key).count++;
  }
  return { version: 1, apiOutcomes: [...apiOutcomes.values()], generatedAt: new Date().toISOString(), hardRefusalAttempts,
    overall: metrics(episodes, hardRefusalAttempts),
    cohorts: [...cohorts.values()].map(c => ({ ...c.dimensions, ...metrics(c.episodes, hardRefusalAttempts) })) };
}
