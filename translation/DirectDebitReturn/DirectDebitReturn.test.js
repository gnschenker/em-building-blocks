import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { queryItem } from 'es-dcb-library';
import { store, pool } from '../store.js';
import { external, translate, ingest, sourceTag } from './DirectDebitReturn.js';

beforeEach(() => pool.query('TRUNCATE events'));
after(() => pool.end());

const given = (...events) => store.append(events);
const when = (payload) => ingest(store, payload);
async function thenEvents(tag, expected) {
  const { events } = await store.load(queryItem({ types: ['PremiumCollectionAttemptFailed'], tags: [tag] }));
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
const command = {
  collectionId: 'collection-P1-2026-11',
  reason: 'insufficient_funds',
  returnedAt: '2026-11-01T08:12:00Z',
  sourceEventId: 'DDR-88',
};
const recorded = {
  type: 'PremiumCollectionAttemptFailed',
  data: command,
  tags: ['collection:collection-P1-2026-11', sourceTag('DDR-88')],
};

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

test('The payload maps to a command, unknown codes are ignored', () => {
  assert.deepEqual(translate(payload), command);
  assert.equal(translate(unknown), null);
});

test('Given a collection in flight, when a mapped debit return arrives, then PremiumCollectionAttemptFailed', async () => {
  await given(PremiumCollectionRequested('collection-P1-2026-11'));
  await when(payload);
  await thenEvents('collection:collection-P1-2026-11', [recorded]);
});

test('The same payload delivered twice is recorded once', async () => {
  await given(PremiumCollectionRequested('collection-P1-2026-11'));
  await when(payload);
  assert.equal(await when(payload), null);
  await thenEvents('collection:collection-P1-2026-11', [recorded]);
});

test('An unknown code is ignored and records nothing', async () => {
  await given(PremiumCollectionRequested('collection-P1-2026-11'));
  assert.equal(await when(unknown), null);
  await thenEvents('collection:collection-P1-2026-11', []);
});

test('Given no matching record, the command is rejected', async () => {
  await assert.rejects(when(payload), { message: 'CollectionNotFound' });
});

test('Given a closed record, the command is rejected', async () => {
  await given(PremiumCollectionRequested('collection-P1-2026-11'), PremiumCollected('collection-P1-2026-11'));
  await assert.rejects(when(payload), { message: 'AttemptNotInFlight' });
});
