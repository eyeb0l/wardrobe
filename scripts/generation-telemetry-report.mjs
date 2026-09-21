import { skillStorage } from './skill-storage.mjs';
import { withStorage } from './storage-fs.mjs';
import { readTelemetry, summarizeTelemetry } from './generation-telemetry.mjs';

try {
  const options = {};
  for (let i = 2; i < process.argv.length; i++) {
    const key = process.argv[i];
    if (!['--target', '--data-dir'].includes(key) || !process.argv[i + 1] || process.argv[i + 1].startsWith('--')) {
      throw new Error('Usage: node scripts/generation-telemetry-report.mjs --target local|cloud [--data-dir PATH]');
    }
    options[key === '--target' ? 'target' : 'dataDir'] = process.argv[++i];
  }
  const storage = await skillStorage(options);
  const records = await withStorage(storage.store, () => readTelemetry(storage.dataDir));
  process.stdout.write(`${JSON.stringify(summarizeTelemetry(records), null, 2)}\n`);
} catch (error) {
  // Storage errors may contain database URLs. Do not print their raw messages.
  console.error('Could not read generation telemetry. Select --target local or --target cloud and check storage configuration and record integrity.');
  process.exitCode = 1;
}
