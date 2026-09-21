// Pixel evidence complements vision; a PNG extension or alpha channel alone
// does not mean the background is transparent. Input is RGBA at any resolution.
export function productBackground(data, width, height) {
  const step = Math.max(1, Math.floor(Math.max(width, height) / 160));
  const border = Math.max(step, Math.round(Math.min(width, height) * .03));
  const corners = [0, (width - 1) * 4, (height - 1) * width * 4, (width * height - 1) * 4];
  const color = [0, 1, 2].map(c => corners.map(i => data[i + c]).sort((a, b) => a - b)[1]);
  let total = 0, clear = 0, visible = 0, subject = 0, edge = 0, clearEdge = 0, plainEdge = 0;
  for (let y = 0; y < height; y += step) for (let x = 0; x < width; x += step) {
    const i = (y * width + x) * 4;
    const transparent = data[i + 3] <= 8;
    const plain = transparent || Math.max(...color.map((v, c) => Math.abs(data[i + c] - v))) <= 18;
    total++;
    if (transparent) clear++;
    if (data[i + 3] > 32) visible++;
    if (!plain && data[i + 3] > 32) subject++;
    if (x < border || y < border || x >= width - border || y >= height - border) {
      edge++;
      if (transparent) clearEdge++;
      if (plain) plainEdge++;
    }
  }
  return {
    transparent: clear / total >= .1 && clearEdge / edge >= .9 && visible / total >= .005,
    plain: plainEdge / edge >= .96 && subject / total >= .005,
  };
}
