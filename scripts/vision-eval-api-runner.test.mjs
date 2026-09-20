import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { buildSchedule, createTransport, materializeImages, parseResponse, reservationNano, runEvaluation, usageCost } from './vision-eval-api-runner.mjs';

const fixture = (overrides = {}) => ({ id: 'case-1', task: 'detection', split: 'screen', family: 'family-1', timeoutMs: 1000, request: { model: 'gpt-5.6-luna', input: [{ role: 'user', content: [{ type: 'input_text', text: 'Find the visible garments.' }] }] }, ...overrides });
function completed(overrides = {}) {
  return { httpStatus: 200, requestId: 'req_mock', body: { id: 'resp_mock', model: 'gpt-5.6-luna', status: 'completed', service_tier: 'default', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"items":[]}' }] }], usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 100, cache_write_tokens: 500 }, output_tokens: 100, output_tokens_details: { reasoning_tokens: 80 } }, ...overrides } };
}
async function setup(t, cases = [fixture()], cap = 1000) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vision-api-runner-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const manifestPath = path.join(dir, 'suite.json');
  await writeFile(manifestPath, JSON.stringify({ outputCaps: { detection: cap }, cases }));
  return { manifestPath, ledgerDir: path.join(dir, 'ledger'), phase: 'calibration', configNames: ['luna-medium'], caseIds: cases.map(c => c.id), repeats: 1 };
}
const mocks = (create = async () => completed(), count = async () => ({ httpStatus: 200, body: { input_tokens: 1000 } })) => ({ create, count });

test('published cache partition and reasoning output are charged once', () => {
  const cost = usageCost('gpt-5.6-luna', completed().body.usage);
  assert.equal(cost.nanoUsd, 327000); // ordinary400*.2 + cached100*.02 + writes500*.25 + output100*1.2, per million.
  assert.equal(cost.reasoningTokens, 80);
  assert.equal(cost.exact, true);
  assert.equal(usageCost('gpt-5.6-luna', { input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 9, cache_write_tokens: 2 } }), null);
});
test('missing cache writes yields a narrow actual-token cost interval', () => {
  const u = structuredClone(completed().body.usage);
  delete u.input_tokens_details.cache_write_tokens;
  const cost = usageCost('gpt-5.6-luna', u);
  assert.equal(cost.exact, false);
  assert.equal(cost.lowerNanoUsd, 302000);
  assert.equal(cost.upperNanoUsd, 347000);
  assert.equal(usageCost('gpt-5.6-luna', { input_tokens: 1, output_tokens: 2 }), null);
});
test('long-context reservation accounts for full-request tier and write premium', () => {
  const short = reservationNano('gpt-5.6-sol', 1000, 1000);
  assert.equal(short.nanoUsd, 26530000);
  const long = reservationNano('gpt-5.6-sol', 272000, 1000);
  assert.equal(long.nanoUsd, (285856 * 10 + 1000 * 30) * 1000);
});
test('raw Responses output parser preserves refusals, incomplete status and JSON', () => {
  assert.deepEqual(parseResponse(completed().body).parsed, { items: [] });
  const parsed = parseResponse({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ content: [{ type: 'refusal', refusal: 'No' }, { type: 'output_text', text: '{' }] }] });
  assert.equal(parsed.apiStatus, 'incomplete'); assert.equal(parsed.parsed, null); assert.deepEqual(parsed.refusals, ['No']);
});
test('dry run is network-free, private, and freezes schedule before execution', async t => {
  const options = await setup(t);
  const transport = mocks(() => assert.fail('generation in dry run'), () => assert.fail('count in dry run'));
  const result = await runEvaluation({ ...options, transport });
  assert.equal(result.dryRun, true); assert.equal(result.attempts, 0);
  assert.equal((await stat(path.join(options.ledgerDir, 'ledger.json'))).mode & 0o777, 0o600);
  await assert.rejects(runEvaluation({ ...options, repeats: 2, transport }), /Frozen phase schedule/);
});
test('completed attempts resume without duplicates; calibration reused by screening', async t => {
  const options = await setup(t); let creates = 0; let counts = 0;
  const transport = mocks(async () => { creates++; return completed(); }, async () => { counts++; return { httpStatus: 200, body: { input_tokens: 1000 } }; });
  const first = await runEvaluation({ ...options, run: true, transport });
  assert.equal(first.completed, 1); assert.equal(first.exactUsageUsd, 0.000327);
  await runEvaluation({ ...options, run: true, transport });
  await runEvaluation({ ...options, phase: 'screen', run: true, transport });
  assert.equal(creates, 1); assert.equal(counts, 1);
  const ledger = JSON.parse(await readFile(path.join(options.ledgerDir, 'ledger.json')));
  assert.equal(Object.values(ledger.attempts)[0].response.outputText, '{"items":[]}');
});
test('missing cache writes releases unused output reservation while preserving safe upper charge', async t => {
  const options = await setup(t);
  const response = completed(); delete response.body.usage.input_tokens_details.cache_write_tokens;
  const result = await runEvaluation({ ...options, run: true, transport: mocks(async () => response) });
  assert.equal(result.committedUsd, 0.000347); assert.equal(result.exactUsageUsd, 0);
  const ledger = JSON.parse(await readFile(path.join(options.ledgerDir, 'ledger.json')));
  assert.ok(Object.values(ledger.attempts)[0].reservedNanoUsd > 347000);
});
test('timeouts preserve full reservation, allow other cases, and prohibit automatic replay', async t => {
  const options = await setup(t, [fixture(), fixture({ id: 'case-2' })]); let creates = 0;
  const transport = mocks(async () => { creates++; if (creates === 1) throw new Error('sensitive error'); return completed(); });
  const result = await runEvaluation({ ...options, run: true, transport });
  assert.equal(result.stopped, null); assert.equal(creates, 2);
  assert.equal(result.exactUsageUsd, 0.000327); assert.ok(result.reservedUnreconciledUsd > 0);
  assert.ok(Math.abs(result.committedUsd - result.exactUsageUsd - result.reservedUnreconciledUsd) < 1e-12);
  assert.ok(result.committedUsd < 10);
  await runEvaluation({ ...options, run: true, transport });
  assert.equal(creates, 2);
  assert.ok(!(await readFile(path.join(options.ledgerDir, 'ledger.json'), 'utf8')).includes('sensitive error'));
});
test('HTTP error or missing usage stays reserved; no retry or zero-cost assumption', async t => {
  const options = await setup(t);
  const result = await runEvaluation({ ...options, run: true, transport: mocks(async () => ({ httpStatus: 500, body: { error: { message: 'failed' } } })) });
  assert.equal(result.stopped, null); assert.equal(result.uncertain, 1); assert.ok(result.committedUsd > 0);
});
test('incomplete valid responses are retained and charged', async t => {
  const options = await setup(t);
  const result = await runEvaluation({ ...options, run: true, transport: mocks(async () => completed({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } })) });
  assert.equal(result.incomplete, 1); assert.equal(result.exactUsageUsd, 0.000327);
});
test('counter rejection sends no generation', async t => {
  const options = await setup(t); let creates = 0;
  await assert.rejects(runEvaluation({ ...options, run: true, transport: mocks(async () => { creates++; }, async () => ({ httpStatus: 400, body: {} })) }), /counter rejected/);
  assert.equal(creates, 0);
});
test('matched block is refused whole when prior charges plus reservations exceed $10', async t => {
  const options = await setup(t); let creates = 0;
  await runEvaluation(options);
  const ledgerPath = path.join(options.ledgerDir, 'ledger.json');
  const ledger = JSON.parse(await readFile(ledgerPath));
  ledger.attempts.previous = { status: 'completed', reservedNanoUsd: 9999999000, chargedNanoUsd: 9999999000 };
  await writeFile(ledgerPath, JSON.stringify(ledger));
  const result = await runEvaluation({ ...options, run: true, transport: mocks(async () => { creates++; }) });
  assert.equal(result.stopped, 'budget_before_matched_block'); assert.equal(creates, 0); assert.equal(result.committedUsd, 9.999999);
});
test('unreconciled usage bounds remain included when admitting the next block', async t => {
  const options = await setup(t); await runEvaluation(options);
  const ledgerPath = path.join(options.ledgerDir, 'ledger.json');
  const ledger = JSON.parse(await readFile(ledgerPath));
  ledger.attempts.previous = { status: 'completed', reservedNanoUsd: 10e9, usageUpperNanoUsd: 9999999000, chargedNanoUsd: null };
  await writeFile(ledgerPath, JSON.stringify(ledger));
  const result = await runEvaluation({ ...options, run: true, transport: mocks(() => assert.fail('overspend')) });
  assert.equal(result.stopped, 'budget_before_matched_block');
});
test('local images are frozen bytes, remote URLs and tool inputs rejected', async t => {
  const options = await setup(t); const baseDir = path.dirname(options.manifestPath);
  await writeFile(path.join(baseDir, 'neutral.jpg'), Buffer.from('image-bytes'));
  const item = await materializeImages({ type: 'input_image', image_path: 'neutral.jpg', detail: 'high' }, baseDir);
  assert.equal(item.image_url, 'data:image/jpeg;base64,aW1hZ2UtYnl0ZXM='); assert.equal(item.detail, 'high'); assert.equal(item.image_path, undefined);
  await assert.rejects(materializeImages({ type: 'input_image', image_url: 'https://example.com/image.jpg' }, baseDir), /Freeze images/);
  const c = fixture(); c.request.tools = [{ type: 'web_search' }];
  await assert.rejects(buildSchedule({ manifest: { cases: [c], outputCaps: { detection: 1000 } }, baseDir, phase: 'screen', configNames: ['luna-medium'], caseIds: ['case-1'], repeats: 1 }), /Unsupported production request field/);
});
test('transport uses exact official endpoints, no retry and no generation-only counting fields', async () => {
  const calls = [];
  const transport = createTransport('mock-key', async (url, options) => { calls.push({ url, options }); return { status: 200, headers: { get: () => 'request-mock' }, text: async () => '{"input_tokens":3}' }; });
  await transport.count({ model: 'gpt-5.6-luna', input: 'x', max_output_tokens: 900, store: false, service_tier: 'default', reasoning: { effort: 'low' } }, 'id');
  assert.equal(calls[0].url, 'https://api.openai.com/v1/responses/input_tokens');
  const payload = JSON.parse(calls[0].options.body); assert.equal(payload.max_output_tokens, undefined); assert.equal(payload.reasoning.effort, 'low');
  await transport.create({ model: 'gpt-5.6-luna', input: 'x' }, 500, 'id');
  assert.equal(calls[1].url, 'https://api.openai.com/v1/responses'); assert.equal(calls.length, 2);
});

test('cost envelope violations durably halt later paid calls', async t => {
  const options = await setup(t);
  const result = await runEvaluation({ ...options, run: true, transport: mocks(async () => completed({ service_tier: 'priority' })) });
  assert.equal(result.stopped, 'cost_envelope_violation');
  await assert.rejects(runEvaluation({ ...options, run: true, transport: mocks(() => assert.fail('must halt')) }), /cost-envelope violation/);
});
test('crash reservation is never replayed and remains committed after resume', async t => {
  const options = await setup(t); await runEvaluation(options);
  const ledgerPath = path.join(options.ledgerDir, 'ledger.json');
  const ledger = JSON.parse(await readFile(ledgerPath));
  const schedule = JSON.parse(await readFile(path.join(options.ledgerDir, 'calibration-schedule.json')));
  ledger.attempts[schedule.items[0].id] = { status: 'reserved', reservedNanoUsd: 1000000, chargedNanoUsd: null };
  await writeFile(ledgerPath, JSON.stringify(ledger));
  const result = await runEvaluation({ ...options, run: true, transport: mocks(() => assert.fail('crash replay')) });
  assert.equal(result.committedUsd, 0.001); assert.equal(result.uncertain, 1);
});

test('confirmation accepts frozen production suite confirm split alias', async () => {
  const manifest = { cases: [fixture({ split: 'confirm' })], outputCaps: { detection: 1000 } };
  const schedule = await buildSchedule({ manifest, baseDir: '.', phase: 'confirmation', configNames: ['luna-medium'], caseIds: ['case-1'], repeats: 1 });
  assert.equal(schedule.items.length, 1); assert.equal(schedule.items[0].split, 'confirm');
  await assert.rejects(buildSchedule({ manifest, baseDir: '.', phase: 'screen', configNames: ['luna-medium'], caseIds: ['case-1'], repeats: 1 }), /Case split conflicts/);
});

test('diagnostic extension shares the existing spending ledger without replacing earlier schedules', async t => {
  const options = await setup(t);
  await runEvaluation({ ...options, run: true, transport: mocks() });
  const prior = await readFile(path.join(options.ledgerDir, 'calibration-schedule.json'), 'utf8');
  await writeFile(options.manifestPath, JSON.stringify({ outputCaps: { detection: 1000 }, cases: [fixture({ id: 'diagnostic-bag', split: 'diagnostic' })] }));
  const result = await runEvaluation({ ...options, phase: 'diagnostic', caseIds: ['diagnostic-bag'], run: true, transport: mocks() });
  assert.equal(result.attempts, 2);
  assert.equal(result.exactUsageUsd, 2 * 327000 / 1e9);
  assert.equal(await readFile(path.join(options.ledgerDir, 'calibration-schedule.json'), 'utf8'), prior);
  await assert.rejects(runEvaluation({ ...options, phase: 'screen', caseIds: ['diagnostic-bag'] }), /Case split conflicts/);
});

test('rescue phase compares explicit Terra efforts without changing production payload fields', async () => {
  const original = fixture({ id: 'rescue-case', split: 'rescue' });
  const schedule = await buildSchedule({ manifest: { cases: [original], outputCaps: { detection: 1000 } }, baseDir: '.', phase: 'rescue', configNames: ['luna-medium', 'terra-low', 'terra-medium'], caseIds: ['rescue-case'], repeats: 2 });
  assert.equal(schedule.items.length, 6);
  for (const item of schedule.items) {
    assert.deepEqual(item.payload.input, original.request.input);
    assert.equal(item.payload.reasoning.effort, item.config.endsWith('-low') ? 'low' : 'medium');
    assert.equal(item.payload.model, item.config.startsWith('terra-') ? 'gpt-5.6-terra' : 'gpt-5.6-luna');
  }
  await assert.rejects(buildSchedule({ manifest: { cases: [original], outputCaps: { detection: 1000 } }, baseDir: '.', phase: 'diagnostic', configNames: ['terra-medium'], caseIds: ['rescue-case'], repeats: 1 }), /Case split conflicts/);
});

test('provider echoed API key is redacted from both raw text and parsed bodies', async () => {
  const apiKey = 'mock-provider-echo-key';
  const transport = createTransport(apiKey, async () => ({ status: 401, headers: { get: () => 'req-error' }, text: async () => JSON.stringify({ error: { message: `Invalid key: ${apiKey}; repeated ${apiKey}` } }) }));
  const result = await transport.create({ model: 'gpt-5.6-luna', input: 'x' }, 500, 'id');
  assert.ok(!JSON.stringify(result).includes(apiKey));
  assert.equal(result.body.error.message, 'Invalid key: [REDACTED_API_KEY]; repeated [REDACTED_API_KEY]');
  assert.equal((result.raw.match(/REDACTED_API_KEY/g) || []).length, 2);
});

const allConfigs = ['luna-low', 'luna-medium', 'luna-high', 'terra-low', 'sol-low'];
test('bounded waves reserve full matched block before dispatch and persist concurrent results safely', async t => {
  const options = { ...await setup(t), configNames: allConfigs, concurrency: 2 };
  let active = 0, maxActive = 0, creates = 0;
  const transport = mocks(async payload => {
    active++; creates++; maxActive = Math.max(active, maxActive);
    const ledger = JSON.parse(await readFile(path.join(options.ledgerDir, 'ledger.json')));
    assert.equal(Object.keys(ledger.attempts).length, 5);
    assert.ok(Object.values(ledger.attempts).every(a => a.reservedNanoUsd > 0));
    assert.ok(Object.values(ledger.attempts).reduce((n, a) => n + (a.chargedNanoUsd ?? a.reservedNanoUsd), 0) <= 10e9);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    return completed({ model: payload.model });
  });
  const result = await runEvaluation({ ...options, run: true, transport });
  assert.equal(maxActive, 2); assert.equal(creates, 5); assert.equal(result.completed, 5); assert.equal(result.reservedNotSent, 0);
  assert.equal(result.reservedUnreconciledUsd, 0); assert.ok(result.committedUsd < 10);
  // Concurrency is an execution setting, not part of the frozen prompt/schedule.
  await runEvaluation({ ...options, concurrency: 5, run: true, transport });
  assert.equal(creates, 5);
});
test('cost-envelope violation settles whole launched wave and releases only unsent future waves', async t => {
  const options = { ...await setup(t), configNames: allConfigs, concurrency: 2 }; let creates = 0;
  const result = await runEvaluation({ ...options, run: true, transport: mocks(async payload => {
    creates++;
    return completed({ model: payload.model, service_tier: creates === 1 ? 'priority' : 'default' });
  }) });
  assert.equal(creates, 2); assert.equal(result.stopped, 'cost_envelope_violation');
  assert.equal(result.attempts, 2); assert.equal(result.pendingCalls, 3); assert.equal(result.completed, 1);
  const ledger = JSON.parse(await readFile(path.join(options.ledgerDir, 'ledger.json')));
  assert.equal(Object.keys(ledger.attempts).length, 2);
  assert.ok(Object.values(ledger.attempts).every(a => a.dispatchState === 'sending'));
  await assert.rejects(runEvaluation({ ...options, run: true, transport: mocks(() => assert.fail('halted dispatch')) }), /cost-envelope violation/);
});
test('uncertain call in a parallel wave retains reserve while later waves complete', async t => {
  const options = { ...await setup(t), configNames: allConfigs, concurrency: 2 }; let creates = 0;
  const transport = mocks(async payload => { if (++creates === 1) throw Error('timeout'); return completed({ model: payload.model }); });
  const result = await runEvaluation({ ...options, run: true, transport });
  assert.equal(creates, 5); assert.equal(result.completed, 4); assert.equal(result.uncertain, 1);
  assert.ok(result.reservedUnreconciledUsd > 0); assert.ok(result.committedUsd < 10);
  await runEvaluation({ ...options, run: true, transport }); assert.equal(creates, 5);
});
test('crash recovery can release explicitly never-sent reservations without replaying sent calls', async t => {
  const options = await setup(t); await runEvaluation(options);
  const ledgerPath = path.join(options.ledgerDir, 'ledger.json');
  const ledger = JSON.parse(await readFile(ledgerPath));
  const schedule = JSON.parse(await readFile(path.join(options.ledgerDir, 'calibration-schedule.json')));
  ledger.attempts[schedule.items[0].id] = { status: 'reserved', dispatchState: 'not_sent', reservedNanoUsd: 1000000, chargedNanoUsd: null };
  await writeFile(ledgerPath, JSON.stringify(ledger)); let creates = 0;
  const result = await runEvaluation({ ...options, run: true, transport: mocks(async () => { creates++; return completed(); }) });
  assert.equal(creates, 1); assert.equal(result.completed, 1); assert.equal(result.uncertain, 0);
});
test('invalid concurrency is rejected before ledger initialization or network access', async t => {
  const options = await setup(t);
  for (const concurrency of [0, 6, 1.5, NaN]) await assert.rejects(runEvaluation({ ...options, concurrency, run: true, transport: mocks(() => assert.fail('invalid concurrency')) }), /Concurrency must be 1..5/);
});

test('two matched blocks launch four bounded calls only after all are reserved and unique counts settle', async t => {
  const options = { ...await setup(t, [fixture(), fixture({ id: 'case-2' })]), configNames: ['luna-medium', 'sol-low'], concurrency: 4, blocksPerBatch: 2 };
  let active = 0, maxActive = 0, countsActive = 0, maxCountsActive = 0, countsDone = 0, creates = 0;
  const transport = mocks(async payload => {
    active++; creates++; maxActive = Math.max(active, maxActive);
    assert.equal(countsDone, 2);
    const ledger = JSON.parse(await readFile(path.join(options.ledgerDir, 'ledger.json')));
    assert.equal(Object.keys(ledger.attempts).length, 4);
    assert.ok(Object.values(ledger.attempts).every(a => a.dispatchState === 'sending' && a.reservedNanoUsd > 0));
    assert.ok(Object.values(ledger.attempts).reduce((n, a) => n + a.reservedNanoUsd, 0) <= 10e9);
    await new Promise(resolve => setTimeout(resolve, 5)); active--;
    return completed({ model: payload.model });
  }, async () => {
    countsActive++; maxCountsActive = Math.max(maxCountsActive, countsActive);
    await new Promise(resolve => setTimeout(resolve, 5)); countsActive--; countsDone++;
    return { httpStatus: 200, body: { input_tokens: 1000 } };
  });
  const result = await runEvaluation({ ...options, run: true, transport });
  assert.equal(creates, 4); assert.equal(maxActive, 4); assert.equal(maxCountsActive, 2);
  assert.equal(result.completed, 4); assert.equal(result.reservedNotSent, 0); assert.equal(result.blocksPerBatch, 2);
  // Batch size can change at resume without changing frozen request or schedule identity.
  await runEvaluation({ ...options, blocksPerBatch: 1, run: true, transport }); assert.equal(creates, 4);
});

test('batch budget refusal sends neither block even when either alone would fit', async t => {
  const options = { ...await setup(t, [fixture(), fixture({ id: 'case-2' })]), configNames: ['luna-medium', 'sol-low'], concurrency: 4, blocksPerBatch: 2 };
  await runEvaluation(options);
  const ledgerPath = path.join(options.ledgerDir, 'ledger.json');
  const ledger = JSON.parse(await readFile(ledgerPath));
  const oneBlockNano = reservationNano('gpt-5.6-luna', 1000, 1000).nanoUsd + reservationNano('gpt-5.6-sol', 1000, 1000).nanoUsd;
  const previousNano = 10e9 - Math.floor(oneBlockNano * 1.5);
  ledger.attempts.previous = { status: 'completed', reservedNanoUsd: previousNano, chargedNanoUsd: previousNano };
  await writeFile(ledgerPath, JSON.stringify(ledger)); let creates = 0;
  const transport = mocks(async payload => { creates++; return completed({ model: payload.model }); });
  const result = await runEvaluation({ ...options, run: true, transport });
  assert.equal(result.stopped, 'budget_before_matched_batch'); assert.equal(creates, 0);
  assert.equal(result.pendingCalls, 4); assert.equal(result.attempts, 1);
  const after = JSON.parse(await readFile(ledgerPath)); assert.equal(Object.keys(after.attempts).length, 1);
  // Explicitly returning to smaller matched batches is allowed and still preserves pairs.
  const resumed = await runEvaluation({ ...options, blocksPerBatch: 1, run: true, transport });
  assert.equal(creates, 4); assert.equal(resumed.completed, 5); assert.ok(resumed.committedUsd <= 10);
});

test('one parallel count rejection waits for other counters and sends zero paid batch requests', async t => {
  const options = { ...await setup(t, [fixture(), fixture({ id: 'case-2' })]), configNames: ['luna-medium', 'sol-low'], concurrency: 4, blocksPerBatch: 2 };
  let countsDone = 0, creates = 0;
  const transport = mocks(async () => { creates++; return completed(); }, async payload => {
    await new Promise(resolve => setTimeout(resolve, payload.model === 'gpt-5.6-sol' ? 1 : 10)); countsDone++;
    return payload.model === 'gpt-5.6-sol' ? { httpStatus: 400, body: {} } : { httpStatus: 200, body: { input_tokens: 1000 } };
  });
  await assert.rejects(runEvaluation({ ...options, run: true, transport }), /counter rejected/);
  assert.equal(countsDone, 2); assert.equal(creates, 0);
  const ledger = JSON.parse(await readFile(path.join(options.ledgerDir, 'ledger.json')));
  assert.equal(Object.keys(ledger.attempts).length, 0);
  const counts = JSON.parse(await readFile(path.join(options.ledgerDir, 'input-counts.json')));
  assert.equal(Object.keys(counts).length, 1);
});

test('identical payloads across repeated matched blocks are counted only once per hash', async t => {
  const options = { ...await setup(t), repeats: 3, concurrency: 3, blocksPerBatch: 3 };
  let counts = 0, creates = 0;
  const result = await runEvaluation({ ...options, run: true, transport: mocks(async () => { creates++; return completed(); }, async () => { counts++; return { httpStatus: 200, body: { input_tokens: 1000 } }; }) });
  assert.equal(counts, 1); assert.equal(creates, 3); assert.equal(result.completed, 3);
  const stored = JSON.parse(await readFile(path.join(options.ledgerDir, 'input-counts.json')));
  assert.equal(Object.keys(stored).length, 1);
});

test('invalid blocks-per-batch values fail before touching ledger or network', async t => {
  const options = await setup(t);
  for (const blocksPerBatch of [0, 4, 1.5, NaN]) await assert.rejects(runEvaluation({ ...options, blocksPerBatch, run: true, transport: mocks(() => assert.fail('invalid batch size')) }), /Blocks per batch must be 1..3/);
});
