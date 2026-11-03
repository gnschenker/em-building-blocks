import { workThrough } from '../processor.js';
import { listPremiumsToCollect, listStaleRequests } from './PremiumsToCollect.js';
import { requestPremiumCollection } from './RequestPremiumCollection.js';
import { recordAttemptFailed } from './RecordAttemptFailed.js';

// The gear. First record the request (the DCB condition lets only one through),
// then charge. The collection id is the provider's idempotency key on every attempt,
// so the provider never charges the same collection twice.
export async function processPremiumCollection({ pool, store, provider, clock }) {
  const now = clock();
  const rows = await listPremiumsToCollect(pool);
  return workThrough(rows, async (row) => {
    const event = await requestPremiumCollection(store, { ...row, now }); // throws for a duplicate: no charge
    try {
      await provider.charge({ idempotencyKey: row.collectionId, policyId: row.policyId, amount: row.amount });
    } catch (error) {
      await recordAttemptFailed(store, { collectionId: row.collectionId, attempt: event.data.attempt, reason: error.message });
    }
    return event;
  });
}

// Clock-driven sweep: a request with no provider result after the window counts as a
// failed attempt. That puts the row back on the open lane, and the next run charges
// again with the same key. A crash between request and charge cannot drop a premium.
export async function processStaleRequests({ pool, store, clock, windowMinutes = 60 }) {
  const rows = await listStaleRequests(pool, clock(), windowMinutes);
  return workThrough(rows, (row) =>
    recordAttemptFailed(store, { collectionId: row.collectionId, attempt: row.attempt, reason: 'NoProviderResult' }));
}
