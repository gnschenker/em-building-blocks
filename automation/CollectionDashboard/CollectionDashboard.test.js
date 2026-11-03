import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, given, runProjections, reset } from '../testkit.js';
import { PolicyIssued, CollectionRunScheduled, CollectionRunStarted } from '../fixtures.js';
import { collectionRunsDueProjection } from '../CollectionRuns/CollectionRunsDue.js';
import { premiumsToCollectProjection } from '../PremiumCollection/PremiumsToCollect.js';
import { getCollectionDashboard } from './CollectionDashboard.js';

const projections = [collectionRunsDueProjection, premiumsToCollectProjection];
beforeEach(() => reset(projections, ['collection_runs_due', 'policies_in_force', 'premiums_to_collect']));
after(() => pool.end());

const collected = (policyId, period) =>
  ({ type: 'PremiumCollected', data: { collectionId: `collection-${policyId}-${period}` }, tags: [`collection:collection-${policyId}-${period}`] });

test('A run that did not happen in time shows as overdue', async () => {
  await given(CollectionRunScheduled('2026-12', '2026-12-01T06:00:00Z'), CollectionRunScheduled('2027-01', '2027-01-01T06:00:00Z'));
  await runProjections(...projections);
  const board = await getCollectionDashboard(pool, new Date('2026-12-03T09:00:00Z'));
  assert.deepEqual(board.runsNotStarted, [
    { id: '2026-12', dueAt: '2026-12-01T06:00:00.000Z', overdue: true },
    { id: '2027-01', dueAt: '2027-01-01T06:00:00.000Z', overdue: false },
  ]);
});

test('Open premiums past the grace period are overdue, collected ones are gone', async () => {
  await given(
    PolicyIssued('P1'), PolicyIssued('P2'),
    CollectionRunScheduled('2026-12', '2026-12-01T06:00:00Z'), CollectionRunStarted('2026-12', '2026-12-01T06:00:00Z'),
    collected('P2', '2026-12'),
  );
  await runProjections(...projections);
  const board = await getCollectionDashboard(pool, new Date('2026-12-02T07:00:00Z'));
  assert.deepEqual(board, {
    runsNotStarted: [],
    needsAttention: [],
    premiumsNotCollected: [{ id: 'collection-P1-2026-12', dueAt: '2026-12-01T06:00:00.000Z', overdue: true, status: 'open' }],
  });
});

test('Escalated premiums show in the needs-attention lane, not in the normal one', async () => {
  const tags = ['collection:collection-P1-2026-12'];
  await given(
    PolicyIssued('P1'), CollectionRunStarted('2026-12', '2026-12-01T06:00:00Z'),
    ...[1, 2, 3].flatMap((attempt) => [
      { type: 'PremiumCollectionRequested', data: { collectionId: 'collection-P1-2026-12', attempt, requestedAt: '2026-12-01T06:00:00Z' }, tags },
      { type: 'PremiumCollectionAttemptFailed', data: { collectionId: 'collection-P1-2026-12', attempt, reason: 'ProviderTimeout' }, tags },
    ]),
    { type: 'PremiumCollectionEscalated', data: { collectionId: 'collection-P1-2026-12', attempts: 3, reason: 'ProviderTimeout' }, tags },
  );
  await runProjections(...projections);
  const board = await getCollectionDashboard(pool, new Date('2026-12-01T09:00:00Z'));
  assert.deepEqual(board.premiumsNotCollected, []);
  assert.deepEqual(board.needsAttention, [{ id: 'collection-P1-2026-12', dueAt: '2026-12-01T06:00:00.000Z', attempts: 3, reason: 'ProviderTimeout' }]);
});
