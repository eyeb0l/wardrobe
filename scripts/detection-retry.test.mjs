import test from 'node:test';
import assert from 'node:assert/strict';
import { DETECTION_RETRY_WAIT_MS, isDetectionRetryRunning } from '../src/detection-retry.mjs';

const now = Date.parse('2026-09-21T12:00:00Z');
const job = (status, createdAt = new Date(now).toISOString()) => ({ detectionRetryAttempt: { status, createdAt } });

test('a persisted dispatch marker has a bounded observation window', () => {
  assert.equal(isDetectionRetryRunning(job('started'), now), true);
  assert.equal(isDetectionRetryRunning(job('started'), now + DETECTION_RETRY_WAIT_MS - 1), true);
  assert.equal(isDetectionRetryRunning(job('started'), now + DETECTION_RETRY_WAIT_MS), false);
});

test('failed, completed and invalid dispatch markers do not lock review indefinitely', () => {
  for (const status of ['completed', 'failed', undefined]) assert.equal(isDetectionRetryRunning(job(status), now), false);
  assert.equal(isDetectionRetryRunning(job('started', 'invalid'), now), false);
  assert.equal(isDetectionRetryRunning(job('started', new Date(now + 1000).toISOString()), now), false);
  assert.equal(isDetectionRetryRunning({}, now), false);
});
