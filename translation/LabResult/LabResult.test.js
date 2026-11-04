import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { queryItem } from 'es-dcb-library';
import { store, pool, given, runProjections, reset } from '../testkit.js';
import {
  external, translate, ingest, sourceTag,
  translationProjection, workerProjection,
  listToTranslate, listToApply,
  processTranslations, processWork,
} from './LabResult.js';

const project = () => runProjections(translationProjection, workerProjection);
beforeEach(() => reset(
  [translationProjection, workerProjection],
  ['lab_results_to_translate', 'underwriting_evidence_to_record'],
));
after(() => pool.end());

async function thenEvents(types, tag, expected) {
  const { events } = await store.load(queryItem({ types, tags: [tag] }));
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
const mapped = {
  applicationId: 'A1',
  marker: 'fasting_glucose',
  value: 5.55,
  unit: 'mmol/L',
  observedAt: '2026-11-02T09:00:00Z',
  sourceEventId: 'LR-1001',
};
const labResult = { type: 'LabResult', data: payload, tags: [sourceTag('LR-1001')] };
const unknownLabResult = { type: 'LabResult', data: unknown, tags: [sourceTag('LR-1002')] };
const observed = {
  type: 'UnderwritingEvidenceObserved',
  data: mapped,
  tags: ['application:A1', sourceTag('LR-1001')],
};
const recorded = {
  type: 'UnderwritingEvidenceRecorded',
  data: mapped,
  tags: ['application:A1', sourceTag('LR-1001')],
};
const rejected = (reason) => ({
  type: 'UnderwritingEvidenceRejected',
  data: { ...mapped, reason },
  tags: ['application:A1', sourceTag('LR-1001')],
});

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

test('A lab result is stored as LabResult', async () => {
  const event = await ingest(store, payload);
  assert.deepEqual({ type: event.type, data: event.data, tags: event.tags }, labResult);
  assert.equal(await ingest(store, payload), null);
});

test('The payload maps to underwriting evidence, unknown codes are ignored', () => {
  assert.deepEqual(translate(payload), mapped);
  assert.equal(translate(unknown), null);
});

test('Given a LabResult, when TranslateLabResult, then UnderwritingEvidenceObserved', async () => {
  await given(labResult);
  await project();
  await processTranslations({ pool, store });
  await thenEvents(['UnderwritingEvidenceObserved'], 'application:A1', [observed]);
});

test('The same LabResult translated twice is recorded once', async () => {
  await given(labResult);
  await project();
  await processTranslations({ pool, store });
  const second = await processTranslations({ pool, store });
  assert.equal(second[0].event, null);
  await thenEvents(['UnderwritingEvidenceObserved'], 'application:A1', [observed]);
});

test('An unknown code is skipped and records no internal event', async () => {
  await given(unknownLabResult);
  await project();
  assert.equal((await processTranslations({ pool, store }))[0].event, null);
  await thenEvents(['UnderwritingEvidenceObserved'], 'application:A1', []);
});

test('The translation todo list is never closed', async () => {
  await given(labResult);
  await project();
  await processTranslations({ pool, store });
  await project();
  assert.deepEqual(await listToTranslate(pool), [payload]);
});

test('Given an application in underwriting, when RecordUnderwritingEvidence, then UnderwritingEvidenceRecorded and the worker todo closes', async () => {
  await given(ApplicationReceived('A1'), observed);
  await project();
  assert.equal((await listToApply(pool)).length, 1);
  await processWork({ pool, store });
  await thenEvents(['UnderwritingEvidenceRecorded'], 'application:A1', [recorded]);
  await project();
  assert.deepEqual(await listToApply(pool), []);
});

test('Given no matching application, RecordUnderwritingEvidence records UnderwritingEvidenceRejected and the worker todo closes', async () => {
  await given(observed);
  await project();
  await processWork({ pool, store });
  await thenEvents(['UnderwritingEvidenceRejected'], 'application:A1', [rejected('ApplicationNotFound')]);
  await project();
  assert.deepEqual(await listToApply(pool), []);
});

test('Given a closed application, RecordUnderwritingEvidence records UnderwritingEvidenceRejected and the worker todo closes', async () => {
  await given(ApplicationReceived('A1'), PolicyIssued('A1'), observed);
  await project();
  await processWork({ pool, store });
  await thenEvents(['UnderwritingEvidenceRejected'], 'application:A1', [rejected('ApplicationNotInUnderwriting')]);
  await project();
  assert.deepEqual(await listToApply(pool), []);
});
