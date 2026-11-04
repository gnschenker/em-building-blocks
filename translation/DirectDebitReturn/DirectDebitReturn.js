import { queryItem, combineQueries } from 'es-dcb-library';
import { defineProjection, createEventDispatcher } from 'es-dcb-library/projections';
import { workThrough } from '../processor.js';

// DirectDebitReturn -> TranslateDirectDebitReturn -> CollectionReturnObserved
//                    -> RecordCollectionAttemptFailed -> PremiumCollectionAttemptFailed | CollectionReturnRejected

// External payload type. Stored as-is as DirectDebitReturn.
export const external = ({ id, type, returnCode, collectionRef, returnedAt }) =>
  ({ id, type, returnCode, collectionRef, returnedAt });

export const sourceTag = (id) => `direct-debit-return:${id}`;

export async function ingest(store, payload) {
  const data = external(payload);
  const seenTag = sourceTag(data.id);
  const query = queryItem({ types: ['DirectDebitReturn'], tags: [seenTag] });
  const { events, position } = await store.load(query);
  if (events.length) return null;
  const [event] = await store.append(
    { type: 'DirectDebitReturn', data, tags: [seenTag] },
    { failIfEventsMatch: query, after: position },
  );
  return event;
}

const MAP = {
  'direct_debit.returned:AM04': { returnReason: 'insufficient_funds' },
  'direct_debit.returned:AC04': { returnReason: 'account_closed' },
  'direct_debit.returned:MD07': { returnReason: 'payer_deceased' },
};

// Pure mapping. Return codes only. No business rules.
// Unknown code: skip (return null). The item stays on the translation todo list.
export function translate(payload) {
  const mapped = MAP[`${payload.type}:${payload.returnCode}`];
  if (!mapped) return null;
  return {
    collectionId: payload.collectionRef,
    returnReason: mapped.returnReason,
    returnedAt: payload.returnedAt,
    sourceEventId: payload.id,
  };
}

// Translation todo list: every DirectDebitReturn. Never closed: no done marker, no backward arrow.
export const translationProjection = defineProjection({
  name: 'debit-returns-to-translate',
  query: queryItem({ types: ['DirectDebitReturn'] }),
  async setup(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS debit_returns_to_translate (
        source_event_id TEXT PRIMARY KEY,
        type            TEXT NOT NULL,
        return_code     TEXT NOT NULL,
        collection_ref  TEXT NOT NULL,
        returned_at     TEXT NOT NULL
      )`);
  },
  handler: createEventDispatcher({
    DirectDebitReturn: (d, _e, c) =>
      c.query(
        `INSERT INTO debit_returns_to_translate
         (source_event_id, type, return_code, collection_ref, returned_at)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
        [d.id, d.type, d.returnCode, d.collectionRef, d.returnedAt]),
  }),
});

export async function listToTranslate(pool) {
  const { rows } = await pool.query('SELECT * FROM debit_returns_to_translate ORDER BY source_event_id');
  return rows.map((r) => ({
    id: r.source_event_id,
    type: r.type,
    returnCode: r.return_code,
    collectionRef: r.collection_ref,
    returnedAt: r.returned_at,
  }));
}

// Command: TranslateDirectDebitReturn -> CollectionReturnObserved.
// Mapping only. Dedupe on the source event id. sourceEventId is the deterministic id.
export async function recordTranslation(store, payload) {
  const mapped = translate(payload);
  if (!mapped) return null;
  const seenTag = sourceTag(payload.id);
  const query = queryItem({ tags: [seenTag] });
  const { events, position } = await store.load(query);
  if (events.some((e) => e.type === 'CollectionReturnObserved')) return null; // redelivery
  const [event] = await store.append(
    {
      type: 'CollectionReturnObserved',
      data: mapped,
      tags: [`collection:${mapped.collectionId}`, seenTag],
    },
    { failIfEventsMatch: query, after: position },
  );
  return event;
}

export async function processTranslations({ pool, store }) {
  return workThrough(await listToTranslate(pool), (row) => recordTranslation(store, row));
}

// Worker todo list: closed by the recorded failure or the rejected return.
export const workerProjection = defineProjection({
  name: 'collection-returns-to-record',
  query: queryItem({ types: ['CollectionReturnObserved', 'PremiumCollectionAttemptFailed', 'CollectionReturnRejected'] }),
  async setup(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS collection_returns_to_record (
        source_event_id TEXT PRIMARY KEY,
        collection_id   TEXT NOT NULL,
        return_reason   TEXT NOT NULL,
        returned_at     TEXT NOT NULL
      )`);
  },
  handler: createEventDispatcher({
    CollectionReturnObserved: (d, _e, c) =>
      c.query(
        `INSERT INTO collection_returns_to_record
         (source_event_id, collection_id, return_reason, returned_at)
         VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [d.sourceEventId, d.collectionId, d.returnReason, d.returnedAt]),
    PremiumCollectionAttemptFailed: (d, _e, c) => close(c, d.sourceEventId),
    CollectionReturnRejected: (d, _e, c) => close(c, d.sourceEventId),
  }),
});
const close = (c, id) =>
  c.query('DELETE FROM collection_returns_to_record WHERE source_event_id = $1', [id]);

export async function listToApply(pool) {
  const { rows } = await pool.query(
    'SELECT * FROM collection_returns_to_record ORDER BY source_event_id');
  return rows.map((r) => ({
    collectionId: r.collection_id,
    returnReason: r.return_reason,
    returnedAt: r.returned_at,
    sourceEventId: r.source_event_id,
  }));
}

export const decisionQuery = (collectionId) =>
  queryItem({
    types: ['PremiumCollectionRequested', 'PremiumCollectionAttemptFailed', 'PremiumCollected'],
    tags: [`collection:${collectionId}`],
  });

export function decisionModel(events) {
  let requests = 0, failures = 0, collected = false;
  for (const { type } of events) {
    if (type === 'PremiumCollectionRequested') requests++;
    if (type === 'PremiumCollectionAttemptFailed') failures++;
    if (type === 'PremiumCollected') collected = true;
  }
  return { exists: requests > 0, open: !collected && requests > failures };
}

// Command: RecordCollectionAttemptFailed -> PremiumCollectionAttemptFailed or CollectionReturnRejected.
// Rules live here.
export async function issue(store, command) {
  const seenTag = sourceTag(command.sourceEventId);
  const query = combineQueries(
    decisionQuery(command.collectionId),
    queryItem({ types: ['PremiumCollectionAttemptFailed', 'CollectionReturnRejected'], tags: [seenTag] }),
  );
  const { events, position } = await store.load(query);
  if (events.some((e) => e.tags.includes(seenTag))) return null;

  const state = decisionModel(events);
  const tags = [`collection:${command.collectionId}`, seenTag];
  let record;
  if (!state.exists) {
    record = { type: 'CollectionReturnRejected', data: { ...command, rejectionReason: 'CollectionNotFound' }, tags };
  } else if (!state.open) {
    record = { type: 'CollectionReturnRejected', data: { ...command, rejectionReason: 'AttemptNotInFlight' }, tags };
  } else {
    record = { type: 'PremiumCollectionAttemptFailed', data: command, tags };
  }

  const [event] = await store.append(record, { failIfEventsMatch: query, after: position });
  return event;
}

export async function processWork({ pool, store }) {
  return workThrough(await listToApply(pool), (row) => issue(store, row));
}
