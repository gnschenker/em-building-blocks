import { queryItem, combineQueries } from 'es-dcb-library';
import { defineProjection, createEventDispatcher } from 'es-dcb-library/projections';
import { workThrough } from '../processor.js';

// LabResult -> TranslateLabResult -> UnderwritingEvidenceObserved
//           -> RecordUnderwritingEvidence -> UnderwritingEvidenceRecorded | UnderwritingEvidenceRejected

// External payload type. Stored as-is as LabResult.
export const external = ({ id, testCode, unit, value, clientOrderId, collectedAt }) =>
  ({ id, testCode, unit, value, clientOrderId, collectedAt });

export const sourceTag = (id) => `lab-result:${id}`;

export async function ingest(store, payload) {
  const data = external(payload);
  const seenTag = sourceTag(data.id);
  const query = queryItem({ types: ['LabResult'], tags: [seenTag] });
  const { events, position } = await store.load(query);
  if (events.length) return null;
  const [event] = await store.append(
    { type: 'LabResult', data, tags: [seenTag] },
    { failIfEventsMatch: query, after: position },
  );
  return event;
}

const MAP = {
  'GLU_FAS:mg/dL': { marker: 'fasting_glucose', unit: 'mmol/L', factor: 0.0555 },
  'HBA1C_NGSP:%': { marker: 'hba1c', unit: '%', factor: 1 },
  'CHOL_TOT:mg/dL': { marker: 'total_cholesterol', unit: 'mmol/L', factor: 0.02586 },
};

// Pure mapping. Codes and units only. No business rules.
// Unknown code: skip (return null). The item stays on the translation todo list.
export function translate(payload) {
  const mapped = MAP[`${payload.testCode}:${payload.unit}`];
  if (!mapped) return null;
  return {
    applicationId: payload.clientOrderId,
    marker: mapped.marker,
    value: Number((payload.value * mapped.factor).toFixed(3)),
    unit: mapped.unit,
    observedAt: payload.collectedAt,
    sourceEventId: payload.id,
  };
}

// Translation todo list: every LabResult. Never closed: no done marker, no backward arrow.
export const translationProjection = defineProjection({
  name: 'lab-results-to-translate',
  query: queryItem({ types: ['LabResult'] }),
  async setup(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS lab_results_to_translate (
        source_event_id TEXT PRIMARY KEY,
        test_code       TEXT NOT NULL,
        unit            TEXT NOT NULL,
        value           NUMERIC NOT NULL,
        client_order_id TEXT NOT NULL,
        collected_at    TEXT NOT NULL
      )`);
  },
  handler: createEventDispatcher({
    LabResult: (d, _e, c) =>
      c.query(
        `INSERT INTO lab_results_to_translate
         (source_event_id, test_code, unit, value, client_order_id, collected_at)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
        [d.id, d.testCode, d.unit, d.value, d.clientOrderId, d.collectedAt]),
  }),
});

export async function listToTranslate(pool) {
  const { rows } = await pool.query('SELECT * FROM lab_results_to_translate ORDER BY source_event_id');
  return rows.map((r) => ({
    id: r.source_event_id,
    testCode: r.test_code,
    unit: r.unit,
    value: Number(r.value),
    clientOrderId: r.client_order_id,
    collectedAt: r.collected_at,
  }));
}

// Command: TranslateLabResult -> UnderwritingEvidenceObserved.
// Mapping only. Dedupe on the source event id. sourceEventId is the deterministic id.
export async function recordTranslation(store, payload) {
  const mapped = translate(payload);
  if (!mapped) return null;
  const seenTag = sourceTag(payload.id);
  const query = queryItem({ tags: [seenTag] });
  const { events, position } = await store.load(query);
  if (events.some((e) => e.type === 'UnderwritingEvidenceObserved')) return null; // redelivery
  const [event] = await store.append(
    {
      type: 'UnderwritingEvidenceObserved',
      data: mapped,
      tags: [`application:${mapped.applicationId}`, seenTag],
    },
    { failIfEventsMatch: query, after: position },
  );
  return event;
}

export async function processTranslations({ pool, store }) {
  return workThrough(await listToTranslate(pool), (row) => recordTranslation(store, row));
}

// Worker todo list: closed by the recorded or rejected evidence.
export const workerProjection = defineProjection({
  name: 'underwriting-evidence-to-record',
  query: queryItem({ types: ['UnderwritingEvidenceObserved', 'UnderwritingEvidenceRecorded', 'UnderwritingEvidenceRejected'] }),
  async setup(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS underwriting_evidence_to_record (
        source_event_id TEXT PRIMARY KEY,
        application_id  TEXT NOT NULL,
        marker          TEXT NOT NULL,
        value           NUMERIC NOT NULL,
        unit            TEXT NOT NULL,
        observed_at     TEXT NOT NULL
      )`);
  },
  handler: createEventDispatcher({
    UnderwritingEvidenceObserved: (d, _e, c) =>
      c.query(
        `INSERT INTO underwriting_evidence_to_record
         (source_event_id, application_id, marker, value, unit, observed_at)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
        [d.sourceEventId, d.applicationId, d.marker, d.value, d.unit, d.observedAt]),
    UnderwritingEvidenceRecorded: (d, _e, c) => close(c, d.sourceEventId),
    UnderwritingEvidenceRejected: (d, _e, c) => close(c, d.sourceEventId),
  }),
});
const close = (c, id) =>
  c.query('DELETE FROM underwriting_evidence_to_record WHERE source_event_id = $1', [id]);

export async function listToApply(pool) {
  const { rows } = await pool.query(
    'SELECT * FROM underwriting_evidence_to_record ORDER BY source_event_id');
  return rows.map((r) => ({
    applicationId: r.application_id,
    marker: r.marker,
    value: Number(r.value),
    unit: r.unit,
    observedAt: r.observed_at,
    sourceEventId: r.source_event_id,
  }));
}

export const decisionQuery = (applicationId) =>
  queryItem({
    types: ['ApplicationReceived', 'PolicyIssued', 'ApplicationDeclined'],
    tags: [`application:${applicationId}`],
  });

export function decisionModel(events) {
  const state = { exists: false, open: false };
  for (const event of events) {
    if (event.type === 'ApplicationReceived') {
      state.exists = true;
      state.open = true;
    }
    if (event.type === 'PolicyIssued' || event.type === 'ApplicationDeclined') state.open = false;
  }
  return state;
}

// Command: RecordUnderwritingEvidence -> UnderwritingEvidenceRecorded or UnderwritingEvidenceRejected.
// Rules live here.
export async function issue(store, command) {
  const seenTag = sourceTag(command.sourceEventId);
  const query = combineQueries(
    decisionQuery(command.applicationId),
    queryItem({ types: ['UnderwritingEvidenceRecorded', 'UnderwritingEvidenceRejected'], tags: [seenTag] }),
  );
  const { events, position } = await store.load(query);
  if (events.some((e) => e.tags.includes(seenTag))) return null;

  const state = decisionModel(events);
  const tags = [`application:${command.applicationId}`, seenTag];
  let record;
  if (!state.exists) {
    record = { type: 'UnderwritingEvidenceRejected', data: { ...command, reason: 'ApplicationNotFound' }, tags };
  } else if (!state.open) {
    record = { type: 'UnderwritingEvidenceRejected', data: { ...command, reason: 'ApplicationNotInUnderwriting' }, tags };
  } else {
    record = { type: 'UnderwritingEvidenceRecorded', data: command, tags };
  }

  const [event] = await store.append(record, { failIfEventsMatch: query, after: position });
  return event;
}

export async function processWork({ pool, store }) {
  return workThrough(await listToApply(pool), (row) => issue(store, row));
}
