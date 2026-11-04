import { queryItem, combineQueries } from 'es-dcb-library';

// External payload type. Kept separate from the types this system records.
export const external = ({ id, type, nationalId, dateOfDeath, registeredAt }) =>
  ({ id, type, nationalId, dateOfDeath, registeredAt });

export const sourceTag = (id) => `death-notice:${id}`;

const MAP = {
  'death.registered': { claimType: 'death' },
};

// Pure mapping. Notice types only. No business rules.
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

// The command this translation issues. Rules live here.
export async function issue(store, command) {
  const seenTag = sourceTag(command.sourceEventId);
  const query = combineQueries(decisionQuery(command.insuredNationalId), queryItem({ tags: [seenTag] }));
  const { events, position } = await store.load(query);

  if (events.some((e) => e.tags.includes(seenTag))) return null; // redelivery
  const state = decisionModel(events);
  if (!state.exists) throw new Error('PolicyNotFound');
  if (!state.open) throw new Error('PolicyNotInForce');

  const [event] = await store.append(
    {
      type: 'DeathClaimOpened',
      data: { policyId: state.policyId, ...command },
      tags: [`policy:${state.policyId}`, `person:${command.insuredNationalId}`, seenTag],
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
