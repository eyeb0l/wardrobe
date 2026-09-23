import sharp from 'sharp';
import { processChromaBackground } from './chroma-processing.mjs';

export const CLEANUP_STRENGTHS = [46, 62, 78, 94, 110];
const rgb = key => [1, 3, 5].map(i => parseInt(key.slice(i, i + 2), 16));
const chroma = (data, i, key) => {
  let high = 0, low = 0, nh = 0, nl = 0;
  for (let c = 0; c < 3; c++) {
    if (key[c] > 127) { high += data[i + c]; nh++; }
    else { low += data[i + c]; nl++; }
  }
  return high / nh - low / nl;
};

// Fixed output-space criteria: no dependency on the cleaner's strength,
// corrected-pixel mask, or success counter. Alpha weighting measures visible
// contrast on both light and dark composites, without averaging small spots away.
export async function inspectFinishedCutout(bytes, keyHex, { repair = false, correctionMask } = {}) {
  const { data, info: { width, height } } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const key = rgb(keyHex);
  const reach = Math.max(6, Math.ceil(Math.max(width, height) / 64));
  let contaminatedPixels = 0, maxSpill = 0, repairedPixels = 0;
  const repaired = repair ? Buffer.from(data) : null;
  const allowed = correctionMask ? await sharp(correctionMask).ensureAlpha().raw().toBuffer() : null;
  const regions = new Map();
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = 4 * (y * width + x), alpha = data[i + 3] / 255;
    if (!alpha) continue;
    const observed = chroma(data, i, key);
    if (observed * alpha < 4 || observed < 18) continue;
    let boundary = alpha < .98, anchor = Infinity, anchorIndex = -1, anchorDistance = Infinity;
    for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[1,1],[-1,1],[1,-1]]) {
      for (let d = 1; d <= reach; d++) {
        const nx = x + dx * d, ny = y + dy * d;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) { boundary = true; break; }
        const j = 4 * (ny * width + nx);
        if (data[j + 3] < 16) { boundary = true; break; }
        if (d >= 3 && data[j + 3] >= 245) {
          const sample = chroma(data, j, key);
          anchor = Math.min(anchor, sample);
          if (Math.abs(sample) < 12 && d < anchorDistance) { anchorIndex = j; anchorDistance = d; }
        }
      }
    }
    if (!boundary) continue;
    const excess = Number.isFinite(anchor) ? observed - Math.max(0, anchor) : observed;
    if (excess < 18 || excess * alpha < 4) continue;
    // Only resolve residual tint in an established feather, with a nearby
    // neutral opaque anchor. Opaque pixels need the matting correction mask. Coloured
    // trims, ambiguous opaque spots and detached details remain review cases.
    if (repair && (alpha < 1 || allowed?.[i] >= 128) && anchorIndex >= 0) {
      for (let c = 0; c < 3; c++) repaired[i + c] = data[anchorIndex + c];
      repairedPixels++;
    }
    contaminatedPixels++;
    maxSpill = Math.max(maxSpill, excess * alpha);
    const cell = `${Math.floor(x / 32)}:${Math.floor(y / 32)}`;
    const region = regions.get(cell) || { x, y, right: x, bottom: y };
    region.x = Math.min(region.x, x); region.y = Math.min(region.y, y);
    region.right = Math.max(region.right, x); region.bottom = Math.max(region.bottom, y);
    regions.set(cell, region);
  }
  return { contaminatedPixels, maxSpill, width, height, ...(repair ? { repairedPixels, bytes: await sharp(repaired, { raw: { width, height, channels: 4 } }).png().toBuffer() } : {}),
    regions: [...regions.values()].slice(0, 48).map(r => ({ x: r.x, y: r.y, width: r.right - r.x + 1, height: r.bottom - r.y + 1 })) };
}

// Compare before framing so different trim bounds cannot conceal lost fabric.
// Opaque interiors must be unchanged; a bounded edge loss alone cannot prove
// preservation, so also protect every substantial connected piece.
export function inspectPreservation(baseline, candidate, keyHex = "#00ff00") {
  const { width, height } = baseline.info, a = baseline.raw, b = candidate.raw;
  const key = rgb(keyHex), radius = Math.max(3, Math.ceil(Math.max(width, height) / 200) + 1);
  let protectedChanged = 0, coverage = 0, lost = 0;
  const protectedEdits = new Uint8Array(width * height);
  const seen = new Uint8Array(width * height);
  let missingComponents = 0;
  for (let p = 0; p < seen.length; p++) {
    const i = p * 4, x = p % width, y = Math.floor(p / width);
    // Key-coloured residue is not part of the garment silhouette budget.
    // Its removal still cannot alter the protected opaque interior below.
    if (chroma(a, i, key) < 40) { coverage += a[i + 3]; lost += Math.max(0, a[i + 3] - b[i + 3]); }
    if (a[i + 3] < 250) continue;
    let interior = true;
    for (let dy = -radius; dy <= radius && interior; dy++) for (let dx = -radius; dx <= radius; dx++) {
      if (x + dx < 0 || x + dx >= width || y + dy < 0 || y + dy >= height || a[4 * ((y + dy) * width + x + dx) + 3] < 250) { interior = false; break; }
    }
    if (interior && [0,1,2,3].some(c => a[i+c] !== b[i+c])) protectedEdits[p] = 1;
  }
  for (let p = 0; p < seen.length; p++) {
    if (seen[p] || a[p*4+3] < 32) continue;
    const queue = [p]; seen[p] = 1;
    let mass = 0, retained = 0, garmentPixels = 0, edits = 0;
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const q = queue[cursor], x = q % width, y = Math.floor(q / width);
      if (chroma(a, q*4, key) < 40) garmentPixels++;
      edits += protectedEdits[q];
      mass += a[q*4+3]; retained += Math.min(a[q*4+3], b[q*4+3]);
      for (const [dx,dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
        const nx=x+dx, ny=y+dy, n=ny*width+nx;
        if (nx<0 || nx>=width || ny<0 || ny>=height || seen[n] || a[n*4+3]<32) continue;
        seen[n]=1; queue.push(n);
      }
    }
    if (garmentPixels >= 16 && retained < mass * .9) missingComponents++;
    if (queue.length > 64 || garmentPixels > 0) protectedChanged += edits;
  }
  const lostCoverageRatio = coverage ? lost / coverage : 1;
  return { protectedChanged, lostCoverageRatio, missingComponents,
    safe: protectedChanged === 0 && missingComponents === 0 && lostCoverageRatio <= .005 };
}

export async function automaticChromaCleanup(source, key, { strengths = CLEANUP_STRENGTHS } = {}) {
  let baseline, best;
  const attempts = [];
  for (const tolerance of strengths) {
    // Always start from the original bytes; never compound edge erosion.
    let candidate;
    try { candidate = await processChromaBackground(source, key, { tolerance, includeRaw: true }); }
    catch (error) {
      if (!baseline) throw error;
      attempts.push({ tolerance, safe: false, clean: false, error: 'Candidate could not preserve a visible garment' });
      continue;
    }
    baseline ||= candidate;
    let repairedPixels = 0;
    if (candidate.hasBackground) {
      const repair = await inspectFinishedCutout(candidate.bytes, key, { repair: true, correctionMask: candidate.correctionMask });
      candidate.bytes = repair.bytes;
      repairedPixels = repair.repairedPixels;
    }
    const finished = await inspectFinishedCutout(candidate.bytes, key);
    const preservation = inspectPreservation(baseline, candidate, key);
    // Existing transparent assets are preserved byte-for-pixel by the cleaner.
    // A key-like fabric boundary with no reliable anchor remains uncertain.
    const uncertain = candidate.hasBackground && candidate.verification.contaminatedPixels > 0;
    const clean = finished.contaminatedPixels === 0 && preservation.safe && !uncertain;
    const diagnostics = { ...finished, preservation, clean, repairedPixels, unresolvedPixels: candidate.verification.contaminatedPixels };
    attempts.push({ tolerance, contaminatedPixels: finished.contaminatedPixels, maxSpill: finished.maxSpill, safe: preservation.safe, clean });
    const result = { bytes: candidate.bytes, tolerance, diagnostics };
    if (!best || (preservation.safe && (finished.maxSpill < best.diagnostics.maxSpill ||
      (finished.maxSpill === best.diagnostics.maxSpill && finished.contaminatedPixels < best.diagnostics.contaminatedPixels)))) best = result;
    if (clean) return { ...result, attempts };
  }
  return { ...best, attempts };
}
