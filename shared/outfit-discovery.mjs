// Ranking controls reuse the original judgments and never dispatch another call.
export function orderDiscovery(rankings, { style = "match", lessUsed = false } = {}) {
  const value = (row) => row.match + (style === "understated" ? .2 * (1 - row.statement) : style === "statement" ? .2 * row.statement : 0) + (lessUsed ? .15 * (row.novelty || 0) : 0);
  return [...rankings].filter((row) => row.evidence === "sufficient" && row.match >= .5)
    .sort((a, b) => value(b) - value(a) || b.match - a.match || a.id.localeCompare(b.id));
}

export function discoveryFingerprint(outfits, items) {
  return JSON.stringify([outfits.map(({ id, name, occasion, reason, garmentIds, status, image, updatedAt }) => [id, name, occasion, reason, garmentIds, status, image, updatedAt]), items.map(({ id, name, part, color, secondaryColor, tags, revision, hidden, image }) => [id, name, part, color, secondaryColor, tags, revision, hidden, image])]);
}
