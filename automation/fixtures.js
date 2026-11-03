// Events the scenarios start from.
export const PolicyIssued = (policyId, monthlyPremium = 85) =>
  ({ type: 'PolicyIssued', data: { policyId, monthlyPremium }, tags: [`policy:${policyId}`] });
export const PolicyLapsed = (policyId) => ({ type: 'PolicyLapsed', data: { policyId }, tags: [`policy:${policyId}`] });
export const CollectionRunScheduled = (period, dueAt) =>
  ({ type: 'CollectionRunScheduled', data: { period, dueAt }, tags: [`collection-run:${period}`] });
export const CollectionRunStarted = (period, dueAt) =>
  ({ type: 'CollectionRunStarted', data: { period, dueAt, startedAt: dueAt }, tags: [`collection-run:${period}`] });
export const at = (iso) => () => new Date(iso);

// A fake payment provider. Like a real one, it dedupes on the idempotency key:
// `calls` is every request it got, `charges` the money actually taken.
// `down` makes it fail for the given policies (a timeout, say).
export const fakeProvider = ({ down = [] } = {}) => ({
  calls: [],
  charges: [],
  async charge(request) {
    this.calls.push(request.idempotencyKey);
    if (down.includes(request.policyId)) throw new Error('ProviderTimeout');
    if (!this.charges.includes(request.idempotencyKey)) this.charges.push(request.idempotencyKey);
  },
});
