import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { queryItem } from 'es-dcb-library';
import { store, pool } from '../store.js';
import { cancelPolicyInCoolingOff } from './CancelPolicyInCoolingOff.js';

beforeEach(() => pool.query('TRUNCATE events'));
after(() => pool.end());

const ENDS = '2026-11-30T23:59:00Z';
const PolicyIssued = (policyId, issuedAt = '2026-11-01T00:00:00Z') => ({
  type: 'PolicyIssued',
  data: { policyId, policyNumber: `NR-${policyId}`, policyholderId: 'H1', issuedAt, coolingOffEndsAt: ENDS },
  tags: [`policy:${policyId}`],
});
const PolicyCancelledInCoolingOff = (policyId, requestedAt, reason = null) => ({
  type: 'PolicyCancelledInCoolingOff',
  data: { policyId, requestedAt, reason },
  tags: [`policy:${policyId}`],
});

const given = (...events) => store.append(events);
const when = (command) => cancelPolicyInCoolingOff(store, { coolingOffEndsAt: ENDS, ...command });
async function thenEvents(policyId, expected) {
  const { events } = await store.load(
    queryItem({ types: ['PolicyCancelledInCoolingOff'], tags: [`policy:${policyId}`] }),
  );
  assert.deepEqual(events.map(({ type, data, tags }) => ({ type, data, tags })), expected);
}

test('Happy path: cancel inside the window', async () => {
  await given(PolicyIssued('P1'));
  await when({ policyId: 'P1', reason: 'Changed my mind', requestedAt: '2026-11-10T00:00:00Z' });
  await thenEvents('P1', [PolicyCancelledInCoolingOff('P1', '2026-11-10T00:00:00Z', 'Changed my mind')]);
});

test('Last moment still counts', async () => {
  await given(PolicyIssued('P1'));
  await when({ policyId: 'P1', requestedAt: ENDS });
  await thenEvents('P1', [PolicyCancelledInCoolingOff('P1', ENDS)]);
});

test('Outside the window', async () => {
  await given(PolicyIssued('P1'));
  await assert.rejects(when({ policyId: 'P1', requestedAt: '2026-12-01T00:00:00Z' }), { message: 'CoolingOffPeriodExpired' });
});

test('Already cancelled', async () => {
  await given(PolicyIssued('P1'), PolicyCancelledInCoolingOff('P1', '2026-11-10T00:00:00Z'));
  await assert.rejects(when({ policyId: 'P1', requestedAt: '2026-11-12T00:00:00Z' }), { message: 'PolicyAlreadyCancelled' });
});

test('Unknown policy', async () => {
  await given(PolicyIssued('P1')); // only events of other policies
  await assert.rejects(when({ policyId: 'P9', requestedAt: '2026-11-10T00:00:00Z' }), { message: 'PolicyNotFound' });
});

test('Screen showed a different deadline', async () => {
  await given(PolicyIssued('P1'));
  await assert.rejects(
    when({ policyId: 'P1', requestedAt: '2026-11-10T00:00:00Z', coolingOffEndsAt: '2026-12-31T23:59:00Z' }),
    { message: 'CoolingOffEndMismatch' },
  );
  await thenEvents('P1', []);
});
