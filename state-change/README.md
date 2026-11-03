# State Change Slice: CancelPolicyInCoolingOff

This example demonstrates a complete **State Change** slice implementation in Event Modeling. It shows how to handle a command that changes system state by validating business rules and persisting an event.

## What This Slice Does

Implements the "Cancel Policy in Cooling Off" workflow - allowing policy cancellation during a cooling-off period with business rule validation:
- Checks that the policy exists
- Verifies the policy hasn't already been cancelled
- Validates the cooling-off period hasn't expired
- Confirms the cooling-off end date matches expectations

## Implementation Details

Built with plain JavaScript (ESM) on Node 20 and browser-compatible, using:
- [es-dcb-library](https://www.npmjs.com/package/es-dcb-library) 1.0.1 (npm)
- PostgreSQL 14+

### Model to Code Mapping

| Model Element | File | Implementation |
|---|---|---|
| Screen: Cancel policy | `CancelPolicyInCoolingOff/CancelPolicyScreen.html` | Form with "Cancel my policy" button |
| Command: CancelPolicyInCoolingOff | `CancelPolicyInCoolingOff/CancelPolicyInCoolingOff.js` | `cancelPolicyInCoolingOff(store, { policyId, requestedAt, reason, coolingOffEndsAt })` |
| Consistency boundary | Same file | `decisionQuery(policyId)` for tag `policy:{policyId}` |
| Decision model | Same file | `decisionModel(events)` |
| Business rules (1-4) | Same file | Four guard clauses: `PolicyNotFound`, `PolicyAlreadyCancelled`, `CoolingOffEndMismatch`, `CoolingOffPeriodExpired` |
| Event: PolicyCancelledInCoolingOff | Same file | `store.append(..., { failIfEventsMatch: query, after: position })` |
| Test scenarios (1-6) | `CancelPolicyInCoolingOff/CancelPolicyInCoolingOff.test.js` | One `test()` per scenario |

## Prerequisites

- Node.js 20+
- PostgreSQL 14+
- Running PostgreSQL instance accessible at `DATABASE_URL`

## Installation

```bash
cd state-change
npm install
```

## Running the Tests

```bash
export DATABASE_URL=postgres://postgres@localhost:5432/postgres
npm test
```

The test suite includes six scenarios testing all business rules against a real PostgreSQL database.

## Running the Application

```bash
export DATABASE_URL=postgres://postgres@localhost:5432/postgres
npm start
```

Then navigate to: `http://localhost:3000/?policyId=P1`

## Learn More

Read the accompanying article: ["One slice, end to end"](https://www.linkedin.com/pulse/one-slice-end-gabriel-n-schenker-gomle/)
