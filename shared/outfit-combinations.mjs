// Count unused base pairs without materializing the top × bottom product.
export function outfitCombinations(items, usedPairs) {
  const values = [...items.values()];
  const tops = values.filter((item) => item.part === "upperbody").length;
  const bottoms = values.filter((item) => item.part === "lowerbody").length;
  const byGarment = Object.fromEntries(values.map((item) => [item.id,
    item.part === "upperbody" ? bottoms : item.part === "lowerbody" ? tops : tops * bottoms]));
  let reserved = 0;
  for (const pair of usedPairs) {
    const ids = pair.split("|");
    if (ids.length !== 2 || !ids.some((id) => items.get(id)?.part === "upperbody") || !ids.some((id) => items.get(id)?.part === "lowerbody")) continue;
    reserved += 1;
    for (const id of ids) byGarment[id] -= 1;
  }
  const total = tops * bottoms - reserved;
  for (const item of values) if (!["upperbody", "lowerbody"].includes(item.part)) byGarment[item.id] = total;
  return { total, byGarment };
}
