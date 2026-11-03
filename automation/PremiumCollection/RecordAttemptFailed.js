import { collectionQuery, collectionModel, failureEvents } from './CollectionState.js';

// Command handler: RecordAttemptFailed -> PremiumCollectionAttemptFailed (+ Escalated on the third).
// Only the attempt in flight can fail, so a duplicate report is rejected.
export async function recordAttemptFailed(store, { collectionId, attempt, reason }) {
  const query = collectionQuery(collectionId);
  const { events, position } = await store.load(query);
  const state = collectionModel(events);
  if (state.status !== 'requested' || state.attempt !== attempt) throw new Error('AttemptNotInFlight');

  return store.append(failureEvents(collectionId, state, reason), { failIfEventsMatch: query, after: position });
}
