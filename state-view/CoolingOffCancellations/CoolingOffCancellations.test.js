import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { ProjectionManager } from 'es-dcb-library/projections';
import { store, pool } from '../store.js';
import { coolingOffCancellationsProjection, listCoolingOffCancellations } from './CoolingOffCancellations.js';

const projection = coolingOffCancellationsProjection(store);
const PolicyIssued = (policyId) => ({
  type: 'PolicyIssued',
  data: { policyId, policyNumber: `NR-${policyId}`, policyholderId: 'H1', issuedAt: '2026-11-01T00:00:00Z', coolingOffEndsAt: '2026-11-30T23:59:00Z' },
  tags: [`policy:${policyId}`],
});
const PolicyCancelledInCoolingOff = (policyId, requestedAt, reason = null) => ({
  type: 'PolicyCancelledInCoolingOff',
  data: { policyId, requestedAt, reason },
  tags: [`policy:${policyId}`],
});

// Catches the projection up on every committed event, then stops it.
async function runProjection() {
  const manager = new ProjectionManager({ pool, store, projections: [projection] });
  await manager.initialize();
  manager.start();
  await manager.waitUntilLive(); // live = catch-up is done
  await manager.stop();
}
const resetCheckpoint = () =>
  pool.query('UPDATE projection_checkpoints SET last_tx_id = NULL, last_position = NULL WHERE name = $1', [projection.name]);

before(async () => {
  const manager = new ProjectionManager({ pool, store, projections: [projection] });
  await manager.initialize(); // creates cooling_off_cancellations and the checkpoint row
  await manager.stop();
});
beforeEach(async () => {
  await pool.query('TRUNCATE events, cooling_off_cancellations');
  await resetCheckpoint();
});
after(() => pool.end());

const given = (...events) => store.append(events);

test('Issued only', async () => {
  await given(PolicyIssued('P1'));
  await runProjection();
  assert.deepEqual(await listCoolingOffCancellations(pool), []);
});

test('Issued then cancelled', async () => {
  await given(PolicyIssued('P1'), PolicyCancelledInCoolingOff('P1', '2026-11-10T00:00:00Z', 'Changed my mind'));
  await runProjection();
  assert.deepEqual(await listCoolingOffCancellations(pool), [
    { policyNumber: 'NR-P1', requestedAt: '2026-11-10T00:00:00.000Z', reason: 'Changed my mind', daysIntoWindow: 9 },
  ]);
});

test('Last moment still counts', async () => {
  await given(PolicyIssued('P1'), PolicyCancelledInCoolingOff('P1', '2026-11-30T23:59:00Z'));
  await runProjection();
  assert.deepEqual(await listCoolingOffCancellations(pool), [
    { policyNumber: 'NR-P1', requestedAt: '2026-11-30T23:59:00.000Z', reason: null, daysIntoWindow: 29 },
  ]);
});

test('Events of other policies are ignored', async () => {
  await given(PolicyIssued('P1'), PolicyIssued('P2'), PolicyCancelledInCoolingOff('P2', '2026-11-10T00:00:00Z'));
  await runProjection();
  assert.deepEqual((await listCoolingOffCancellations(pool)).map((row) => row.policyNumber), ['NR-P2']);
});

test('Replay is idempotent', async () => {
  await given(PolicyIssued('P1'), PolicyCancelledInCoolingOff('P1', '2026-11-10T00:00:00Z', 'Changed my mind'));
  await runProjection();
  await resetCheckpoint(); // replay every event from the start
  await runProjection();
  assert.deepEqual(await listCoolingOffCancellations(pool), [
    { policyNumber: 'NR-P1', requestedAt: '2026-11-10T00:00:00.000Z', reason: 'Changed my mind', daysIntoWindow: 9 },
  ]);
});
