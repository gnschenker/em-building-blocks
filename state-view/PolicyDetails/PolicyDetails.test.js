import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { ProjectionManager } from 'es-dcb-library/projections';
import { store, pool } from '../store.js';
import { policyDetailsProjection, getPolicyDetails } from './PolicyDetails.js';

const ENDS = '2026-11-30T23:59:00Z';
const PolicyIssued = (policyId) => ({
  type: 'PolicyIssued',
  data: { policyId, policyNumber: `NR-${policyId}`, policyholderId: 'H1', issuedAt: '2026-11-01T00:00:00Z', coolingOffEndsAt: ENDS },
  tags: [`policy:${policyId}`],
});
const PolicyCancelledInCoolingOff = (policyId, requestedAt, reason = null) => ({
  type: 'PolicyCancelledInCoolingOff',
  data: { policyId, requestedAt, reason },
  tags: [`policy:${policyId}`],
});

// Catches the projection up on every committed event, then stops it.
async function runProjection() {
  const manager = new ProjectionManager({ pool, store, projections: [policyDetailsProjection] });
  await manager.initialize();
  manager.start();
  await manager.waitUntilLive(); // live = catch-up is done
  await manager.stop();
}
const resetCheckpoint = () =>
  pool.query('UPDATE projection_checkpoints SET last_tx_id = NULL, last_position = NULL WHERE name = $1', [policyDetailsProjection.name]);

before(async () => {
  const manager = new ProjectionManager({ pool, store, projections: [policyDetailsProjection] });
  await manager.initialize(); // creates policy_details and the checkpoint row
  await manager.stop();
});
beforeEach(async () => {
  await pool.query('TRUNCATE events, policy_details');
  await resetCheckpoint();
});
after(() => pool.end());

const given = (...events) => store.append(events);
const P1 = { policyId: 'P1', policyNumber: 'NR-P1', issuedAt: '2026-11-01T00:00:00.000Z', coolingOffEndsAt: '2026-11-30T23:59:00.000Z' };

test('Issued only', async () => {
  await given(PolicyIssued('P1'));
  await runProjection();
  assert.deepEqual(await getPolicyDetails(pool, 'P1'), { ...P1, cancelled: false });
});

test('Issued then cancelled', async () => {
  await given(PolicyIssued('P1'), PolicyCancelledInCoolingOff('P1', '2026-11-10T00:00:00Z'));
  await runProjection();
  assert.deepEqual(await getPolicyDetails(pool, 'P1'), { ...P1, cancelled: true });
});

test('Events of other policies are ignored', async () => {
  await given(PolicyIssued('P1'), PolicyIssued('P2'), PolicyCancelledInCoolingOff('P2', '2026-11-10T00:00:00Z'));
  await runProjection();
  assert.deepEqual(await getPolicyDetails(pool, 'P1'), { ...P1, cancelled: false });
});

test('Unknown policy', async () => {
  await given(PolicyIssued('P1'));
  await runProjection();
  assert.equal(await getPolicyDetails(pool, 'P9'), null);
});

test('Replay is idempotent', async () => {
  await given(PolicyIssued('P1'), PolicyCancelledInCoolingOff('P1', '2026-11-10T00:00:00Z'));
  await runProjection();
  await resetCheckpoint(); // replay every event from the start
  await runProjection();
  assert.deepEqual(await getPolicyDetails(pool, 'P1'), { ...P1, cancelled: true });
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM policy_details')).rows[0].n, 1);
});
