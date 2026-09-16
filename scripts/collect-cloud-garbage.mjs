import { createCloudStore } from './cloud-store.mjs';
const args = process.argv.slice(2);
if (args.some(arg => !['--apply', '--initialize'].includes(arg))) throw new Error('Usage: node scripts/collect-cloud-garbage.mjs [--initialize] [--apply]');
const store = createCloudStore();
if (args.includes('--initialize')) await store.initializeGarbageCollection();
console.log(JSON.stringify(await store.collectGarbage({ dryRun: !args.includes('--apply') })));
