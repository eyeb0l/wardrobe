import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isBackupPath, prepareRestore, RESTORE_PAUSED_MESSAGE } from './backup-recovery.mjs';
import { wardrobeImportApi } from './import-job-api.mjs';
import { wardrobeOutfitApi } from './outfit-api.mjs';
import { executeCloudTask } from '../server/task-runner.mjs';

const jsonFile = (name, value) => ({ name, bytes: Buffer.from(JSON.stringify(value)) });
const parsed = (result, name) => JSON.parse(result.files.find(file => file.name === name).bytes);
const day = new Date().toISOString().slice(0, 10);
const date = '2026-09-18T00:00:00.000Z';
const importJob = (status = 'queued', stage = 'garment') => ({
  id: randomUUID(), status: 'active', createdAt: date, updatedAt: date,
  metadata: { name: 'Saved top' }, internal: { originalFile: 'original.png' },
  stages: {
    crop: { status: 'approved', attempts: 0 },
    garment: { status: 'approved', attempts: 1, assetUrl: '/saved-cutout.png' },
    modeled: { status: 'review', attempts: 1, assetUrl: '/saved-modeled.png', prompt: 'Keep this prompt' },
    [stage]: { status, attempts: 2, taskId: randomUUID(), prompt: 'Saved instruction' },
  },
});
const outfitJob = () => {
  const id = randomUUID();
  const base = { name: 'Saved outfit', occasion: ['Everyday'], garmentIds: ['top-one'], attempts: 1, error: null,
    internal: { history: [{ attempt: 1, at: date, model: 'saved-model', prompt: 'Saved full prompt', references: ['top.png'] }] } };
  return { version: 1, id, count: 4, status: 'generating', direction: '', modelReferenceId: 'default', createdAt: date, updatedAt: date,
    internal: { cloudTaskId: randomUUID(), planningPrompt: 'Preserve plan' }, outfits: [
      { ...structuredClone(base), id: 'accepted-one', status: 'accepted', image: '/api/outfits/images/accepted.png' },
      { ...structuredClone(base), id: 'review-one', status: 'review', image: `/api/outfits/jobs/${id}/assets/review.png` },
      { ...structuredClone(base), id: 'planned-one', status: 'planned' },
      { ...structuredClone(base), id: 'running-one', status: 'generating' },
    ] };
};
const taskFile = (state = 'pending', id = randomUUID()) => jsonFile(`.tasks/${id}.json`, {
  id, state, step: 0, payload: { kind: 'import', jobId: randomUUID(), stageName: 'garment', taskId: id },
  createdAt: date, runId: 'historical-workflow', dispatchedAt: date,
});

async function restoreFixture(t, files) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wardrobe-restored-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const file of files) {
    const destination = path.join(root, file.name);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, file.bytes);
  }
  return root;
}

test('backup path policy includes future data and excludes runtime files and unsafe paths', () => {
  for (const name of ['library.json', 'outfits.json', 'outfit-prompts.json', 'new-feature/state.json', 'model-reference-2.png',
    'jobs/id/original.png', 'imported/hidden-original.png', '.api-usage.json', `.tasks/${randomUUID()}.json`]) assert.equal(isBackupPath(name), true, name);
  for (const name of ['', '/library.json', '../library.json', 'jobs/../library.json', 'jobs//job.json', 'jobs\\job.json',
    'jobs\u0000/job.json', '.env.cloud', '.blob-gc-state.json', '.outfit-store.lock', '.outfit-store.recovery/owner.json',
    'jobs/id/job.json.uuid.tmp', 'outfit-jobs/id/.outfit-write-uuid.tmp', 'new-feature/.secret', '.tasks/id.txt', '.tasks/nested/id.json']) {
    assert.equal(isBackupPath(name), false, name);
  }
});

test('restore leaves original user bytes and backup inputs intact while reporting excluded runtime files', () => {
  const library = jsonFile('library.json', [{ id: 'hidden', hidden: true, _editVersion: 'keep-me', custom: { value: 3 } }]);
  const image = { name: 'imported/hidden-original.png', bytes: Buffer.from([137, 80, 78, 71, 0, 255]) };
  const files = [library, image, jsonFile('future/data.json', { any: 'future feature' }),
    jsonFile('.blob-gc-state.json', { cursor: 'do-not-restore' }), jsonFile('jobs/id/job.json.uuid.tmp', { partial: true })];
  const before = files.map(file => Buffer.from(file.bytes));
  const result = prepareRestore(files);
  assert.equal(result.pausedJobs, 0);
  assert.deepEqual(result.excludedPaths, ['.blob-gc-state.json', 'jobs/id/job.json.uuid.tmp']);
  for (let index = 0; index < files.length; index++) assert.deepEqual(files[index].bytes, before[index]);
  for (const file of result.files) assert.deepEqual(file.bytes, files.find(source => source.name === file.name).bytes);
  result.files[0].bytes.fill(0);
  assert.deepEqual(library.bytes, before[0], 'returned bytes never mutate the immutable backup');
});

test('every resumable import state is paused and settled outputs survive', () => {
  const jobs = ['pending', 'queued', 'processing'].flatMap(status => ['garment', 'modeled'].map(stage => importJob(status, stage)));
  const files = jobs.map(job => jsonFile(`jobs/${job.id}/job.json`, job));
  const result = prepareRestore(files);
  assert.equal(result.pausedJobs, jobs.length);
  for (const original of jobs) {
    const saved = parsed(result, `jobs/${original.id}/job.json`);
    assert.equal(saved.status, 'active');
    for (const stage of ['garment', 'modeled']) {
      assert.equal(Object.hasOwn(saved.stages[stage], 'taskId'), false);
      if (['pending', 'queued', 'processing'].includes(original.stages[stage].status)) {
        assert.equal(saved.stages[stage].status, 'failed');
        assert.equal(saved.stages[stage].attempts, original.stages[stage].attempts);
        assert.equal(saved.stages[stage].prompt, original.stages[stage].prompt);
        assert.equal(saved.stages[stage].error, RESTORE_PAUSED_MESSAGE);
      } else assert.deepEqual(saved.stages[stage], original.stages[stage]);
    }
  }
});

test('mixed outfit recovery preserves accepted/review photographs and history, and prevents planning resumes', () => {
  const job = outfitJob();
  const planning = { ...outfitJob(), outfits: [], status: 'planning' };
  const result = prepareRestore([jsonFile(`outfit-jobs/${job.id}/job.json`, job), jsonFile(`outfit-jobs/${planning.id}/job.json`, planning)]);
  assert.equal(result.pausedJobs, 2);
  const saved = parsed(result, `outfit-jobs/${job.id}/job.json`);
  assert.equal(saved.status, 'review');
  assert.equal(saved.internal.cloudTaskId, undefined);
  assert.equal(saved.internal.planningPrompt, job.internal.planningPrompt);
  assert.deepEqual(saved.outfits.slice(0, 2), job.outfits.slice(0, 2));
  for (let index = 2; index < 4; index++) {
    assert.equal(saved.outfits[index].status, 'failed');
    assert.deepEqual(saved.outfits[index].internal, job.outfits[index].internal);
  }
  assert.equal(parsed(result, `outfit-jobs/${planning.id}/job.json`).status, 'failed');
});

test('active tasks and current destination deliveries become terminal before any paid reservation', async t => {
  const historical = taskFile('done');
  const pending = taskFile('pending');
  const running = taskFile('running');
  const liveOnly = taskFile('pending');
  const result = prepareRestore([historical, pending, running], { currentFiles: [liveOnly] });
  assert.deepEqual(result.files.find(file => file.name === historical.name).bytes, historical.bytes);
  const root = await restoreFixture(t, result.files);
  const store = {
    withLease: callback => callback(),
    readFile: (file, encoding) => readFile(path.join(root, file.slice('/wardrobe-data/'.length)), encoding),
  };
  for (const file of result.files) {
    const task = JSON.parse(file.bytes);
    assert.ok(['done', 'failed'].includes(task.state));
    assert.equal(task.runId, 'historical-workflow', 'the dispatched run is retained as evidence');
    assert.deepEqual(await executeCloudTask(task.id, 0, { store, enabled: () => true,
      reserve: () => assert.fail('Restored tasks must not reserve a paid request'),
      pluginFactory: () => assert.fail('Restored tasks must be stopped before loading a plugin'),
    }), { more: false });
  }
});

test('restore retains the latest UTC day and never lowers its API dispatch count', () => {
  const usage = calls => jsonFile('.api-usage.json', { day, calls });
  for (const [backupCalls, currentCalls] of [[2, 8], [8, 2], [8, 8]]) {
    const result = prepareRestore([usage(backupCalls)], { currentFiles: [usage(currentCalls)] });
    assert.equal(parsed(result, '.api-usage.json').calls, 8);
  }
  const old = jsonFile('.api-usage.json', { day: '2001-01-01', calls: 99 });
  assert.deepEqual(parsed(prepareRestore([old], { currentFiles: [usage(3)] }), '.api-usage.json'), { day, calls: 3 });
  assert.deepEqual(parsed(prepareRestore([usage(4)], { currentFiles: [old] }), '.api-usage.json'), { day, calls: 4 });
  assert.equal(parsed(prepareRestore([], { currentFiles: [usage(7)] }), '.api-usage.json').calls, 7);
});

test('restore fails closed for ambiguous paths, malformed jobs/tasks, and invalid usage on either side', () => {
  assert.throws(() => prepareRestore([{ name: '../escape', bytes: Buffer.from('x') }]), /invalid relative/);
  assert.throws(() => prepareRestore([jsonFile('a', {}), jsonFile('a', {})]), /duplicate/);
  const job = importJob();
  const jobName = `jobs/${job.id}/job.json`;
  for (const value of [[], { ...job, id: randomUUID() }, { ...job, version: 2 }, { ...job, stages: {} },
    { ...job, stages: { ...job.stages, garment: { status: 'future-running' } } }]) {
    assert.throws(() => prepareRestore([jsonFile(jobName, value)]), /Cannot safely restore/);
  }
  assert.throws(() => prepareRestore([{ name: jobName, bytes: Buffer.from('{broken') }]), /invalid JSON/);
  const outfit = outfitJob();
  assert.throws(() => prepareRestore([jsonFile(`outfit-jobs/${outfit.id}/job.json`, { ...outfit, version: 2 })]), /Cannot safely restore/);
  assert.throws(() => prepareRestore([jsonFile(`.tasks/${randomUUID()}.json`, { state: 'pending' })]), /unsupported task/);
  for (const value of [{ day, calls: -1 }, { day, calls: 0.1 }, { day, calls: '8' }, { day: '2026-02-30', calls: 3 }, { day: 'invalid', calls: 3 }]) {
    assert.throws(() => prepareRestore([jsonFile('.api-usage.json', value)]), /API usage|usage date/);
    assert.throws(() => prepareRestore([], { currentFiles: [jsonFile('.api-usage.json', value)] }), /API usage|usage date/);
  }
});

test('actual hosted job discovery and local plugin startup cannot resume restored paid work', async t => {
  let providerCalls = 0;
  t.mock.method(globalThis, 'fetch', async () => { providerCalls++; throw new Error('Unexpected provider request'); });
  const imports = [importJob('queued', 'garment'), importJob('processing', 'modeled'), importJob('pending', 'modeled')];
  const outfit = outfitJob();
  const accepted = outfit.outfits[0];
  const result = prepareRestore([
    ...imports.map(job => jsonFile(`jobs/${job.id}/job.json`, job)),
    jsonFile(`outfit-jobs/${outfit.id}/job.json`, outfit),
    jsonFile('outfits.json', { version: 1, outfits: [accepted] }), jsonFile('library.json', []),
  ]);
  const root = await restoreFixture(t, result.files);
  const env = { WARDROBE_DATA_DIR: root, OPENAI_API_KEY: 'test-key', OPENAI_API_BASE_URL: 'https://must-not-be-called.invalid' };
  const hostedImport = wardrobeImportApi({ serverless: true, readOnly: true, env });
  const hostedOutfit = wardrobeOutfitApi({ serverless: true, readOnly: true, env });
  await hostedImport.configResolved({ root });
  await hostedOutfit.configResolved({ root });
  t.after(() => hostedOutfit.closeBundle());
  assert.deepEqual(await hostedImport.pendingTasks(), []);
  assert.deepEqual(await hostedOutfit.pendingTasks(), []);
  const before = await Promise.all(imports.map(job => readFile(path.join(root, 'jobs', job.id, 'job.json'))));
  const localImport = wardrobeImportApi({ env });
  const localOutfit = wardrobeOutfitApi({ env });
  await localImport.configResolved({ root });
  await localOutfit.configResolved({ root });
  t.after(() => localOutfit.closeBundle());
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(providerCalls, 0);
  for (let index = 0; index < imports.length; index++) {
    assert.deepEqual(await readFile(path.join(root, 'jobs', imports[index].id, 'job.json')), before[index], 'startup did not attempt an import transition');
  }
});

test('settled legacy jobs retain exact bytes and unknown history fields', () => {
  const imported = importJob('review', 'modeled');
  delete imported.stages.modeled.taskId;
  imported.legacyDetails = { retain: ['all', 'history'] };
  const outfit = outfitJob();
  delete outfit.version;
  delete outfit.internal.cloudTaskId;
  outfit.status = 'review';
  outfit.outfits = outfit.outfits.slice(0, 2);
  outfit.internal.futureEvidence = { retained: true };
  const files = [jsonFile(`jobs/${imported.id}/job.json`, imported), jsonFile(`outfit-jobs/${outfit.id}/job.json`, outfit)];
  const result = prepareRestore(files);
  assert.equal(result.pausedJobs, 0);
  assert.deepEqual(result.files, files);
});


test('future-dated backup usage cannot erase the current UTC-day spending guard', () => {
  const future = jsonFile('.api-usage.json', { day: '9999-12-31', calls: 2 });
  const current = jsonFile('.api-usage.json', { day, calls: 37 });
  const result = prepareRestore([future], { currentFiles: [current] });
  assert.deepEqual(parsed(result, '.api-usage.json'), { day, calls: 37 });
  assert.throws(() => prepareRestore([future]), /future UTC usage date/);
  assert.throws(() => prepareRestore([current], { currentFiles: [future] }), /future UTC usage date/);
});
