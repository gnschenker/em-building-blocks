import { queryItem, combineQueries } from 'es-dcb-library';
import { defineProjection, createEventDispatcher } from 'es-dcb-library/projections';
import { workThrough } from '../processor.js';

// DeathRegistryNotice -> TranslateDeathRegistryNotice -> DeathNoticeObserved
//                      -> OpenDeathClaim -> DeathClaimOpened | DeathClaimRejected

// External payload type. Stored as-is as DeathRegistryNotice.
export const external = ({ id, type, nationalId, dateOfDeath, registeredAt }) =>
  ({ id, type, nationalId, dateOfDeath, registeredAt });

export const sourceTag = (id) => `death-notice:${id}`;

export async function ingest(store, payload) {
  const data = external(payload);
  const seenTag = sourceTag(data.id);
  const query = queryItem({ types: ['DeathRegistryNotice'], tags: [seenTag] });
  const { events, position } = await store.load(query);
  if (events.length) return null;
  const [event] = await store.append(
    { type: 'DeathRegistryNotice', data, tags: [seenTag] },
    { failIfEventsMatch: query, after: position },
  );
  return event;
}

const MAP = {
  'death.registered': { claimType: 'death' },
};

// Pure mapping. Notice types only. No business rules.
// Unknown code: skip (return null). The item stays on the translation todo list.
export function translate(payload) {
  const mapped = MAP[payload.type];
  if (!mapped) return null;
  return {
    insuredNationalId: payload.nationalId,
    dateOfDeath: payload.dateOfDeath,
    registeredAt: payload.registeredAt,
    claimType: mapped.claimType,
    sourceEventId: payload.id,
  };
}

// Translation todo list: every DeathRegistryNotice. Never closed: no done marker, no backward arrow.
export const translationProjection = defineProjection({
  name: 'death-notices-to-translate',
  query: queryItem({ types: ['DeathRegistryNotice'] }),
  async setup(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS death_notices_to_translate (
        source_event_id TEXT PRIMARY KEY,
        type            TEXT NOT NULL,
        national_id     TEXT NOT NULL,
        date_of_death   TEXT,
        registered_at   TEXT NOT NULL
      )`);
  },
  handler: createEventDispatcher({
    DeathRegistryNotice: (d, _e, c) =>
      c.query(
        `INSERT INTO death_notices_to_translate
         (source_event_id, type, national_id, date_of_death, registered_at)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
        [d.id, d.type, d.nationalId, d.dateOfDeath, d.registeredAt]),
  }),
});

export async function listToTranslate(pool) {
  const { rows } = await pool.query('SELECT * FROM death_notices_to_translate ORDER BY source_event_id');
  return rows.map((r) => ({
    id: r.source_event_id,
    type: r.type,
    nationalId: r.national_id,
    dateOfDeath: r.date_of_death,
    registeredAt: r.registered_at,
  }));
}

// Command: TranslateDeathRegistryNotice -> DeathNoticeObserved.
// Mapping only. Dedupe on the source event id. sourceEventId is the deterministic id.
export async function recordTranslation(store, payload) {
  const mapped = translate(payload);
  if (!mapped) return null;
  const seenTag = sourceTag(payload.id);
  const query = queryItem({ tags: [seenTag] });
  const { events, position } = await store.load(query);
  if (events.some((e) => e.type === 'DeathNoticeObserved')) return null; // redelivery
  const [event] = await store.append(
    {
      type: 'DeathNoticeObserved',
      data: mapped,
      tags: [`person:${mapped.insuredNationalId}`, seenTag],
    },
    { failIfEventsMatch: query, after: position },
  );
  return event;
}

export async function processTranslations({ pool, store }) {
  return workThrough(await listToTranslate(pool), (row) => recordTranslation(store, row));
}

// Worker todo list: closed by the opened or rejected claim.
export const workerProjection = defineProjection({
  name: 'death-claims-to-open',
  query: queryItem({ types: ['DeathNoticeObserved', 'DeathClaimOpened', 'DeathClaimRejected'] }),
  async setup(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS death_claims_to_open (
        source_event_id     TEXT PRIMARY KEY,
        insured_national_id TEXT NOT NULL,
        date_of_death       TEXT,
        registered_at       TEXT NOT NULL,
        claim_type          TEXT NOT NULL,
        done                BOOLEAN NOT NULL DEFAULT false
      )`);
  },
  handler: createEventDispatcher({
    DeathNoticeObserved: (d, _e, c) =>
      c.query(
        `INSERT INTO death_claims_to_open
         (source_event_id, insured_national_id, date_of_death, registered_at, claim_type)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
        [d.sourceEventId, d.insuredNationalId, d.dateOfDeath, d.registeredAt, d.claimType]),
    DeathClaimOpened: (d, _e, c) => close(c, d.sourceEventId),
    DeathClaimRejected: (d, _e, c) => close(c, d.sourceEventId),
  }),
});
const close = (c, id) =>
  c.query('UPDATE death_claims_to_open SET done = true WHERE source_event_id = $1', [id]);

export async function listToApply(pool) {
  const { rows } = await pool.query(
    'SELECT * FROM death_claims_to_open WHERE NOT done ORDER BY source_event_id');
  return rows.map((r) => ({
    insuredNationalId: r.insured_national_id,
    dateOfDeath: r.date_of_death,
    registeredAt: r.registered_at,
    claimType: r.claim_type,
    sourceEventId: r.source_event_id,
  }));
}

export const decisionQuery = (insuredNationalId) =>
  queryItem({
    types: ['PolicyIssued', 'PolicyLapsed', 'DeathClaimOpened'],
    tags: [`person:${insuredNationalId}`],
  });

export function decisionModel(events) {
  const state = { exists: false, open: false, policyId: null };
  for (const event of events) {
    if (event.type === 'PolicyIssued') {
      state.exists = true;
      state.open = true;
      state.policyId = event.data.policyId;
    }
    if (event.type === 'PolicyLapsed' || event.type === 'DeathClaimOpened') state.open = false;
  }
  return state;
}

// Command: OpenDeathClaim -> DeathClaimOpened or DeathClaimRejected.
// Rules live here.
export async function issue(store, command) {
  const seenTag = sourceTag(command.sourceEventId);
  const query = combineQueries(
    decisionQuery(command.insuredNationalId),
    queryItem({ types: ['DeathClaimOpened', 'DeathClaimRejected'], tags: [seenTag] }),
  );
  const { events, position } = await store.load(query);
  if (events.some((e) => e.tags.includes(seenTag))) return null;

  const state = decisionModel(events);
  const tags = [`person:${command.insuredNationalId}`, seenTag];
  if (state.policyId) tags.unshift(`policy:${state.policyId}`);
  let record;
  if (!state.exists) {
    record = { type: 'DeathClaimRejected', data: { ...command, reason: 'PolicyNotFound' }, tags };
  } else if (!state.open) {
    record = { type: 'DeathClaimRejected', data: { ...command, reason: 'PolicyNotInForce' }, tags };
  } else {
    record = { type: 'DeathClaimOpened', data: { policyId: state.policyId, ...command }, tags };
  }

  const [event] = await store.append(record, { failIfEventsMatch: query, after: position });
  return event;
}

export async function processWork({ pool, store }) {
  return workThrough(await listToApply(pool), (row) => issue(store, row));
}
