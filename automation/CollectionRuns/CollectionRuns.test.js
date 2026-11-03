import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { store, pool, given, runProjections, reset, events } from '../testkit.js';
import { CollectionRunScheduled, at } from '../fixtures.js';
import { collectionRunsDueProjection, listDueCollectionRuns } from './CollectionRunsDue.js';
import { startCollectionRun } from './StartCollectionRun.js';
import { processCollectionRuns } from './CollectionRunProcessor.js';

const project = () => runProjections(collectionRunsDueProjection);
beforeEach(() => reset([collectionRunsDueProjection], ['collection_runs_due']));
after(() => pool.end());

test('Given the run is due, when StartCollectionRun, then CollectionRunStarted', async () => {
  await given(CollectionRunScheduled('2026-12', '2026-12-01T06:00:00Z'));
  const event = await startCollectionRun(store, { period: '2026-12', now: new Date('2026-12-01T06:00:00Z') });
  assert.deepEqual(event.data, { period: '2026-12', dueAt: '2026-12-01T06:00:00Z', startedAt: '2026-12-01T06:00:00.000Z' });
});

test('Given the run is not due yet, StartCollectionRun is rejected', async () => {
  await given(CollectionRunScheduled('2026-12', '2026-12-01T06:00:00Z'));
  await assert.rejects(startCollectionRun(store, { period: '2026-12', now: new Date('2026-12-01T05:59:59Z') }), /CollectionRunNotDueYet/);
});

test('Only runs whose date has passed are due', async () => {
  await given(CollectionRunScheduled('2026-12', '2026-12-01T06:00:00Z'), CollectionRunScheduled('2027-01', '2027-01-01T06:00:00Z'));
  await project();
  assert.deepEqual(await listDueCollectionRuns(pool, new Date('2026-12-15T00:00:00Z')), [{ period: '2026-12' }]);
});

test('A processor that was down catches up: the missed run is still on the list', async () => {
  await given(CollectionRunScheduled('2026-12', '2026-12-01T06:00:00Z'));
  await project();
  // Nothing ran on the 1st. Three days later the row is still there, and still due.
  assert.deepEqual(await listDueCollectionRuns(pool, new Date('2026-12-04T09:00:00Z')), [{ period: '2026-12' }]);
  await processCollectionRuns({ pool, store, clock: at('2026-12-04T09:00:00Z') });
  await project();
  assert.deepEqual(await listDueCollectionRuns(pool, new Date('2026-12-04T09:00:00Z')), []);
});

test('The processor starts each run once, even when run twice', async () => {
  await given(CollectionRunScheduled('2026-12', '2026-12-01T06:00:00Z'));
  await project();
  const clock = at('2026-12-01T06:01:00Z');
  await processCollectionRuns({ pool, store, clock });
  const second = await processCollectionRuns({ pool, store, clock }); // stale list
  assert.equal(second[0].error, 'CollectionRunAlreadyStarted');
  assert.equal((await events(['CollectionRunStarted'])).length, 1);
});
