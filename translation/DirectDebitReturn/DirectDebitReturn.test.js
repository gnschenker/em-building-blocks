import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { queryItem } from 'es-dcb-library';
import { store, pool, given, runProjections, reset } from '../testkit.js';
import {
  external, translate, ingest, sourceTag,
  translationProjection, workerProjection,
  listToTranslate, listToApply,
  processTranslations, processWork,
} from './DirectDebitReturn.js';

const project = () => runProjections(translationProjection, workerProjection);
beforeEach(() => reset(
  [translationProjection, workerProjection],
  ['debit_returns_to_translate', 'collection_returns_to_record'],
));
after(() => pool.end());

async function thenEvents(types, tag, expected) {
  const { events } = await store.load(queryItem({ types, tags: [tag] }));
  assert.deepEqual(events.map(({ type, data, tags }) => ({ type, data, tags })), expected);
}

const payload = external({
  id: 'DDR-88',
  type: 'direct_debit.returned',
  returnCode: 'AM04',
  collectionRef: 'collection-P1-2026-11',
  returnedAt: '2026-11-01T08:12:00Z',
});
const unknown = external({
  id: 'DDR-89',
  type: 'mandate.amended',
  returnCode: 'MS03',
  collectionRef: 'collection-P1-2026-11',
  returnedAt: '2026-11-01T08:12:00Z',
});
const mapped = {
  collectionId: 'collection-P1-2026-11',
  reason: 'insufficient_funds',
  returnedAt: '2026-11-01T08:12:00Z',
  sourceEventId: 'DDR-88',
};
const debitReturn = { type: 'DirectDebitReturn', data: payload, tags: [sourceTag('DDR-88')] };
const unknownReturn = { type: 'DirectDebitReturn', data: unknown, tags: [sourceTag('DDR-89')] };
const observed = {
  type: 'CollectionReturnObserved',
  data: mapped,
  tags: ['collection:collection-P1-2026-11', sourceTag('DDR-88')],
};
const recorded = {
  type: 'PremiumCollectionAttemptFailed',
  data: mapped,
  tags: ['collection:collection-P1-2026-11', sourceTag('DDR-88')],
};
const rejected = (reason) => ({
  type: 'CollectionReturnRejected',
  data: { ...mapped, reason },
  tags: ['collection:collection-P1-2026-11', sourceTag('DDR-88')],
});

const PremiumCollectionRequested = (collectionId) => ({
  type: 'PremiumCollectionRequested',
  data: { collectionId, policyId: 'P1', period: '2026-11', amount: 85, attempt: 1 },
  tags: [`collection:${collectionId}`, 'policy:P1'],
});
const PremiumCollected = (collectionId) => ({
  type: 'PremiumCollected',
  data: { collectionId },
  tags: [`collection:${collectionId}`],
});

test('A debit return is stored as DirectDebitReturn', async () => {
  const event = await ingest(store, payload);
  assert.deepEqual({ type: event.type, data: event.data, tags: event.tags }, debitReturn);
  assert.equal(await ingest(store, payload), null);
});

test('The payload maps to a collection return, unknown codes are ignored', () => {
  assert.deepEqual(translate(payload), mapped);
  assert.equal(translate(unknown), null);
});

test('Given a DirectDebitReturn, when TranslateDirectDebitReturn, then CollectionReturnObserved', async () => {
  await given(debitReturn);
  await project();
  await processTranslations({ pool, store });
  await thenEvents(['CollectionReturnObserved'], 'collection:collection-P1-2026-11', [observed]);
});

test('The same DirectDebitReturn translated twice is recorded once', async () => {
  await given(debitReturn);
  await project();
  await processTranslations({ pool, store });
  const second = await processTranslations({ pool, store });
  assert.equal(second[0].event, null);
  await thenEvents(['CollectionReturnObserved'], 'collection:collection-P1-2026-11', [observed]);
});

test('An unknown code is skipped and records no internal event', async () => {
  await given(unknownReturn);
  await project();
  assert.equal((await processTranslations({ pool, store }))[0].event, null);
  await thenEvents(['CollectionReturnObserved'], 'collection:collection-P1-2026-11', []);
});

test('The translation todo list is never closed', async () => {
  await given(debitReturn);
  await project();
  await processTranslations({ pool, store });
  await project();
  assert.deepEqual(await listToTranslate(pool), [payload]);
});

test('Given a collection in flight, when RecordCollectionAttemptFailed, then PremiumCollectionAttemptFailed and the worker todo closes', async () => {
  await given(PremiumCollectionRequested('collection-P1-2026-11'), observed);
  await project();
  assert.equal((await listToApply(pool)).length, 1);
  await processWork({ pool, store });
  await thenEvents(['PremiumCollectionAttemptFailed'], 'collection:collection-P1-2026-11', [recorded]);
  await project();
  assert.deepEqual((await pool.query('SELECT * FROM collection_returns_to_record')).rows, []);
});

test('Given no matching collection, RecordCollectionAttemptFailed records CollectionReturnRejected and the worker todo closes', async () => {
  await given(observed);
  await project();
  await processWork({ pool, store });
  await thenEvents(['CollectionReturnRejected'], 'collection:collection-P1-2026-11', [rejected('CollectionNotFound')]);
  await project();
  assert.deepEqual((await pool.query('SELECT * FROM collection_returns_to_record')).rows, []);
});

test('Given a closed collection, RecordCollectionAttemptFailed records CollectionReturnRejected and the worker todo closes', async () => {
  await given(PremiumCollectionRequested('collection-P1-2026-11'), PremiumCollected('collection-P1-2026-11'), observed);
  await project();
  await processWork({ pool, store });
  await thenEvents(['CollectionReturnRejected'], 'collection:collection-P1-2026-11', [rejected('AttemptNotInFlight')]);
  await project();
  assert.deepEqual((await pool.query('SELECT * FROM collection_returns_to_record')).rows, []);
});
