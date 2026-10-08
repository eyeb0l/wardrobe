import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { orderDiscovery } from "../shared/outfit-discovery.mjs";
import { canonicalDiscoveryCandidates, discoveryBatches, maximumBatchedDiscoveryCalls, promoteDiscoveryBatch, rankBatchedDiscovery, rankDiscovery } from "./discovery-ranking.mjs";
import { loadDiscoverySubject } from "./outfit-discovery-api.mjs";
import { shuffledCandidates } from "./discovery-sensitivity.mjs";

const insist = (value, message) => { if (!value) throw new Error(message); };
export const COMPARISON_PROTOCOL = Object.freeze({ version: 1, methods: ["absolute", "current", "shuffled-consensus"],
  repeats: 2, currentSeeds: [null, 1, 2], consensusSeeds: [[1, 2, 3], [11, 12, 13]],
  shortlistLimit: 12, suitabilityCutoff: .5, relevantGrade: 2, k: 3,
  note: "Freeze before human labeling. Do not tune on these cases or send human labels/preferences to the provider." });

export function comparisonVariants() {
  return [
    { method: "absolute", variant: "one-item-at-a-time" },
    ...COMPARISON_PROTOCOL.currentSeeds.map(seed => ({ method: "current", variant: seed === null ? "original" : `shuffle-${seed}`, seed })),
    ...COMPARISON_PROTOCOL.consensusSeeds.map((seeds, index) => ({ method: "shuffled-consensus", variant: `ensemble-${index + 1}`, seeds })),
  ];
}

export function maximumComparisonCalls(count) {
  const perRepeat = count + COMPARISON_PROTOCOL.currentSeeds.length * maximumBatchedDiscoveryCalls(count)
    + COMPARISON_PROTOCOL.consensusSeeds.reduce((sum, seeds) => sum + seeds.length * Math.ceil(count / 12) + 1, 0);
  return perRepeat * COMPARISON_PROTOCOL.repeats;
}

export async function initializeDiscoveryComparison({ dataDir, manifestPath, briefs }) {
  insist(briefs?.length > 0 && briefs.length <= 10 && briefs.every(brief => typeof brief === "string" && brief.trim() && brief.length <= 500), "Supply bounded nonempty briefs.");
  const subjects = await Promise.all(briefs.map(brief => loadDiscoverySubject(dataDir, { brief: brief.trim() })));
  insist(subjects.every(subject => subject.candidates.length > 12 && subject.candidates.length <= 100), "Comparison cases need 13..100 available saved looks.");
  const manifest = { version: 1, dataDir: path.resolve(dataDir), protocol: structuredClone(COMPARISON_PROTOCOL),
    cases: subjects.map((subject, index) => ({ id: `case-${index + 1}`, brief: briefs[index].trim(), snapshotHash: subject.source.fingerprint,
      candidates: shuffledCandidates(subject.candidates, 93 + index).map(item => ({ id: item.id, relevance: null, preferred: false })),
      noneSuitable: false, review: { humanReviewed: false, reviewedAt: null } })) };
  await mkdir(path.dirname(manifestPath), { recursive: true, mode: 0o700 });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return { manifestPath: path.resolve(manifestPath), cases: manifest.cases.length,
    judgments: manifest.cases.reduce((sum, item) => sum + item.candidates.length, 0),
    maximumProviderCalls: subjects.reduce((sum, subject) => sum + maximumComparisonCalls(subject.candidates.length), 0), providerCalls: 0 };
}

export function validateComparisonManifest(manifest, { reviewed = false } = {}) {
  insist(manifest?.version === 1 && typeof manifest.dataDir === "string" && JSON.stringify(manifest.protocol) === JSON.stringify(COMPARISON_PROTOCOL)
    && Array.isArray(manifest.cases) && manifest.cases.length > 0 && manifest.cases.length <= 10, "Invalid or altered comparison protocol.");
  const caseIds = new Set();
  for (const item of manifest.cases) {
    insist(/^case-[0-9]+$/.test(item.id) && !caseIds.has(item.id) && typeof item.brief === "string" && item.brief.trim() && item.brief.length <= 500
      && /^[a-f0-9]{64}$/.test(item.snapshotHash) && Array.isArray(item.candidates) && item.candidates.length > 12 && item.candidates.length <= 100, "Invalid comparison case.");
    caseIds.add(item.id);
    const ids = new Set();
    for (const candidate of item.candidates) {
      insist(typeof candidate.id === "string" && /^[a-z0-9][a-z0-9-]{0,159}$/.test(candidate.id) && !ids.has(candidate.id)
        && (candidate.relevance === null || candidate.relevance === "unknown" || [0, 1, 2, 3].includes(candidate.relevance))
        && typeof candidate.preferred === "boolean", "Invalid human label.");
      ids.add(candidate.id);
      insist(!candidate.preferred || [2, 3].includes(candidate.relevance), "Preferred picks must be graded good or excellent.");
    }
    insist(typeof item.noneSuitable === "boolean" && typeof item.review?.humanReviewed === "boolean", "Invalid review status.");
    if (reviewed) {
      insist(item.review.humanReviewed && !Number.isNaN(Date.parse(item.review.reviewedAt)) && item.candidates.every(candidate => candidate.relevance !== null), "Complete and confirm human review before any paid comparison.");
      const preferred = item.candidates.filter(candidate => candidate.preferred);
      insist(preferred.length <= 3 && (item.noneSuitable ? preferred.length === 0 && !item.candidates.some(candidate => [2, 3].includes(candidate.relevance)) : preferred.length > 0), "Mark up to three preferred picks or explicitly indicate that none are suitable.");
    }
  }
  return manifest;
}

export function scoreHumanAgreement(rankings, item) {
  insist(item.candidates.every(candidate => candidate.relevance === "unknown" || [0, 1, 2, 3].includes(candidate.relevance)), "Complete human labels before scoring accuracy.");
  const labels = new Map(item.candidates.filter(candidate => candidate.relevance !== "unknown").map(candidate => [candidate.id, candidate]));
  const ordered = orderDiscovery(rankings), top = ordered.filter(row => labels.has(row.id)).slice(0, 3);
  const gain = grade => 2 ** grade - 1;
  const dcg = grades => grades.reduce((sum, grade, index) => sum + gain(grade) / Math.log2(index + 2), 0);
  const ideal = dcg([...labels.values()].map(row => row.relevance).sort((a, b) => b - a).slice(0, 3));
  const preferred = item.candidates.filter(candidate => candidate.preferred).map(candidate => candidate.id);
  const idealPrecision = Math.min(3, [...labels.values()].filter(row => row.relevance >= 2).length) / 3;
  return { ndcgAtThree: ideal ? dcg(top.map(row => labels.get(row.id).relevance)) / ideal : null,
    precisionAtThree: idealPrecision ? top.filter(row => labels.get(row.id).relevance >= 2).length / 3 : null,
    preferredRecallAtThree: preferred.length ? preferred.filter(id => top.some(row => row.id === id)).length / preferred.length : null,
    winnerPreferred: preferred.length ? !!top.length && preferred.includes(top[0].id) : null,
    noneSuitableAgreement: item.noneSuitable ? ordered.length === 0 : null,
    returnedCandidates: ordered.length, humanUnknownCandidates: item.candidates.length - labels.size,
    ignoredHumanUnknownResults: ordered.filter(row => !labels.has(row.id)).length,
    interpretation: "Agreement with the reviewer on these cases; unknown human labels are omitted from relevance metrics. Stability is reported separately." };
}

async function scoreGroups(groups, scoreBatch, ensureActive, phase) {
  let next = 0, failure;
  const results = new Array(groups.length);
  const check = () => { ensureActive(); if (failure) throw failure; };
  const worker = async () => {
    while (!failure && next < groups.length) {
      const index = next++;
      try { check(); results[index] = await scoreBatch(groups[index], { phase, ensureActive: check }); }
      catch (error) { failure ||= error; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(2, groups.length) }, worker));
  if (failure) throw failure;
  check(); return results;
}

export async function rankComparisonApproach({ candidates, method, seeds, scoreBatch, ensureActive = () => {} }) {
  if (method === "current") return rankBatchedDiscovery({ candidates, scoreBatch, ensureActive });
  insist(["absolute", "shuffled-consensus"].includes(method), "Unknown comparison method.");
  if (method === "absolute") {
    return rankDiscovery({ candidates, scoreBatch, ensureActive });
  }
  insist(Array.isArray(seeds) && seeds.length === 3 && new Set(seeds).size === 3, "Consensus uses three frozen shuffle seeds.");
  const groups = seeds.flatMap(seed => discoveryBatches(shuffledCandidates(candidates, seed)));
  const results = await scoreGroups(groups, scoreBatch, ensureActive, "screening");
  const support = new Map(candidates.map(candidate => [candidate.id, { id: candidate.id, votes: 0, rankSupport: 0 }]));
  for (const result of results) {
    const qualifying = orderDiscovery(result.rankings);
    const promoted = new Set(promoteDiscoveryBatch(result.rankings).map(row => row.id));
    qualifying.forEach((row, index) => {
      const value = support.get(row.id);
      value.votes += Number(promoted.has(row.id));
      value.rankSupport += qualifying.length === 1 ? 1 : (qualifying.length - 1 - index) / (qualifying.length - 1);
    });
  }
  // Aggregate nomination frequency and within-cohort rank, never raw scores
  // across cohorts. Each candidate appears once per shuffle, so votes are fair.
  const finalists = [...support.values()].filter(row => row.votes > 0)
    .sort((a, b) => b.votes - a.votes || b.rankSupport - a.rankSupport || a.id.localeCompare(b.id)).slice(0, 12);
  const byId = new Map(candidates.map(candidate => [candidate.id, candidate]));
  const pool = canonicalDiscoveryCandidates(finalists.map(row => byId.get(row.id)));
  ensureActive();
  const final = pool.length ? (await scoreGroups([pool], scoreBatch, ensureActive, "final"))[0] : { rankings: [] };
  return { rankings: final.rankings, consensusSupport: [...support.values()], providerRequests: results.length + Number(pool.length > 0) };
}

export async function loadReviewedComparison(manifestPath, { reviewed = true } = {}) {
  const manifest = validateComparisonManifest(JSON.parse(await readFile(manifestPath, "utf8")), { reviewed });
  const subjects = [];
  for (const item of manifest.cases) {
    const subject = await loadDiscoverySubject(manifest.dataDir, { brief: item.brief });
    insist(subject.source.fingerprint === item.snapshotHash && subject.candidates.length === item.candidates.length
      && subject.candidates.every(candidate => item.candidates.some(row => row.id === candidate.id)), "The labeled collection changed. Prepare a new review instead of silently replacing examples.");
    subjects.push(subject);
  }
  return { manifest, subjects };
}
