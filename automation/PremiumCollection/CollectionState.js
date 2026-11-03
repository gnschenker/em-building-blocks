import { queryItem } from 'es-dcb-library';

export const MAX_ATTEMPTS = 3;

// Boundary: everything that happened to one collection (one policy, one period).
export const collectionQuery = (collectionId) =>
  queryItem({
    types: ['PremiumCollectionRequested', 'PremiumCollectionAttemptFailed', 'PremiumCollectionEscalated', 'PremiumCollected'],
    tags: [`collection:${collectionId}`],
  });

export function collectionModel(events) {
  let requests = 0, failures = 0, escalated = false, collected = false;
  for (const { type } of events) {
    if (type === 'PremiumCollectionRequested') requests++;
    if (type === 'PremiumCollectionAttemptFailed') failures++;
    if (type === 'PremiumCollectionEscalated') escalated = true;
    if (type === 'PremiumCollected') collected = true;
  }
  const status = collected ? 'collected' : escalated ? 'needs_attention' : requests > failures ? 'requested' : 'open';
  return { status, attempt: requests, failures };
}

// A failed attempt is a fact. The third one also moves the item to a person.
export function failureEvents(collectionId, state, reason) {
  const tags = [`collection:${collectionId}`];
  const events = [{ type: 'PremiumCollectionAttemptFailed', data: { collectionId, attempt: state.attempt, reason }, tags }];
  if (state.attempt >= MAX_ATTEMPTS) {
    events.push({ type: 'PremiumCollectionEscalated', data: { collectionId, attempts: state.attempt, reason }, tags });
  }
  return events;
}
