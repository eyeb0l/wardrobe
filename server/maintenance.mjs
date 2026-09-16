import { timingSafeEqual } from 'node:crypto';

export async function maintenance(req, res, store, secret = process.env.CRON_SECRET) {
  const reply = (status, value) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(JSON.stringify(value));
  };
  if (req.method !== 'GET') return reply(405, { error: 'Method not allowed' });
  const received = Buffer.from(req.headers?.authorization || '');
  const expected = Buffer.from(`Bearer ${secret || ''}`);
  if (!secret || received.length !== expected.length || !timingSafeEqual(received, expected)) return reply(401, { error: 'Unauthorized' });
  try {
    const result = await store.collectGarbage();
    console.info('Wardrobe storage cleanup', JSON.stringify(result));
    return reply(result.errors ? 503 : 200, result);
  } catch (error) {
    // The next daily run retries if a generation already owns the writer lease.
    if (error.code === 'EBUSY') return reply(200, { skipped: 'writer-busy' });
    console.error('Wardrobe storage cleanup failed', error.message);
    return reply(503, { error: 'Storage cleanup could not finish. It will retry on the next run.' });
  }
}
