import * as local from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCloudStore, CLOUD_ROOT } from './cloud-store.mjs';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Skills select a destination explicitly. Merely loading cloud credentials must
// never redirect an existing local workflow or fall back to a stale local copy.
export async function skillStorage({ target, dataDir, repo = REPO_ROOT, store } = {}) {
  if (target === 'cloud') {
    if (dataDir) throw new Error('--data-dir cannot be combined with --target cloud');
    if (!store && (!process.env.DATABASE_URL || !process.env.BLOB_READ_WRITE_TOKEN)) throw new Error('Cloud access needs DATABASE_URL and BLOB_READ_WRITE_TOKEN; load the ignored .env.cloud file. No local fallback was used.');
    return { target, dataDir: CLOUD_ROOT, store: store || createCloudStore() };
  }
  if (target !== 'local') throw new Error('Select --target cloud or --target local explicitly.');
  const { loadEnv } = await import('vite');
  const env = loadEnv('development', repo, 'WARDROBE_');
  return { target, dataDir: path.resolve(repo, dataDir || process.env.WARDROBE_DATA_DIR || env.WARDROBE_DATA_DIR || 'data'), store: local,
    reference: path.resolve(repo, process.env.WARDROBE_MODEL_REFERENCE || env.WARDROBE_MODEL_REFERENCE || 'data/model-reference.png') };
}

export function parseSkillArgs(args, { positional = false } = {}) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (key === '--dry-run') { options.dryRun = true; continue; }
    if (['--target', '--data-dir', '--out', '--items', '--modeled', '--manifest', '--repo'].includes(key)) {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`${key} requires a value`);
      options[key.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
    } else if (positional && !key.startsWith('-') && !options.stagedManifestPath) options.stagedManifestPath = path.resolve(key);
    else throw new Error(`Unknown argument: ${key}`);
  }
  return options;
}
