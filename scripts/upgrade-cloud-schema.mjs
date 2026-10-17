import { pathToFileURL } from 'node:url';
import { createCloudStore, CLOUD_SCHEMA_SQL } from './cloud-store.mjs';

// Reapplies the idempotent schema (tables, indexes, functions and publication
// guards) to an existing store. It copies, rewrites and deletes no files, takes
// no writer lease and is not the one-time migrate-to-cloud import.
export async function upgradeCloudSchema({ store, apply = false, log = console.log } = {}) {
  log(`${CLOUD_SCHEMA_SQL.length} idempotent schema statements${apply ? '' : '; dry run, pass --apply to run them'}.`);
  if (!apply) return { applied: false, statements: CLOUD_SCHEMA_SQL.length };
  await (store ?? createCloudStore()).initialize();
  log('Schema is current.');
  return { applied: true, statements: CLOUD_SCHEMA_SQL.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--apply')) throw new Error('Usage: node scripts/upgrade-cloud-schema.mjs [--apply]');
  await upgradeCloudSchema({ apply: args.includes('--apply') });
}
