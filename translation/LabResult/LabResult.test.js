import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { queryItem } from 'es-dcb-library';
import { store, pool } from '../store.js';
import { external, translate, ingest, sourceTag } from './LabResult.js';

beforeEach(() => pool.query('TRUNCATE events'));
after(() => pool.end());

const given = (...events) => store.append(events);
const when = (payload) => ingest(store, payload);
async function thenEvents(tag, expected) {
  const { events } = await store.load(queryItem({ types: ['UnderwritingEvidenceRecorded'], tags: [tag] }));
  assert.deepEqual(events.map(({ type, data, tags }) => ({ type, data, tags })), expected);
}

const payload = external({
  id: 'LR-1001',
  testCode: 'GLU_FAS',
  unit: 'mg/dL',
  value: 100,
  clientOrderId: 'A1',
  collectedAt: '2026-11-02T09:00:00Z',
});
const unknown = external({
  id: 'LR-1002',
  testCode: 'TSH',
  unit: 'mIU/L',
  value: 2.1,
  clientOrderId: 'A1',
  collectedAt: '2026-11-02T09:00:00Z',
});
const command = {
  applicationId: 'A1',
  marker: 'fasting_glucose',
  value: 5.55,
  unit: 'mmol/L',
  observedAt: '2026-11-02T09:00:00Z',
  sourceEventId: 'LR-1001',
};
const recorded = {
  type: 'UnderwritingEvidenceRecorded',
  data: command,
  tags: ['application:A1', sourceTag('LR-1001')],
};

const ApplicationReceived = (applicationId) => ({
  type: 'ApplicationReceived',
  data: { applicationId, applicantId: 'H1', receivedAt: '2026-11-01T00:00:00Z' },
  tags: [`application:${applicationId}`],
});
const PolicyIssued = (applicationId) => ({
  type: 'PolicyIssued',
  data: { applicationId, policyId: 'P1', issuedAt: '2026-11-03T00:00:00Z' },
  tags: [`application:${applicationId}`, 'policy:P1'],
});

test('The payload maps to a command, unknown codes are ignored', () => {
  assert.deepEqual(translate(payload), command);
  assert.equal(translate(unknown), null);
});

test('Given an application in underwriting, when a mapped lab result arrives, then UnderwritingEvidenceRecorded', async () => {
  await given(ApplicationReceived('A1'));
  await when(payload);
  await thenEvents('application:A1', [recorded]);
});

test('The same payload delivered twice is recorded once', async () => {
  await given(ApplicationReceived('A1'));
  await when(payload);
  assert.equal(await when(payload), null);
  await thenEvents('application:A1', [recorded]);
});

test('An unknown code is ignored and records nothing', async () => {
  await given(ApplicationReceived('A1'));
  assert.equal(await when(unknown), null);
  await thenEvents('application:A1', []);
});

test('Given no matching record, the command is rejected', async () => {
  await assert.rejects(when(payload), { message: 'ApplicationNotFound' });
});

test('Given a closed record, the command is rejected', async () => {
  await given(ApplicationReceived('A1'), PolicyIssued('A1'));
  await assert.rejects(when(payload), { message: 'ApplicationNotInUnderwriting' });
});
