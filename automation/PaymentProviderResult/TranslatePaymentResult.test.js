import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { store, pool, events } from '../testkit.js';
import { translate, recordPaymentResult } from './TranslatePaymentResult.js';
import { requestPremiumCollection } from '../PremiumCollection/RequestPremiumCollection.js';

const webhook = (type, id = 'evt_1') => ({ id, type, idempotency_key: 'collection-P1-2026-12', failure_code: type === 'charge.failed' ? 'insufficient_funds' : undefined });
beforeEach(() => pool.query('TRUNCATE events'));
after(() => pool.end());

test('The provider payload maps to one of our events', () => {
  assert.deepEqual(translate(webhook('charge.succeeded')), { kind: 'collected', collectionId: 'collection-P1-2026-12' });
  assert.deepEqual(translate(webhook('charge.failed')), { kind: 'failed', collectionId: 'collection-P1-2026-12', reason: 'insufficient_funds' });
  assert.throws(() => translate(webhook('charge.refunded')), /UnknownProviderEvent/);
});

test('Given requested, when the provider reports success, then PremiumCollected', async () => {
  await requestPremiumCollection(store, { policyId: 'P1', period: '2026-12', amount: 85, now: new Date('2026-12-01T06:00:00Z') });
  assert.equal((await recordPaymentResult(store, webhook('charge.succeeded'))).type, 'PremiumCollected');
});

test('The same webhook delivered twice is recorded once', async () => {
  await requestPremiumCollection(store, { policyId: 'P1', period: '2026-12', amount: 85, now: new Date('2026-12-01T06:00:00Z') });
  await recordPaymentResult(store, webhook('charge.succeeded'));
  assert.equal(await recordPaymentResult(store, webhook('charge.succeeded')), null);
  assert.equal((await events(['PremiumCollected'])).length, 1);
});

test('A result for a collection we never requested is rejected', async () => {
  await assert.rejects(recordPaymentResult(store, webhook('charge.succeeded')), /UnknownCollection/);
});

test('Given requested, when the provider reports a failure, then PremiumCollectionAttemptFailed', async () => {
  await requestPremiumCollection(store, { policyId: 'P1', period: '2026-12', amount: 85, now: new Date('2026-12-01T06:00:00Z') });
  const event = await recordPaymentResult(store, webhook('charge.failed'));
  assert.deepEqual([event.type, event.data.attempt, event.data.reason], ['PremiumCollectionAttemptFailed', 1, 'insufficient_funds']);
});
