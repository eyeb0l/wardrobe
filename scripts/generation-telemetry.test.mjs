import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { withStorage } from './storage-fs.mjs';
import { apiTelemetry, garmentTelemetry, generationAttempt, manualTelemetry, readTelemetry, summarizeTelemetry } from './generation-telemetry.mjs';

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wardrobe-telemetry-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const garment = garmentTelemetry({ id: 'body1', part: 'wholebody_up', name: 'Black bodysuit' });
const context = { episodeId: 'episode1', generationType: 'garment_modeled', pipelineAttempt: 1, attemptNumber: 1, garments: [garment] };

test('structured refusal signals distinguish moderation from technical and authentication failures', () => {
  for (const code of ['moderation_blocked', 'content_policy_violation']) assert.equal(apiTelemetry({ status: 400 }, { error: { code } }).refused, true);
  for (const status of [400, 401, 403, 429, 500]) assert.equal(apiTelemetry({ status }, { error: { code: 'invalid_request_error', message: 'PRIVATE PROMPT' } }).refused, false);
  assert.equal(apiTelemetry({ status: 200 }, { data: [{ refusal: 'PRIVATE REFUSAL' }] }).refused, true);
  assert.equal(apiTelemetry({ status: 400 }, { error: { code: 'https://user:secret@private.invalid', type: 'secret text' } }).apiCode, null);
});

test('durable records omit prompts, messages and URL credentials and preserve unknown interruptions', async t => {
  const dir = await fixture(t);
  const attempt = generationAttempt(dir, context);
  await attempt.start({ model: 'test-model', baseUrl: 'https://user:password@provider.invalid/v1?secret=key', prompt: 'PRIVATE PROMPT', images: [Buffer.from('PRIVATE IMAGE')] });
  assert.equal((await readTelemetry(dir))[0].outcome, 'unknown');
  attempt.observe({ status: 400 }, { error: { code: 'moderation_blocked', type: 'image_generation_user_error', message: 'PRIVATE PROMPT' } });
  await attempt.finish(false, new Error('PRIVATE ERROR'));
  const records = await readTelemetry(dir);
  assert.equal(records.length, 1);
  assert.equal(records[0].outcome, 'refused');
  assert.equal(records[0].attemptNumber, 1);
  assert.equal(records[0].provider, 'provider.invalid');
  for (const secret of ['PRIVATE', 'password', '?secret', '/v1']) assert.ok(!JSON.stringify(records).includes(secret));
  assert.equal(records[0].garments[0].subtype, 'bodysuit');
  await manualTelemetry(dir, context, 'upload1', 'uploaded');
  await manualTelemetry(dir, context, 'upload1', 'uploaded');
  assert.equal((await readTelemetry(dir)).length, 2, 'manual delivery is idempotent');
});

test('telemetry storage failures do not change generation results', async t => {
  const dir = await fixture(t);
  t.mock.method(console, 'warn', () => {});
  await withStorage({ ...fs, mkdir: async () => { throw new Error('database credentials'); } }, async () => {
    const attempt = generationAttempt(dir, context);
    await attempt.start({ model: 'test', baseUrl: 'https://provider.invalid', prompt: 'prompt' });
    await attempt.finish(true);
    await manualTelemetry(dir, context, 'upload', 'uploaded');
  });
  assert.deepEqual(await readTelemetry(dir), []);
});

function attempt(episodeId, pipelineAttempt, outcome, extra = {}) {
  return { ...context, id: `${episodeId}-${pipelineAttempt}`, kind: 'attempt', episodeId, pipelineAttempt, attemptNumber: pipelineAttempt,
    outcome, startedAt: `2026-09-21T00:00:0${pipelineAttempt}.000Z`, provider: 'provider', model: 'model', promptHash: 'prompt', referencesHash: 'refs', ...extra };
}

test('recovery denominators exclude untried and unknown retries; category cohorts deduplicate garments', () => {
  const records = [
    attempt('success', 1, 'succeeded'),
    attempt('recovered', 1, 'refused'), attempt('recovered', 2, 'succeeded'),
    attempt('hard', 1, 'refused'), attempt('hard', 2, 'refused'), attempt('hard', 3, 'refused'),
    attempt('untried', 1, 'refused'),
    attempt('unknown', 1, 'refused'), attempt('unknown', 2, 'unknown'),
    attempt('technical', 1, 'technical_failure'),
    { ...context, kind: 'manual', episodeId: 'hard', action: 'uploaded', at: '2026-09-21T01:00:00Z' },
    { ...context, kind: 'manual', episodeId: 'hard', action: 'approved', at: '2026-09-21T01:01:00Z' },
  ];
  const report = summarizeTelemetry(records);
  assert.deepEqual(report.overall.firstAttemptSuccess, { numerator: 1, denominator: 6, rate: 1 / 6 });
  assert.deepEqual(report.overall.eventualRetryRecovery, { numerator: 1, denominator: 2, rate: 0.5 });
  assert.equal(report.overall.secondAttemptRecovery.rate, 0.5);
  assert.equal(report.overall.observedHardRefusal.numerator, 1);
  assert.equal(report.overall.recoveryAmongAllInitiallyRefused.denominator, 4);
  assert.equal(report.overall.unknownAttempts, 1);
  assert.equal(report.overall.refusedWithoutRetry, 1);
  assert.equal(report.overall.manualAfterRefusalEpisodes, 1);
  assert.equal(report.overall.manualApprovedEpisodes, 1);
  assert.equal(report.cohorts.find(c => c.category === 'subtype:bodysuit').episodes, 6);
  const multi = summarizeTelemetry([attempt('multi', 1, 'refused', { garments: [garment, { ...garment, id: 'body2' }] })]);
  assert.equal(multi.cohorts.find(c => c.category === 'subtype:bodysuit').episodes, 1);
  assert.equal(summarizeTelemetry([]).overall.firstAttemptSuccess.rate, null);
});

test('changed models and prompts remain visible without crediting a different model with recovery', () => {
  const report = summarizeTelemetry([attempt('changed', 1, 'refused'), attempt('changed', 2, 'succeeded', { model: 'other', promptHash: 'changed' })]);
  assert.equal(report.overall.eventualRetryRecovery.rate, 1);
  assert.equal(report.overall.sameModelRetryRecovery.rate, 0);
  assert.equal(report.overall.retriesWithChangedInputs, 1);
  assert.equal(report.cohorts[0].model, 'model', 'episode attributed to initial model');
});


test('missing telemetry cannot masquerade as first-attempt success or a second-attempt recovery', () => {
  const report = summarizeTelemetry([attempt('missing-first', 2, 'succeeded'), attempt('missing-second', 1, 'refused'), attempt('missing-second', 3, 'succeeded')]);
  assert.equal(report.overall.incompleteEpisodes, 2);
  assert.equal(report.overall.firstAttemptSuccess.denominator, 1);
  assert.equal(report.overall.firstAttemptSuccess.numerator, 0);
  assert.equal(report.overall.secondAttemptRecovery.denominator, 0);
  assert.equal(report.overall.eventualRetryRecovery.rate, 1);
});
