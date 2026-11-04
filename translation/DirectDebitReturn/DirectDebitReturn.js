import { queryItem, combineQueries } from 'es-dcb-library';

// External payload type. Kept separate from the types this system records.
export const external = ({ id, type, returnCode, collectionRef, returnedAt }) =>
  ({ id, type, returnCode, collectionRef, returnedAt });

export const sourceTag = (id) => `direct-debit-return:${id}`;

const MAP = {
  'direct_debit.returned:AM04': { reason: 'insufficient_funds' },
  'direct_debit.returned:AC04': { reason: 'account_closed' },
  'direct_debit.returned:MD07': { reason: 'payer_deceased' },
};

// Pure mapping. Return codes only. No business rules.
export function translate(payload) {
  const mapped = MAP[`${payload.type}:${payload.returnCode}`];
  if (!mapped) return null;
  return {
    collectionId: payload.collectionRef,
    reason: mapped.reason,
    returnedAt: payload.returnedAt,
    sourceEventId: payload.id,
  };
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

// The command this translation issues. Rules live here.
export async function issue(store, command) {
  const seenTag = sourceTag(command.sourceEventId);
  const query = combineQueries(decisionQuery(command.collectionId), queryItem({ tags: [seenTag] }));
  const { events, position } = await store.load(query);

  if (events.some((e) => e.tags.includes(seenTag))) return null; // redelivery
  const state = decisionModel(events);
  if (!state.exists) throw new Error('CollectionNotFound');
  if (!state.open) throw new Error('AttemptNotInFlight');

  const [event] = await store.append(
    {
      type: 'PremiumCollectionAttemptFailed',
      data: command,
      tags: [`collection:${command.collectionId}`, seenTag],
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
