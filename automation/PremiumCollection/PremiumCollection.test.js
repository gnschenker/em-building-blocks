import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { store, pool, given, runProjections, reset, events } from '../testkit.js';
import { PolicyIssued, PolicyLapsed, CollectionRunStarted, fakeProvider, at } from '../fixtures.js';
import { premiumsToCollectProjection, listPremiumsToCollect, listNeedsAttention, listStaleRequests } from './PremiumsToCollect.js';
import { requestPremiumCollection } from './RequestPremiumCollection.js';
import { processPremiumCollection, processStaleRequests } from './CollectionProcessor.js';
import { recordPaymentResult } from '../PaymentProviderResult/TranslatePaymentResult.js';

const DUE = '2026-12-01T06:00:00Z';
const clock = at('2026-12-01T06:05:00Z');
const item = (policyId, amount = 85, attempt = 0) => ({ collectionId: `collection-${policyId}-2026-12`, policyId, period: '2026-12', amount, attempt });
const project = () => runProjections(premiumsToCollectProjection);
beforeEach(() => reset([premiumsToCollectProjection], ['policies_in_force', 'premiums_to_collect']));
after(() => pool.end());

test('The run puts one row per policy in force on the list', async () => {
  await given(PolicyIssued('P1'), PolicyIssued('P2', 120), PolicyIssued('P3'), PolicyLapsed('P3'), CollectionRunStarted('2026-12', DUE));
  await project();
  assert.deepEqual(await listPremiumsToCollect(pool), [item('P1'), item('P2', 120)]);
});

test('Given already requested, the same request is rejected', async () => {
  await requestPremiumCollection(store, { policyId: 'P1', period: '2026-12', amount: 85, now: clock() });
  await assert.rejects(requestPremiumCollection(store, { policyId: 'P1', period: '2026-12', amount: 85, now: clock() }), /PremiumCollectionAlreadyRequested/);
});

test('Running the processor twice charges each policy once', async () => {
  await given(PolicyIssued('P1'), PolicyIssued('P2'), CollectionRunStarted('2026-12', DUE));
  await project();
  const provider = fakeProvider();
  await processPremiumCollection({ pool, store, provider, clock });
  await processPremiumCollection({ pool, store, provider, clock }); // list not caught up yet: same rows again
  assert.deepEqual(provider.calls, ['collection-P1-2026-12', 'collection-P2-2026-12']);
  await project();
  assert.deepEqual(await listPremiumsToCollect(pool), []);
});

test('Two processors at once still charge once', async () => {
  await given(PolicyIssued('P1'), CollectionRunStarted('2026-12', DUE));
  await project();
  const provider = fakeProvider();
  await Promise.all([1, 2, 3].map(() => processPremiumCollection({ pool, store, provider, clock })));
  assert.deepEqual(provider.calls, ['collection-P1-2026-12']);
  assert.equal((await events(['PremiumCollectionRequested'])).length, 1);
});

test('A new period is a new collection, not a duplicate', async () => {
  await given(PolicyIssued('P1'), CollectionRunStarted('2026-12', DUE), CollectionRunStarted('2027-01', '2027-01-01T06:00:00Z'));
  await project();
  const provider = fakeProvider();
  await processPremiumCollection({ pool, store, provider, clock });
  assert.deepEqual(provider.calls, ['collection-P1-2026-12', 'collection-P1-2027-01']);
});

// Retry and escalation.
const runOnce = async (provider, time) => {
  await project();
  await processPremiumCollection({ pool, store, provider, clock: at(time) });
  await project();
};

test('Two failures keep it in the normal lane, each one recorded', async () => {
  await given(PolicyIssued('P1'), CollectionRunStarted('2026-12', DUE));
  const provider = fakeProvider({ down: ['P1'] });
  await runOnce(provider, '2026-12-01T06:05:00Z');
  await runOnce(provider, '2026-12-01T07:05:00Z');
  assert.deepEqual((await events(['PremiumCollectionAttemptFailed'])).map((e) => [e.attempt, e.reason]),
    [[1, 'ProviderTimeout'], [2, 'ProviderTimeout']]);
  assert.deepEqual(await listPremiumsToCollect(pool), [item('P1', 85, 2)]);
  assert.deepEqual(await listNeedsAttention(pool), []);
});

test('The third failure moves it to needs attention, and the processor leaves it alone', async () => {
  await given(PolicyIssued('P1'), PolicyIssued('P2'), CollectionRunStarted('2026-12', DUE));
  const provider = fakeProvider({ down: ['P1'] });
  for (const time of ['06:05', '07:05', '08:05']) await runOnce(provider, `2026-12-01T${time}:00Z`);
  assert.deepEqual(await listNeedsAttention(pool), [{ ...item('P1', 85, 3), reason: 'ProviderTimeout' }]);
  assert.deepEqual(await listPremiumsToCollect(pool), []);
  await runOnce(provider, '2026-12-01T09:05:00Z');
  assert.equal(provider.calls.filter((k) => k === 'collection-P1-2026-12').length, 3); // no fourth call
  assert.deepEqual(provider.charges, ['collection-P2-2026-12']); // the other policy was not held up
});

// Stale resend: a crash after the request, before the charge.
test('A request with no provider result is charged again later, with the same key, once', async () => {
  await given(PolicyIssued('P1'), CollectionRunStarted('2026-12', DUE));
  await project();
  await requestPremiumCollection(store, { ...item('P1'), now: new Date(DUE) }); // recorded, then the process died
  await project();
  assert.deepEqual(await listPremiumsToCollect(pool), []); // the row is no longer open...
  assert.deepEqual(await listStaleRequests(pool, new Date('2026-12-01T06:30:00Z')), []); // ...and not stale yet

  const provider = fakeProvider();
  const later = at('2026-12-01T07:30:00Z');
  await processStaleRequests({ pool, store, clock: later });
  await runOnce(provider, '2026-12-01T07:30:00Z');
  assert.deepEqual(provider.calls, ['collection-P1-2026-12']);
  assert.equal((await events(['PremiumCollectionAttemptFailed']))[0].reason, 'NoProviderResult');
});

test('A slow provider that did charge is not charged twice: same key, provider dedupes', async () => {
  await given(PolicyIssued('P1'), CollectionRunStarted('2026-12', DUE));
  const provider = fakeProvider();
  await runOnce(provider, '2026-12-01T06:05:00Z'); // charged, webhook not here yet
  await processStaleRequests({ pool, store, clock: at('2026-12-01T07:30:00Z') });
  await runOnce(provider, '2026-12-01T07:30:00Z'); // resent with the same key
  const webhook = (id) => ({ id, type: 'charge.succeeded', idempotency_key: 'collection-P1-2026-12' });
  await recordPaymentResult(store, webhook('evt_1'));
  await recordPaymentResult(store, webhook('evt_2')); // the provider answers the resend too
  assert.deepEqual(provider.calls, ['collection-P1-2026-12', 'collection-P1-2026-12']);
  assert.deepEqual(provider.charges, ['collection-P1-2026-12']);
  assert.equal((await events(['PremiumCollected'])).length, 1);
});
