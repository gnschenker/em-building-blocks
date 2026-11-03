import { collectionIdFor } from './PremiumsToCollect.js';
import { collectionQuery, collectionModel } from './CollectionState.js';

// Command handler: RequestPremiumCollection -> PremiumCollectionRequested.
// Allowed only while the collection is open: never twice in flight, never after it is paid.
export async function requestPremiumCollection(store, { policyId, period, amount, now }) {
  const collectionId = collectionIdFor(policyId, period);
  const query = collectionQuery(collectionId);
  const { events, position } = await store.load(query);
  const state = collectionModel(events);
  if (state.status !== 'open') throw new Error(`PremiumCollection${state.status === 'requested' ? 'AlreadyRequested' : 'NotOpen'}`);

  const [event] = await store.append(
    {
      type: 'PremiumCollectionRequested',
      data: { collectionId, policyId, period, amount, attempt: state.attempt + 1, requestedAt: new Date(now).toISOString() },
      tags: [`collection:${collectionId}`, `policy:${policyId}`],
    },
    { failIfEventsMatch: query, after: position }, // two processors racing: only one append wins
  );
  return event;
}
