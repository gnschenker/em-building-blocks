import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { queryItem } from 'es-dcb-library';
import { store, pool } from '../store.js';
import { external, translate, ingest, sourceTag } from './DeathRegistryNotice.js';

beforeEach(() => pool.query('TRUNCATE events'));
after(() => pool.end());

const given = (...events) => store.append(events);
const when = (payload) => ingest(store, payload);
async function thenEvents(tag, expected) {
  const { events } = await store.load(queryItem({ types: ['DeathClaimOpened'], tags: [tag] }));
  assert.deepEqual(events.map(({ type, data, tags }) => ({ type, data, tags })), expected);
}

const payload = external({
  id: 'DR-2026-441',
  type: 'death.registered',
  nationalId: 'N-1001',
  dateOfDeath: '2026-10-28',
  registeredAt: '2026-11-01T10:00:00Z',
});
const unknown = external({
  id: 'DR-2026-442',
  type: 'birth.registered',
  nationalId: 'N-1001',
  dateOfDeath: null,
  registeredAt: '2026-11-01T10:00:00Z',
});
const command = {
  insuredNationalId: 'N-1001',
  dateOfDeath: '2026-10-28',
  registeredAt: '2026-11-01T10:00:00Z',
  claimType: 'death',
  sourceEventId: 'DR-2026-441',
};
const recorded = {
  type: 'DeathClaimOpened',
  data: { policyId: 'P1', ...command },
  tags: ['policy:P1', 'person:N-1001', sourceTag('DR-2026-441')],
};

const PolicyIssued = (policyId, insuredNationalId) => ({
  type: 'PolicyIssued',
  data: { policyId, insuredNationalId, issuedAt: '2026-01-15T00:00:00Z' },
  tags: [`policy:${policyId}`, `person:${insuredNationalId}`],
});
const PolicyLapsed = (policyId, insuredNationalId) => ({
  type: 'PolicyLapsed',
  data: { policyId },
  tags: [`policy:${policyId}`, `person:${insuredNationalId}`],
});

test('The payload maps to a command, unknown codes are ignored', () => {
  assert.deepEqual(translate(payload), command);
  assert.equal(translate(unknown), null);
});

test('Given a policy in force, when a death notice arrives, then DeathClaimOpened', async () => {
  await given(PolicyIssued('P1', 'N-1001'));
  await when(payload);
  await thenEvents('person:N-1001', [recorded]);
});

test('The same payload delivered twice is recorded once', async () => {
  await given(PolicyIssued('P1', 'N-1001'));
  await when(payload);
  assert.equal(await when(payload), null);
  await thenEvents('person:N-1001', [recorded]);
});

test('An unknown code is ignored and records nothing', async () => {
  await given(PolicyIssued('P1', 'N-1001'));
  assert.equal(await when(unknown), null);
  await thenEvents('person:N-1001', []);
});

test('Given no matching record, the command is rejected', async () => {
  await assert.rejects(when(payload), { message: 'PolicyNotFound' });
});

test('Given a closed record, the command is rejected', async () => {
  await given(PolicyIssued('P1', 'N-1001'), PolicyLapsed('P1', 'N-1001'));
  await assert.rejects(when(payload), { message: 'PolicyNotInForce' });
});
