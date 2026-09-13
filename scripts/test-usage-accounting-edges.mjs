// Offline regressions against the production reducer; no browser/provider I/O.
import assert from 'node:assert/strict';
import {
  recordProviderGeneration, normalizeUsageLedger, currentUsage,
  usageHistoryRows, resetActiveUsage, applyUsageSelectionBoundary,
} from '../src/shared/ai-usage.js';

const target = { runtime: 'local', provider: 'ollama', model: 'qwen3.5:9b' };
const usage = { inputTokens: 10, outputTokens: 2, totalTokens: 12 };
let now = 100;
const record = (ledger, extra = {}) => recordProviderGeneration(ledger,
  { ...target, usage, ...extra }, { now: ++now, id: () => `session-${now}` });
let checks = 0;
const test = (name, fn) => { fn(); checks++; console.log(`PASS ${name}`); };

test('long operation and receipt keys survive delta rollover and storage reload', () => {
  for (const original of [
    { operationId: 'ai:' + 'x'.repeat(150) },
    { operationId: 'initial', usage: { ...usage, receiptId: 'r'.repeat(155) } },
  ]) {
    let ledger = record(null, original);
    for (let i = 0; i < 200; i++) ledger = record(ledger, { operationId: `filler-${i}` });
    ledger = normalizeUsageLedger(JSON.parse(JSON.stringify(ledger)));
    const before = currentUsage(ledger, target);
    ledger = record(ledger, { ...original,
      ...(original.usage?.receiptId ? { operationId: 'recovery', replayed: true } : {}) });
    const after = currentUsage(ledger, target);
    assert.equal(before.requests, 201);
    assert.equal(after.requests, before.requests);
    assert.equal(after.totalTokens, 2412);
  }
});

test('evicted session receipt cannot become new usage after reset and model selection', () => {
  const original = { usage: { ...usage, receiptId: 's'.repeat(155) } };
  let ledger = record(null, original);
  for (let i = 0; i < 22; i++) {
    ledger = resetActiveUsage(ledger, { now: ++now, id: () => `reset-${now}` });
    ledger = record(ledger, { operationId: `reset-filler-${i}` });
  }
  ledger = applyUsageSelectionBoundary(ledger, { ...target, model: 'another-model' }, { now: ++now });
  const before = JSON.stringify(usageHistoryRows(ledger));
  ledger = record(normalizeUsageLedger(JSON.parse(JSON.stringify(ledger))),
    { ...original, replayed: true, operationId: 'recovered-old-session' });
  assert.equal(JSON.stringify(usageHistoryRows(ledger)), before);
  assert.equal(currentUsage(ledger, { ...target, model: 'another-model' }).requests, 0);
});

test('charged failures retain their counts after generation expansion and replay', () => {
  for (const failures of [0, 1, 2]) {
    const generations = [0, 1].map(i => ({ ...usage, receiptId: `failed-${failures}-${i}` }));
    const event = { operationId: 'failed', failures, generationAttempts: 2,
      reason: 'provider_charged_failure', usage: { generations } };
    let ledger = record(null, event);
    ledger = record(ledger, { ...event, operationId: 'recovered', replayed: true });
    const [history] = usageHistoryRows(ledger);
    assert.equal(history.requests, 2);
    assert.equal(history.successes, 2 - failures);
    assert.equal(history.failures, failures);
    assert.equal(history.totalTokens, 24);
  }
  const [history] = usageHistoryRows(record(null, { success: false,
    usage: { generations: [{ ...usage }, { ...usage }] } }));
  assert.equal(history.failures, 2);
  assert.equal(history.successes, 0);
});

test('per-generation outcomes remain authoritative without aggregate failure counts', () => {
  const [history] = usageHistoryRows(record(null, { usage: { generations: [
    { ...usage, receiptId: 'nested-success', success: true },
    { ...usage, receiptId: 'nested-failure', success: false },
  ] } }));
  assert.equal(history.requests, 2);
  assert.equal(history.successes, 1);
  assert.equal(history.failures, 1);
  assert.equal(history.totalTokens, 24);
});

console.log(`${checks}/${checks} usage accounting regressions passed.`);
