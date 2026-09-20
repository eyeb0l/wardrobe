import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { evaluateAttempt } from './score-vision-api-eval.mjs';

const exec = promisify(execFile);
const script = fileURLToPath(new URL('./analyze-vision-api-eval.mjs', import.meta.url));
const tasks = ['detection', 'curation', 'shopping', 'scene', 'accessories'];
function fixtureCases() {
  return tasks.map(task => ({ id: `${task}-1`, task, split: 'confirm', family: ['detection', 'shopping'].includes(task) ? 'retailer-shared' : `${task}-context` }));
}
function row(c, config, repeat, accepted, quality = accepted ? 100 : 0) {
  return { caseId: c.id, task: c.task, family: c.family, config, repeat, accepted, quality, latencyMs: 100, costLowerUsd: 0.001, costUpperUsd: 0.001 };
}
async function analyze(t, cases, rows) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vision-stat-fixture-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const scores = path.join(dir, 'scores.json'), suite = path.join(dir, 'suite.json'), output = path.join(dir, 'analysis.json');
  await writeFile(scores, JSON.stringify({ rows }));
  await writeFile(suite, JSON.stringify({ cases }));
  await exec(process.execPath, [script, scores, suite, output, 'luna-medium', 'sol-low']);
  return JSON.parse(await readFile(output, 'utf8'));
}
function close(actual, expected) { assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} differs from ${expected}`); }

test('CLI analysis gives the right signed effect and interval for uniform wins, losses, and ties', async t => {
  for (const effect of [-1, 0, 1]) {
    const cases = fixtureCases();
    const base = effect === -1, challenger = effect === 1;
    const rows = cases.flatMap(c => [row(c, 'luna-medium', 1, base), row(c, 'sol-low', 1, challenger)]);
    const result = await analyze(t, cases, rows);
    assert.equal(result.matchedCases, 5); assert.equal(result.matchedCalls, 10);
    assert.equal(result.completeTaskCoverage, true); assert.equal(result.bootstrap.draws, 10000);
    close(result.differences.acceptance, effect);
    close(result.differences.quality, effect * 100);
    for (const endpoint of result.differences.acceptance95) close(endpoint, effect);
    for (const endpoint of result.differences.quality95) close(endpoint, effect * 100);
  }
});

test('CLI withholds overall effect and bootstrap when a task lacks usable matched reviews', async t => {
  const cases = fixtureCases();
  const rows = cases.flatMap(c => [row(c, 'luna-medium', 1, true), row(c, 'sol-low', 1, c.task === 'scene' ? null : true)]);
  const result = await analyze(t, cases, rows);
  assert.equal(result.matchedCases, 4); assert.equal(result.matchedCalls, 8);
  assert.equal(result.completeTaskCoverage, false);
  assert.equal(result.caseBalanced, null); assert.equal(result.differences, null);
  assert.equal(result.bootstrap.draws, 0);
  assert.ok(!result.cases.some(c => c.task === 'scene'));
});

test('CLI averages repeat results within cases and excludes unilateral attempts without losing their distinction from call weighting', async t => {
  const cases = fixtureCases();
  const first = cases[0], second = { ...first, id: 'detection-2', family: 'retailer-second' };
  cases.push(second);
  const rows = [
    row(first, 'luna-medium', 1, false), row(first, 'sol-low', 1, true),
    row(first, 'luna-medium', 2, false), row(first, 'sol-low', 2, true),
    row(second, 'luna-medium', 1, true), row(second, 'sol-low', 1, false),
    // No challenger repeat 2 exists: this failed baseline must not influence a paired comparison.
    row(second, 'luna-medium', 2, false),
    ...cases.filter(c => c.task !== 'detection').flatMap(c => [row(c, 'luna-medium', 1, true, 80), row(c, 'sol-low', 1, true, 80)]),
  ];
  const result = await analyze(t, cases, rows);
  assert.equal(result.matchedCases, 6); assert.equal(result.matchedCalls, 14);
  close(result.caseBalanced.baselineAcceptance, .825);
  close(result.caseBalanced.challengerAcceptance, .825);
  close(result.caseBalanced.baselineQuality, 69.5);
  close(result.caseBalanced.challengerQuality, 69.5);
  close(result.differences.acceptance, 0);
  assert.deepEqual(result.cases.find(c => c.id === second.id).repeats, [1]);
  assert.equal(result.callWeightedSummary['luna-medium'].attempts, 7);
  assert.equal(result.callWeightedSummary['luna-medium'].accepted, 5);
  assert.equal(result.callWeightedSummary['sol-low'].accepted, 6);
  assert.notEqual(result.callWeightedSummary['luna-medium'].acceptanceRate, result.callWeightedSummary['sol-low'].acceptanceRate);
});

test('scoring rejects a perfect-looking response when the runner reports an unexpected model', () => {
  const c = { id: 'scene-1', task: 'scene', family: 'scene-context', timeoutMs: 30000, request: { text: { format: { schema: { type: 'object', required: ['setting'], additionalProperties: false, properties: { setting: { type: 'string', minLength: 1 } } } } } } };
  const attempt = { config: 'luna-medium', repeat: 1, latencyMs: 100, httpStatus: 200, response: { apiStatus: 'completed', parsed: { setting: 'A softly lit courtyard with the garment unobstructed.' } }, reservedNanoUsd: 1000000 };
  const grade = { ratings: [4, 4, 4, 4], criticalFlags: [] };
  assert.equal(evaluateAttempt(c, attempt, {}, grade).accepted, true);
  const rejected = evaluateAttempt(c, { ...attempt, failure: 'unexpected_model' }, {}, grade);
  assert.equal(rejected.accepted, false); assert.equal(rejected.completed, false); assert.equal(rejected.quality, 0);
});
