# One slice, end to end: CancelPolicyInCoolingOff

Plain JavaScript (ESM) on Node 20 and in the browser, on [es-dcb-library](https://www.npmjs.com/package/es-dcb-library) 1.0.1 (npm) and PostgreSQL 13+.

## Model to code

| Model element | File | Code |
|---|---|---|
| Screen: Cancel policy | `CancelPolicyInCoolingOff/CancelPolicyScreen.html` | form, "Cancel my policy" button posts the command |
| Command: CancelPolicyInCoolingOff | `CancelPolicyInCoolingOff/CancelPolicyInCoolingOff.js` | `cancelPolicyInCoolingOff(store, { policyId, requestedAt, reason, coolingOffEndsAt })` |
| Consistency boundary (PolicyIssued + PolicyCancelledInCoolingOff, tag `policy:{policyId}`) | same file | `decisionQuery(policyId)` |
| Decision model | same file | `decisionModel(events)` |
| Rules 1-4 | same file | four guard clauses: `PolicyNotFound`, `PolicyAlreadyCancelled`, `CoolingOffEndMismatch`, `CoolingOffPeriodExpired` |
| Event: PolicyCancelledInCoolingOff | same file | `store.append(..., { failIfEventsMatch: query, after: position })` |
| Scenarios 1-6 | `CancelPolicyInCoolingOff/CancelPolicyInCoolingOff.test.js` | one `test()` per scenario, named as in the model |

Glue outside the slice: `store.js` (connects the event store) and `server.js` (one HTTP route that stamps `requestedAt` from the server clock, and serves the screen).

## Run

```bash
npm install
export DATABASE_URL=postgres://postgres@localhost:5432/postgres
npm test     # the six scenarios against a real Postgres
npm start    # http://localhost:3000/?policyId=P1
```
