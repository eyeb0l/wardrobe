import { validateJob } from './outfit-storage.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const STAGE_STATUSES = new Set(['pending', 'queued', 'processing', 'review', 'ready', 'approved', 'rejected', 'failed']);
const ACTIVE_STAGES = new Set(['pending', 'queued', 'processing']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const RESTORE_PAUSED_MESSAGE = 'Restored from backup. Generation is paused; review this job and retry explicitly to start a new paid request.';
const invalid = (name, detail) => new Error(`Cannot safely restore ${name}: ${detail}`);
const validName = name => typeof name === 'string' && name.length > 0 && !name.startsWith('/')
  && !/[\\\0-\x1f\x7f]/.test(name) && name.split('/').every(part => part && part !== '.' && part !== '..');

// Include future non-hidden application files, rather than maintaining a list
// that could silently omit a new feature's data. Hidden runtime files are not
// portable; the two exceptions preserve dispatch history and the spending cap.
export function isBackupPath(name) {
  if (!validName(name) || name.split('/').some(part => part.endsWith('.tmp'))) return false;
  if (name === '.api-usage.json') return true;
  const parts = name.split('/');
  if (parts[0] === '.tasks') return parts.length === 2 && !parts[1].startsWith('.') && parts[1].endsWith('.json');
  return parts.every(part => !part.startsWith('.'));
}

function indexFiles(files, label) {
  if (!Array.isArray(files)) throw new Error(`${label} must be a list of files.`);
  const indexed = new Map();
  for (const file of files) {
    if (!object(file) || !validName(file.name)) throw invalid(String(file?.name), 'invalid relative file path.');
    if (!Buffer.isBuffer(file.bytes)) throw invalid(file.name, 'file bytes must be a Buffer.');
    if (indexed.has(file.name)) throw invalid(file.name, `duplicate ${label} path.`);
    indexed.set(file.name, Buffer.from(file.bytes));
  }
  return indexed;
}

function json(bytes, name) {
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw invalid(name, 'invalid JSON.'); }
  if (!object(value)) throw invalid(name, 'expected a JSON object.');
  return value;
}
const encode = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

function prepareImport(bytes, name, id, timestamp) {
  const job = json(bytes, name);
  if (!UUID.test(id) || job.id !== id || (job.version !== undefined && job.version !== 1)
    || !['active', 'complete'].includes(job.status) || !object(job.stages)) throw invalid(name, 'unsupported import job structure.');
  for (const stageName of ['garment', 'modeled']) {
    if (!object(job.stages[stageName])) throw invalid(name, `missing ${stageName} stage.`);
  }
  let changed = false, paused = false;
  for (const [stageName, stage] of Object.entries(job.stages)) {
    if (!['crop', 'garment', 'modeled'].includes(stageName) || !object(stage) || !STAGE_STATUSES.has(stage.status)) {
      throw invalid(name, `unsupported ${stageName} stage.`);
    }
    if (stage.attempts !== undefined && (!Number.isSafeInteger(stage.attempts) || stage.attempts < 0)) throw invalid(name, `invalid ${stageName} attempts.`);
    if (stageName !== 'crop' && ACTIVE_STAGES.has(stage.status)) {
      stage.status = 'failed';
      stage.error = RESTORE_PAUSED_MESSAGE;
      stage.updatedAt = timestamp;
      paused = changed = true;
    }
    if (Object.hasOwn(stage, 'taskId')) { delete stage.taskId; changed = true; }
  }
  if (changed) job.updatedAt = timestamp;
  return { bytes: changed ? encode(job) : bytes, paused };
}

function prepareOutfit(bytes, name, id, timestamp) {
  const job = json(bytes, name);
  // Use the application's validator, but retain original bytes for jobs that
  // need no recovery changes; normalization alone is not a data migration.
  try { validateJob(job, id); } catch (error) { throw invalid(name, error.message); }
  let changed = false, paused = false;
  if (job.internal && Object.hasOwn(job.internal, 'cloudTaskId')) { delete job.internal.cloudTaskId; changed = true; }
  for (const outfit of job.outfits) {
    if (!['planned', 'generating'].includes(outfit.status)) continue;
    outfit.status = 'failed';
    outfit.error = RESTORE_PAUSED_MESSAGE;
    paused = changed = true;
  }
  if (['planning', 'generating'].includes(job.status)) paused = changed = true;
  if (paused) {
    job.status = job.outfits.some(item => item.status === 'review') ? 'review'
      : !job.outfits.length || job.outfits.some(item => item.status === 'failed') ? 'failed' : 'complete';
    job.error = RESTORE_PAUSED_MESSAGE;
  }
  if (changed) job.updatedAt = timestamp;
  return { bytes: changed ? encode(job) : bytes, paused };
}

function prepareTask(bytes, name, timestamp) {
  const task = json(bytes, name);
  const id = name.slice('.tasks/'.length, -'.json'.length);
  if (!UUID.test(id) || task.id !== id || !['pending', 'running', 'done', 'failed'].includes(task.state)
    || !Number.isSafeInteger(task.step) || task.step < 0 || !object(task.payload)) throw invalid(name, 'unsupported task structure.');
  if (['done', 'failed'].includes(task.state)) return bytes;
  task.state = 'failed';
  task.error = RESTORE_PAUSED_MESSAGE;
  task.updatedAt = timestamp;
  // Keep payload and run IDs as historical evidence. A terminal task is rejected
  // before reserving quota or loading a plugin, even on delayed old deliveries.
  return encode(task);
}

function usage(bytes, name = '.api-usage.json') {
  if (!bytes) return undefined;
  const value = json(bytes, name);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value.day || '') || !Number.isSafeInteger(value.calls) || value.calls < 0) throw invalid(name, 'invalid daily API usage.');
  const date = new Date(`${value.day}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value.day) throw invalid(name, 'invalid UTC usage date.');
  return value;
}

// Pure transformation: an immutable backup keeps the original job history;
// only the separate restore copy loses permission to resume generation.
export function prepareRestore(files, { currentFiles = [] } = {}) {
  const backup = indexFiles(files, 'backup');
  const current = indexFiles(currentFiles, 'current destination');
  const prepared = new Map();
  const excludedPaths = [];
  const timestamp = new Date().toISOString();
  let pausedJobs = 0;
  for (const [name, bytes] of backup) {
    if (!isBackupPath(name)) { excludedPaths.push(name); continue; }
    const importMatch = name.match(/^jobs\/([^/]+)\/job\.json$/);
    const outfitMatch = name.match(/^outfit-jobs\/([^/]+)\/job\.json$/);
    if (importMatch || outfitMatch) {
      const result = importMatch ? prepareImport(bytes, name, importMatch[1], timestamp) : prepareOutfit(bytes, name, outfitMatch[1], timestamp);
      prepared.set(name, result.bytes);
      if (result.paused) pausedJobs++;
    } else if (name.startsWith('.tasks/')) prepared.set(name, prepareTask(bytes, name, timestamp));
    else prepared.set(name, bytes);
  }
  // Keep destination task IDs as terminal tombstones: old Workflow deliveries
  // then finish immediately instead of recreating permissions or retrying ENOENT.
  for (const [name, bytes] of current) {
    if (name.startsWith('.tasks/') && isBackupPath(name)) prepared.set(name, prepareTask(bytes, name, timestamp));
  }
  const oldUsage = usage(backup.get('.api-usage.json'));
  const liveUsage = usage(current.get('.api-usage.json'));
  const today = timestamp.slice(0, 10);
  if (liveUsage?.day === today) {
    // A backup recorded by a clock ahead of UTC must never replace today's
    // live guard: reservePaidCall would otherwise reset that future date to 0.
    const combined = { ...liveUsage, calls: Math.max(liveUsage.calls, oldUsage?.day === today ? oldUsage.calls : 0) };
    prepared.set('.api-usage.json', encode(combined));
  } else {
    if ((oldUsage && oldUsage.day > today) || (liveUsage && liveUsage.day > today)) throw invalid('.api-usage.json', 'future UTC usage date without a current-day destination guard.');
    if (liveUsage) {
      const combined = !oldUsage || liveUsage.day > oldUsage.day ? liveUsage
        : oldUsage.day > liveUsage.day ? oldUsage : { ...oldUsage, ...liveUsage, calls: Math.max(oldUsage.calls, liveUsage.calls) };
      prepared.set('.api-usage.json', encode(combined));
    }
  }
  return { files: [...prepared].map(([name, bytes]) => ({ name, bytes })), pausedJobs, excludedPaths };
}
