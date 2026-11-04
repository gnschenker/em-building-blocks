import { queryItem, combineQueries } from 'es-dcb-library';

// External payload type. Kept separate from the types this system records.
export const external = ({ id, testCode, unit, value, clientOrderId, collectedAt }) =>
  ({ id, testCode, unit, value, clientOrderId, collectedAt });

export const sourceTag = (id) => `lab-result:${id}`;

const MAP = {
  'GLU_FAS:mg/dL': { marker: 'fasting_glucose', unit: 'mmol/L', factor: 0.0555 },
  'HBA1C_NGSP:%': { marker: 'hba1c', unit: '%', factor: 1 },
  'CHOL_TOT:mg/dL': { marker: 'total_cholesterol', unit: 'mmol/L', factor: 0.02586 },
};

// Pure mapping. Codes and units only. No business rules.
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

// The command this translation issues. Rules live here.
export async function issue(store, command) {
  const seenTag = sourceTag(command.sourceEventId);
  const query = combineQueries(decisionQuery(command.applicationId), queryItem({ tags: [seenTag] }));
  const { events, position } = await store.load(query);

  if (events.some((e) => e.tags.includes(seenTag))) return null; // redelivery
  const state = decisionModel(events);
  if (!state.exists) throw new Error('ApplicationNotFound');
  if (!state.open) throw new Error('ApplicationNotInUnderwriting');

  const [event] = await store.append(
    {
      type: 'UnderwritingEvidenceRecorded',
      data: command,
      tags: [`application:${command.applicationId}`, seenTag],
    },
    { failIfEventsMatch: query, after: position },
  );
  return event;
}

export async function ingest(store, payload) {
  const command = translate(payload);
  if (!command) return null;
  return issue(store, command);
}
