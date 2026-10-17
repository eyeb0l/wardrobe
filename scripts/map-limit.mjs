// Run task over values with at most `limit` in flight; results keep input order.
export async function mapLimit(values, limit, task) {
  const results = new Array(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (next < values.length) { const index = next++; results[index] = await task(values[index], index); }
  }));
  return results;
}
