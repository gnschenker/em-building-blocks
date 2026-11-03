import { queryItem, combineQueries } from 'es-dcb-library';
import { collectionQuery, collectionModel, failureEvents } from '../PremiumCollection/CollectionState.js';

// Translation: the provider's webhook is not our language. Map it to our facts.
// Example payload: { id: 'evt_1', type: 'charge.succeeded', idempotency_key: 'collection-P1-2026-12' }
export function translate(payload) {
  const collectionId = payload.idempotency_key; // we sent our id, the provider echoes it back
  if (payload.type === 'charge.succeeded') return { kind: 'collected', collectionId };
  if (payload.type === 'charge.failed') return { kind: 'failed', collectionId, reason: payload.failure_code };
  throw new Error(`UnknownProviderEvent:${payload.type}`);
}

// Command handler: RecordPaymentResult. Dedupe on the provider's event id:
// a webhook delivered twice finds its own tag and is ignored.
export async function recordPaymentResult(store, payload) {
  const result = translate(payload);
  const seenTag = `provider-event:${payload.id}`;
  const query = combineQueries(collectionQuery(result.collectionId), queryItem({ tags: [seenTag] }));
  const { events, position } = await store.load(query);
  const state = collectionModel(events);

  if (events.some((e) => e.tags.includes(seenTag))) return null; // already translated
  if (state.attempt === 0) throw new Error('UnknownCollection');

  let newEvents;
  if (result.kind === 'collected') {
    if (state.status === 'collected') return null; // the provider deduped a resend; paid once
    newEvents = [{ type: 'PremiumCollected', data: { collectionId: result.collectionId, providerEventId: payload.id }, tags: [`collection:${result.collectionId}`] }];
  } else {
    if (state.status !== 'requested') return null; // late failure for an attempt already settled
    newEvents = failureEvents(result.collectionId, state, result.reason);
  }
  newEvents[0].tags.push(seenTag);
  const [event] = await store.append(newEvents, { failIfEventsMatch: query, after: position });
  return event;
}
