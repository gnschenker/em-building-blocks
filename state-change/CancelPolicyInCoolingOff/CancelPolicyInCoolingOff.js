import { queryItem } from 'es-dcb-library';

// Consistency boundary: the events this decision depends on.
export const decisionQuery = (policyId) =>
  queryItem({
    types: ['PolicyIssued', 'PolicyCancelledInCoolingOff'],
    tags: [`policy:${policyId}`],
  });

// Decision model, folded from past events.
export function decisionModel(events) {
  const state = { exists: false, coolingOffEndsAt: null, cancelled: false };
  for (const event of events) {
    if (event.type === 'PolicyIssued') {
      state.exists = true;
      state.coolingOffEndsAt = event.data.coolingOffEndsAt;
    }
    if (event.type === 'PolicyCancelledInCoolingOff') state.cancelled = true;
  }
  return state;
}

// Command handler: CancelPolicyInCoolingOff -> PolicyCancelledInCoolingOff.
export async function cancelPolicyInCoolingOff(store, { policyId, requestedAt, reason = null, coolingOffEndsAt }) {
  const query = decisionQuery(policyId);
  const { events, position } = await store.load(query);
  const state = decisionModel(events);

  if (!state.exists) throw new Error('PolicyNotFound');
  if (state.cancelled) throw new Error('PolicyAlreadyCancelled');
  // The command carries the deadline the screen showed; the recorded one decides.
  if (Date.parse(coolingOffEndsAt) !== Date.parse(state.coolingOffEndsAt)) throw new Error('CoolingOffEndMismatch');
  if (new Date(requestedAt) > new Date(state.coolingOffEndsAt)) throw new Error('CoolingOffPeriodExpired');

  const [event] = await store.append(
    {
      type: 'PolicyCancelledInCoolingOff',
      data: { policyId, requestedAt, reason },
      tags: [`policy:${policyId}`],
    },
    { failIfEventsMatch: query, after: position }, // fails if anything matching was written since the load
  );
  return event;
}
