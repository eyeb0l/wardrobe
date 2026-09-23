import sharp from "sharp";

export function cleanupTolerance(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(18, Math.min(110, Math.round(parsed))) : 46;
}

function colorDistance(data, index, color) {
  return Math.hypot(data[index] - color[0], data[index + 1] - color[1], data[index + 2] - color[2]);
}

const CHROMA_NEIGHBORS = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];

function chromaMatte(data, info, target, tolerance) {
  const { width, height } = info;
  const count = width * height;
  const background = new Uint8Array(count);
  const edgeBand = Math.max(2, Math.min(12, Math.ceil(Math.max(width, height) / 200)));
  const layers = new Uint8Array(count).fill(edgeBand + 1);
  // An existing alpha cutout, or an image without an actual key-colored border,
  // is not evidence of chroma spill. In particular, channel dominance is never
  // evidence that an opaque garment interior needs recoloring.
  const border = [];
  for (let x = 0; x < width; x += 1) {
    border.push(x);
    if (height > 1) border.push((height - 1) * width + x);
  }
  for (let y = 1; y < height - 1; y += 1) {
    border.push(y * width);
    if (width > 1) border.push(y * width + width - 1);
  }
  // An already transparent exterior is stronger evidence than key-colored
  // garment pixels touching the canvas. Do not remat an existing cutout.
  // Partial alpha inside a solid keyed exterior still follows the key path.
  if (border.some((pixel) => data[pixel * 4 + 3] === 0)) {
    return { background, layers, edgeBand, keyColor: target, hasBackground: false };
  }
  const candidates = border.filter((pixel) => data[pixel * 4 + 3] === 255 && colorDistance(data, pixel * 4, target) <= tolerance);
  if (candidates.length < Math.max(1, Math.ceil(border.length * 0.05))) return { background, layers, edgeBand, ambiguityRadius: tolerance + 40, keyColor: target, hasBackground: false };
  candidates.sort((a, b) => colorDistance(data, a * 4, target) - colorDistance(data, b * 4, target));
  const keyColor = [...data.subarray(candidates[0] * 4, candidates[0] * 4 + 3)];
  // Use a tight match to the observed background, not the much broader spill
  // threshold. Near-key garment colors remain foreground. Matching enclosed
  // regions are included so handle openings are removed too. Exact key-colored
  // fabric and a key-colored hole are indistinguishable in a single image.
  const matchRadius = Math.max(3, Math.min(18, tolerance / 6));
  for (let pixel = 0; pixel < count; pixel += 1) {
    if (data[pixel * 4 + 3] === 255 && colorDistance(data, pixel * 4, keyColor) <= matchRadius) {
      background[pixel] = 1;
      layers[pixel] = 0;
    }
  }
  // Feather width scales with source resolution, but stays bounded. Pixels
  // beyond this band are never edited.
  for (let layer = 1; layer <= edgeBand; layer += 1) {
    for (let pixel = 0; pixel < count; pixel += 1) {
      if (layers[pixel] !== edgeBand + 1) continue;
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      for (const [dx, dy] of CHROMA_NEIGHBORS) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < width && ny < height && layers[ny * width + nx] === layer - 1) {
          layers[pixel] = layer;
          break;
        }
      }
    }
  }
  return { background, layers, edgeBand, ambiguityRadius: tolerance + 40, keyColor, tolerance, hasBackground: true };
}

function keyChroma(color, keyColor) {
  const high = keyColor.map((v, c) => v > 127 ? c : -1).filter(c => c >= 0);
  const low = keyColor.map((v, c) => v <= 127 ? c : -1).filter(c => c >= 0);
  return high.reduce((sum, c) => sum + color[c], 0) / high.length - low.reduce((sum, c) => sum + color[c], 0) / low.length;
}

function fitChromaBlend(source, anchor, observed, keyColor, best, tolerance) {
  const foreground = [...source.subarray(anchor * 4, anchor * 4 + 3)];
  const vector = foreground.map((value, channel) => value - keyColor[channel]);
  const denominator = vector.reduce((sum, value) => sum + value * value, 0);
  const coverage = vector.reduce((sum, value, channel) => sum + value * (observed[channel] - keyColor[channel]), 0) / denominator;
  if (coverage <= 0 || coverage >= 0.98) return best;
  const residual = Math.hypot(...observed.map((value, channel) => value - (keyColor[channel] + coverage * vector[channel])));
  // Generated backgrounds are not perfectly flat: low-coverage edge pixels
  // can contain compression/noise off the ideal foreground-to-key line.
  const noiseAllowance = 90 + tolerance / 5;
  if (residual > noiseAllowance + 18 * coverage || (best && residual >= best.residual)) return best;
  // Unmix the observed pixel, retaining its local texture rather than
  // copying the anchor's RGB. The anchor estimates coverage only.
  const unmixed = observed.map((value, channel) => Math.round(Math.max(0, Math.min(255, (value - (1 - coverage) * keyColor[channel]) / coverage))));
  // Dividing off-line noise by tiny coverage turns a faint fringe into vivid
  // coloured speckles. Use the nearby opaque sample for noisy edge RGB only;
  // retain exact unmixing for clean blends and never touch opaque interiors.
  return { foreground: coverage < 0.25 || residual > 1 ? foreground : unmixed, anchorColor: foreground, coverage, residual };
}

function unmixChromaEdge(source, pixel, info, matte) {
  const { width, height } = info;
  const index = pixel * 4;
  const x = pixel % width;
  const y = Math.floor(pixel / width);
  const observed = [...source.subarray(index, index + 3)];
  let best = null;
  const anchors = [];
  let furthestColor = 0;
  for (const [dx, dy] of CHROMA_NEIGHBORS) {
    const bx = x + dx;
    const by = y + dy;
    if (bx < 0 || by < 0 || bx >= width || by >= height) continue;
    // Look inward for the least key-like samples along this ray. This avoids
    // mistaking another feather pixel for opaque foreground, and also works
    // on thin handles where no wide constant-color interior exists.
    for (let step = 1; step <= Math.max(6, matte.edgeBand * 3); step += 1) {
      const ax = x - dx * step;
      const ay = y - dy * step;
      if (ax < 0 || ay < 0 || ax >= width || ay >= height) break;
      const anchor = ay * width + ax;
      if (matte.background[anchor]) break;
      if (matte.layers[anchor] < 3 || source[anchor * 4 + 3] !== 255) continue;
      const distance = colorDistance(source, anchor * 4, matte.keyColor);
      if (distance < 40) continue;
      furthestColor = Math.max(furthestColor, distance);
      anchors.push({ anchor, distance });
    }
  }
  for (const { anchor, distance } of anchors) {
    if (distance < furthestColor * 0.92) continue;
    best = fitChromaBlend(source, anchor, observed, matte.keyColor, best, matte.tolerance);
  }
  if (!best && (colorDistance(source, index, matte.keyColor) < matte.ambiguityRadius || keyChroma(observed, matte.keyColor) > 30)) {
    // Corners, fine hardware and curved handles need samples along the same
    // connected foreground, not just eight straight rays. Restrict this more
    // expensive search to unresolved background-dominated boundary pixels.
    const reach = Math.max(6, matte.edgeBand * 3);
    const visited = new Set([pixel]);
    const queue = [pixel];
    const anchors = [];
    let furthestColor = 0;
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const current = queue[cursor];
      const qx = current % width;
      const qy = Math.floor(current / width);
      if (matte.layers[current] >= 3 && source[current * 4 + 3] === 255) {
        const distance = colorDistance(source, current * 4, matte.keyColor);
        if (distance >= 40) {
          anchors.push({ anchor: current, distance });
          furthestColor = Math.max(furthestColor, distance);
        }
      }
      for (const [dx, dy] of CHROMA_NEIGHBORS) {
        const nx = qx + dx;
        const ny = qy + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height || Math.abs(nx - x) > reach || Math.abs(ny - y) > reach) continue;
        const next = ny * width + nx;
        if (visited.has(next) || matte.background[next]) continue;
        visited.add(next);
        queue.push(next);
      }
    }
    for (const { anchor, distance } of anchors) {
      if (distance < furthestColor * 0.92) continue;
      best = fitChromaBlend(source, anchor, observed, matte.keyColor, best, matte.tolerance);
    }
    // Tiny detached key-coloured specks have no garment sample to unmix.
    // Do not treat a substantial or differently coloured component as dust.
    if (!best && queue.length <= 9 && queue.every(p => colorDistance(source, p * 4, matte.keyColor) < Math.max(150, matte.ambiguityRadius))) {
      return { foreground: [0, 0, 0], coverage: 0 };
    }
  }
  if (best && best.coverage > 0.65) {
    // An opaque color gradient can accidentally fit the same line as a key
    // blend. Do not weaken that edge unless a more background-dominated
    // transition is also visible on the path toward confirmed background.
    const foregroundDistance = Math.hypot(...best.foreground.map((value, channel) => value - matte.keyColor[channel]));
    let hasTransition = false;
    for (const [dx, dy] of CHROMA_NEIGHBORS) {
      for (let step = 1; step <= matte.edgeBand + 1; step += 1) {
        const nx = x + dx * step;
        const ny = y + dy * step;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) break;
        const next = ny * width + nx;
        if (matte.background[next]) break;
        if (matte.layers[next] < matte.layers[pixel] && colorDistance(source, next * 4, matte.keyColor) < foregroundDistance * 0.65) {
          hasTransition = true;
          break;
        }
      }
      if (hasTransition) break;
    }
    // A one-pixel spill can meet the background directly, with no intermediate
    // transition. Require excess key chroma relative to the opaque anchor.
    if (!hasTransition && keyChroma(observed, matte.keyColor) - keyChroma(best.anchorColor, matte.keyColor) < 20) return null;
  }
  return best;
}

export async function processChromaBackground(bytes, key, options = {}) {
  const tolerance = cleanupTolerance(options.tolerance);
  const target = [1, 3, 5].map((offset) => Number.parseInt(key.slice(offset, offset + 2), 16));
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const source = Buffer.from(data);
  const matte = chromaMatte(source, info, target, tolerance);
  const corrected = new Uint8Array(info.width * info.height);
  if (matte.hasBackground) {
    for (let pixel = 0; pixel < matte.background.length; pixel += 1) {
      const index = pixel * 4;
      if (matte.background[pixel]) {
        data.fill(0, index, index + 4);
      } else if (matte.layers[pixel] <= matte.edgeBand && source[index + 3] === 255) {
        const edge = unmixChromaEdge(source, pixel, info, matte);
        if (!edge) continue;
        for (let channel = 0; channel < 3; channel += 1) data[index + channel] = edge.foreground[channel];
        data[index + 3] = Math.round(edge.coverage * 255);
        corrected[pixel] = 1;
      }
    }
  }
  const verification = verifyNoChromaSpill(source, matte, corrected, tolerance);
  const keyedOutput = await sharp(data, { raw: info }).png().toBuffer();
  // Framing resamples the established alpha matte. Do not despill again after
  // resizing: that would change legitimate garment colors a second time.
  const output = await frameTransparentGarment(keyedOutput);
  let correctionMask;
  if (options.includeRaw) {
    const mask = Buffer.from(data);
    for (let p = 0; p < corrected.length; p++) mask.fill(corrected[p] ? 255 : 0, p * 4, p * 4 + 3);
    correctionMask = await frameTransparentGarment(await sharp(mask, { raw: info }).png().toBuffer());
  }
  return { bytes: output, verification, tolerance, ...(options.includeRaw ? { raw: Buffer.from(data), info, hasBackground: matte.hasBackground, correctionMask } : {}) };
}

export async function removeChromaBackground(bytes, key, options = {}) {
  const result = await processChromaBackground(bytes, key, options);
  if (options.strict !== false && result.verification.contaminatedPixels > 1) {
    throw new Error(`Background cleanup left ${result.verification.contaminatedPixels} chroma-contaminated pixels`);
  }
  return result.bytes;
}

export async function frameTransparentGarment(bytes, canvasSize = 1024, occupancy = 0.88) {
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let minX = info.width;
  let minY = info.height;
  let maxX = -1;
  let maxY = -1;
  for (let index = 0, pixel = 0; index < data.length; index += 4, pixel += 1) {
    if (data[index + 3] <= 8) continue;
    const x = pixel % info.width;
    const y = Math.floor(pixel / info.width);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  if (maxX < minX || maxY < minY) throw new Error("Background removal did not leave a visible garment");

  const trimmed = await sharp(data, { raw: info })
    .extract({ left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 })
    .png()
    .toBuffer();
  const targetSize = Math.max(1, Math.round(canvasSize * Math.max(0.5, Math.min(0.96, occupancy))));
  const resized = await sharp(trimmed)
    .resize(targetSize, targetSize, { fit: "inside", withoutEnlargement: false })
    .png()
    .toBuffer({ resolveWithObject: true });
  const left = Math.floor((canvasSize - resized.info.width) / 2);
  const top = Math.floor((canvasSize - resized.info.height) / 2);
  return sharp({ create: { width: canvasSize, height: canvasSize, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: resized.data, left, top }])
    .png()
    .toBuffer();
}

function verifyNoChromaSpill(source, matte, corrected, tolerance) {
  let contaminatedPixels = 0;
  let maxSpill = 0;
  if (!matte.hasBackground) return { contaminatedPixels, maxSpill };
  for (let pixel = 0; pixel < matte.background.length; pixel += 1) {
    if (matte.background[pixel] || corrected[pixel] || matte.layers[pixel] > matte.edgeBand || source[pixel * 4 + 3] !== 255) continue;
    // A near-key boundary without a reliable foreground anchor is ambiguous.
    // Preserve its pixels but require review in strict mode. Interior color
    // dominance and existing semitransparency are not contamination tests.
    const proximity = Math.max(0, tolerance + 40 - colorDistance(source, pixel * 4, matte.keyColor));
    if (proximity > 0) {
      contaminatedPixels += 1;
      maxSpill = Math.max(maxSpill, proximity);
    }
  }
  return { contaminatedPixels, maxSpill };
}
