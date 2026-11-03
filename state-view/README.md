# State view slices: one read model per use case

A follow-up to "One slice, end to end". Same policy domain, same events, plain JavaScript (ESM) on Node 20 and in the browser, on [es-dcb-library](https://www.npmjs.com/package/es-dcb-library) 1.0.1 (npm) and PostgreSQL 14+.

Two use cases read the same two events, PolicyIssued and PolicyCancelledInCoolingOff:

- **Policy details**: the cancel screen needs one policy, its deadline, and whether to show the button.
- **Cooling-off cancellations**: the ops team needs a list of cancellations, with how far into the window each one came.

## Model to code

| Model element | File | Code |
|---|---|---|
| State view: Policy details (projection) | `PolicyDetails/PolicyDetails.js` | `policyDetailsProjection`: handles PolicyIssued and PolicyCancelledInCoolingOff |
| Read model: Policy details | same file | table `policy_details` (one row per policy), checkpoint row `policy-details` |
| Query: Policy details | same file | `getPolicyDetails(pool, policyId)` |
| Endpoint the cancel screen calls | `server.js` | `GET /policies/{policyId}/details` (404 `PolicyNotFound`) |
| Screen: Cancel policy | `CancelPolicyInCoolingOff/CancelPolicyScreen.html` | reads Policy details, hides the button when `cancelled` |
| Scenarios: Policy details | `PolicyDetails/PolicyDetails.test.js` | Issued only, Issued then cancelled, Events of other policies are ignored, Unknown policy, Replay is idempotent |
| State view: Cooling-off cancellations (projection) | `CoolingOffCancellations/CoolingOffCancellations.js` | `coolingOffCancellationsProjection(store)`: handles PolicyCancelledInCoolingOff, looks up the policy's PolicyIssued |
| Read model: Cooling-off cancellations | same file | table `cooling_off_cancellations` (one row per cancellation), checkpoint row `cooling-off-cancellations` |
| Query: Cooling-off cancellations | same file | `listCoolingOffCancellations(pool)`; served at `GET /ops/cooling-off-cancellations` |
| Scenarios: Cooling-off cancellations | `CoolingOffCancellations/CoolingOffCancellations.test.js` | Issued only, Issued then cancelled, Last moment still counts, Events of other policies are ignored, Replay is idempotent |
| State change: CancelPolicyInCoolingOff | `CancelPolicyInCoolingOff/` | unchanged from "One slice, end to end" except the screen |

Glue outside the slices: `store.js` (connects the event store) and `server.js` (runs both projections with the library's `ProjectionManager`, plus the HTTP routes).

## Why the two read models share nothing

The cancel screen and the ops list ask different questions, so each gets its own table, its own shape, its own checkpoint, and its own code. Policy details keeps one row for every policy, including the ones nobody cancels. The ops list keeps one row per cancellation and never sees a policy that stayed. Neither imports from the other, not even a helper. If ops wants a new column tomorrow, or the screen needs a new field, only one folder changes and only one projection is rebuilt from the events. Read models are cheap to make, so a change to one use case has no side effects on another.

## How a projection stays correct

The library runs each projection: it catches up from the projection's checkpoint over committed events only, in `(tx_id, global_position)` order, then follows new events through `LISTEN/NOTIFY`. Each event is handled in one transaction that also moves the checkpoint, so a crash never leaves the table and the checkpoint out of step. Delivery is at least once, so every write is idempotent (`ON CONFLICT DO NOTHING`, or an `UPDATE` that sets a fixed value). The "Replay is idempotent" scenarios reset the checkpoint and run every event again.

## Run

```bash
npm install
createdb state_view
export DATABASE_URL=postgres://postgres@localhost:5432/state_view
npm test     # all scenarios against a real Postgres, one file at a time
npm start    # http://localhost:3000/?policyId=P1
```

`npm test` passes `--test-force-exit`: es-dcb-library 1.0.1 leaves a 30-second setup-timeout timer running after `ProjectionManager.initialize()`, so without the flag each projection test file waits about 30 s before it exits.
