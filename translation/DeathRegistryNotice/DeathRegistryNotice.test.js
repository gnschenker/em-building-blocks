import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { queryItem } from 'es-dcb-library';
import { store, pool, given, runProjections, reset } from '../testkit.js';
import {
  external, translate, ingest, sourceTag,
  translationProjection, workerProjection,
  listToTranslate, listToApply,
  processTranslations, processWork,
} from './DeathRegistryNotice.js';

const project = () => runProjections(translationProjection, workerProjection);
beforeEach(() => reset(
  [translationProjection, workerProjection],
  ['death_notices_to_translate', 'death_claims_to_open'],
));
after(() => pool.end());

async function thenEvents(types, tag, expected) {
  const { events } = await store.load(queryItem({ types, tags: [tag] }));
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
const mapped = {
  insuredNationalId: 'N-1001',
  dateOfDeath: '2026-10-28',
  registeredAt: '2026-11-01T10:00:00Z',
  claimType: 'death',
  sourceEventId: 'DR-2026-441',
};
const notice = { type: 'DeathRegistryNotice', data: payload, tags: [sourceTag('DR-2026-441')] };
const unknownNotice = { type: 'DeathRegistryNotice', data: unknown, tags: [sourceTag('DR-2026-442')] };
const observed = {
  type: 'DeathNoticeObserved',
  data: mapped,
  tags: ['person:N-1001', sourceTag('DR-2026-441')],
};
const recorded = {
  type: 'DeathClaimOpened',
  data: { policyId: 'P1', ...mapped },
  tags: ['policy:P1', 'person:N-1001', sourceTag('DR-2026-441')],
};
const rejected = (reason, policyId) => ({
  type: 'DeathClaimRejected',
  data: { ...mapped, reason },
  tags: policyId
    ? ['policy:P1', 'person:N-1001', sourceTag('DR-2026-441')]
    : ['person:N-1001', sourceTag('DR-2026-441')],
});

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

test('A death notice is stored as DeathRegistryNotice', async () => {
  const event = await ingest(store, payload);
  assert.deepEqual({ type: event.type, data: event.data, tags: event.tags }, notice);
  assert.equal(await ingest(store, payload), null);
});

test('The payload maps to a death notice, unknown codes are ignored', () => {
  assert.deepEqual(translate(payload), mapped);
  assert.equal(translate(unknown), null);
});

test('Given a DeathRegistryNotice, when TranslateDeathRegistryNotice, then DeathNoticeObserved', async () => {
  await given(notice);
  await project();
  await processTranslations({ pool, store });
  await thenEvents(['DeathNoticeObserved'], 'person:N-1001', [observed]);
});

test('The same DeathRegistryNotice translated twice is recorded once', async () => {
  await given(notice);
  await project();
  await processTranslations({ pool, store });
  const second = await processTranslations({ pool, store });
  assert.equal(second[0].event, null);
  await thenEvents(['DeathNoticeObserved'], 'person:N-1001', [observed]);
});

test('An unknown code is skipped and records no internal event', async () => {
  await given(unknownNotice);
  await project();
  assert.equal((await processTranslations({ pool, store }))[0].event, null);
  await thenEvents(['DeathNoticeObserved'], 'person:N-1001', []);
});

test('The translation todo list is never closed', async () => {
  await given(notice);
  await project();
  await processTranslations({ pool, store });
  await project();
  assert.deepEqual(await listToTranslate(pool), [payload]);
});

test('Given a policy in force, when OpenDeathClaim, then DeathClaimOpened and the worker todo closes', async () => {
  await given(PolicyIssued('P1', 'N-1001'), observed);
  await project();
  assert.equal((await listToApply(pool)).length, 1);
  await processWork({ pool, store });
  await thenEvents(['DeathClaimOpened'], 'person:N-1001', [recorded]);
  await project();
  assert.deepEqual(await listToApply(pool), []);
});

test('Given no matching policy, OpenDeathClaim records DeathClaimRejected and the worker todo closes', async () => {
  await given(observed);
  await project();
  await processWork({ pool, store });
  await thenEvents(['DeathClaimRejected'], 'person:N-1001', [rejected('PolicyNotFound')]);
  await project();
  assert.deepEqual(await listToApply(pool), []);
});

test('Given a lapsed policy, OpenDeathClaim records DeathClaimRejected and the worker todo closes', async () => {
  await given(PolicyIssued('P1', 'N-1001'), PolicyLapsed('P1', 'N-1001'), observed);
  await project();
  await processWork({ pool, store });
  await thenEvents(['DeathClaimRejected'], 'person:N-1001', [rejected('PolicyNotInForce', 'P1')]);
  await project();
  assert.deepEqual(await listToApply(pool), []);
});
