# State View Slice: Multiple Read Models

This example demonstrates **State View** slices in Event Modeling, showing how to build multiple read models from the same events without coupling them together.

## What This Slice Does

Implements two independent read models consuming the same policy events (PolicyIssued and PolicyCancelledInCoolingOff):

1. **Policy Details**: Powers the cancel screen, showing one policy with its deadline and whether cancellation is allowed
2. **Cooling-Off Cancellations**: Provides ops teams with a list of all cancellations and how far into the cooling-off window each occurred

## Key Principle: Read Models Are Cheap, Coupling Isn't

Each read model has its own:
- Database table with a custom shape
- Projection code
- Checkpoint for event tracking
- No shared code or imports between read models

This independence means changes to one use case never affect another. If ops needs a new column or the cancel screen needs a new field, only one folder and one projection needs to change.

## Implementation Details

Built with plain JavaScript (ESM) on Node 20 and browser-compatible, using:
- [es-dcb-library](https://www.npmjs.com/package/es-dcb-library) 1.0.1 (npm)
- PostgreSQL 14+

### Model to Code Mapping

| Model Element | File | Implementation |
|---|---|---|
| State view: Policy details (projection) | `PolicyDetails/PolicyDetails.js` | `policyDetailsProjection` handles events |
| Read model: Policy details | Same file | Table `policy_details`, checkpoint `policy-details` |
| Query: Policy details | Same file | `getPolicyDetails(pool, policyId)` |
| Screen: Cancel policy | `CancelPolicyInCoolingOff/CancelPolicyScreen.html` | Reads policy details, conditionally shows button |
| State view: Cooling-off cancellations | `CoolingOffCancellations/CoolingOffCancellations.js` | `coolingOffCancellationsProjection` |
| Read model: Cooling-off cancellations | Same file | Table `cooling_off_cancellations`, checkpoint `cooling-off-cancellations` |
| Query: Cancellations list | Same file | `listCoolingOffCancellations(pool)` |
| State change: CancelPolicyInCoolingOff | `CancelPolicyInCoolingOff/` | Same as in ["One slice, end to end"](https://www.linkedin.com/pulse/one-slice-end-gabriel-n-schenker-gomle/) |

### How Projections Stay Correct

The library's `ProjectionManager` runs each projection:
- Catches up from the projection's checkpoint over committed events in order
- Follows new events through PostgreSQL LISTEN/NOTIFY
- Handles each event in a transaction that also updates the checkpoint
- Ensures at-least-once delivery with idempotent writes
- Prevents table/checkpoint inconsistency during crashes

## Prerequisites

- Node.js 20+
- PostgreSQL 14+
- Running PostgreSQL instance accessible at `DATABASE_URL`

## Installation

```bash
cd state-view
npm install
```

## Setup Database

```bash
createdb state_view
export DATABASE_URL=postgres://postgres@localhost:5432/state_view
```

## Running the Tests

```bash
npm test
```

Tests include scenarios for:
- Policy details: Issued only, Issued then cancelled, Events of other policies ignored, Unknown policy, Replay idempotence
- Cooling-off cancellations: Issued only, Issued then cancelled, Last moment handling, Event isolation, Replay idempotence

**Test Configuration Notes:**
- `--test-concurrency=1`: All test files share one database, so they must run sequentially to avoid conflicts
- `--test-force-exit`: es-dcb-library 1.0.1 leaves a 30-second setup timeout running after `ProjectionManager.initialize()`, so this flag prevents the test process from waiting

## Running the Application

```bash
npm start
```

Then navigate to: `http://localhost:3000/?policyId=P1`

Available endpoints:
- `GET /policies/{policyId}/details` - Policy details (404 if PolicyNotFound)
- `GET /ops/cooling-off-cancellations` - List of cancellations

## Learn More

Read the accompanying article: ["Read models are cheap. Coupling isn't."](https://www.linkedin.com/pulse/read-models-cheap-coupling-isnt-gabriel-n-schenker-7geqe/)
