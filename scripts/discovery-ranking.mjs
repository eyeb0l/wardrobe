import { orderDiscovery } from "../shared/outfit-discovery.mjs";

export const DISCOVERY_BATCH_SIZE = 12;
export const canonicalDiscoveryCandidates = candidates => [...candidates].sort((a, b) => a.id.localeCompare(b.id));
export const discoveryBatches = candidates => Array.from({ length: Math.ceil(candidates.length / DISCOVERY_BATCH_SIZE) },
  (_, index) => candidates.slice(index * DISCOVERY_BATCH_SIZE, (index + 1) * DISCOVERY_BATCH_SIZE));

// Promotion compares scores only within their own cohort. Preserve three
// contenders plus near ties (within .05), capped at half a full batch so that
// larger collections converge. Unknown/weak evidence never gets promoted.
export function promoteDiscoveryBatch(rankings) {
  const ordered = orderDiscovery(rankings);
  const cutoff = ordered[Math.min(2, ordered.length - 1)]?.match;
  return ordered.filter((row, index) => index < 3 || row.match >= cutoff - .05).slice(0, 6);
}

export function maximumDiscoveryCalls(candidateCount) {
  return candidateCount;
}

// Each request sees just one candidate and its own visual evidence. Preserve
// the evaluated absolute rubric, the shared two-request bound and one deadline.
export async function rankDiscovery({ candidates, scoreBatch, ensureActive = () => {} }) {
  const pool = canonicalDiscoveryCandidates(candidates), results = new Array(pool.length);
  let next = 0, failure;
  const check = () => { ensureActive(); if (failure) throw failure; };
  const worker = async () => {
    while (!failure && next < pool.length) {
      const index = next++;
      try {
        check();
        results[index] = await scoreBatch([pool[index]], { phase: "absolute", ensureActive: check });
        check();
      } catch (error) { failure ||= error; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(2, pool.length) }, worker));
  if (failure) throw failure;
  check();
  const rankings = results.flatMap(result => result.rankings);
  return { rankings, scoringMethod: "absolute", candidateRequests: results.length,
    unknownCount: rankings.filter(row => row.evidence === "unknown").length,
    cached: results.every(result => result.cached),
    inputTokens: results.reduce((sum, result) => sum === null || result.inputTokens == null ? null : sum + result.inputTokens, 0) };
}

// Historical batch/finalist baseline, retained for frozen evaluation protocols.
export function maximumBatchedDiscoveryCalls(candidateCount) {
  if (!candidateCount) return 0;
  if (candidateCount <= DISCOVERY_BATCH_SIZE) return 1;
  let count = candidateCount, calls = 0;
  do {
    calls += Math.ceil(count / DISCOVERY_BATCH_SIZE);
    count = Math.floor(count / DISCOVERY_BATCH_SIZE) * 6 + Math.min(count % DISCOVERY_BATCH_SIZE, 6);
  } while (count > DISCOVERY_BATCH_SIZE);
  return calls + 1; // A final shared comparison, unless screening finds no match.
}

export async function rankBatchedDiscovery({ candidates, scoreBatch, ensureActive = () => {}, initialBatches }) {
  if (initialBatches && (!Array.isArray(initialBatches) || initialBatches.some(batch => !Array.isArray(batch) || !batch.length || batch.length > DISCOVERY_BATCH_SIZE)
    || initialBatches.flat().length !== candidates.length || new Set(initialBatches.flat().map(item => item.id)).size !== candidates.length
    || initialBatches.flat().some(item => !candidates.some(candidate => candidate.id === item.id)))) throw new Error("Initial batches must cover every candidate exactly once.");
  let inputTokens = 0, cached = true, comparisonRounds = 0;
  const unknownIds = new Set();
  const scoreRound = async (pool, phase, preset) => {
    const batches = phase === "final" ? discoveryBatches(canonicalDiscoveryCandidates(pool)) : preset || discoveryBatches(pool);
    const results = new Array(batches.length);
    let next = 0, failure;
    const check = () => { ensureActive(); if (failure) throw failure; };
    const worker = async () => {
      while (!failure && next < batches.length) {
        const index = next++;
        try {
          check();
          results[index] = await scoreBatch(batches[index], { phase, ensureActive: check });
        } catch (error) { failure ||= error; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(2, batches.length) }, worker));
    if (failure) throw failure;
    check();
    for (const result of results) {
      inputTokens = inputTokens === null || result.inputTokens === null ? null : inputTokens + result.inputTokens;
      cached &&= result.cached;
      for (const row of result.rankings) if (row.evidence === "unknown") unknownIds.add(row.id);
    }
    comparisonRounds++;
    return { batches, results };
  };
  if (!candidates.length) return { rankings: [], screeningRankings: [], unknownCount: 0, finalistCount: 0, comparisonRounds, inputTokens, cached };
  const first = await scoreRound(candidates, candidates.length <= DISCOVERY_BATCH_SIZE ? "final" : "screening", initialBatches);
  const screeningRankings = first.results.flatMap(result => result.rankings);
  let rankings = screeningRankings;
  if (candidates.length > DISCOVERY_BATCH_SIZE) {
    const promote = round => {
      const byId = new Map(round.batches.flat().map(candidate => [candidate.id, candidate]));
      return round.results.flatMap(result => promoteDiscoveryBatch(result.rankings).map(row => byId.get(row.id)));
    };
    let pool = canonicalDiscoveryCandidates(promote(first));
    // No comparison of scores from different cohorts determines promotion.
    // Extra rounds retain representation when finalists cannot fit one request.
    while (pool.length > DISCOVERY_BATCH_SIZE) pool = canonicalDiscoveryCandidates(promote(await scoreRound(pool, "reduction")));
    rankings = pool.length ? (await scoreRound(pool, "final")).results[0].rankings : [];
  }
  return { rankings, screeningRankings, unknownCount: unknownIds.size, finalistCount: rankings.length, comparisonRounds, inputTokens, cached };
}
