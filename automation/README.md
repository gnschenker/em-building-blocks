# Automation slices: premium collection in life and health insurance

A follow-up to ["The work nobody clicks"](https://www.linkedin.com/pulse/work-nobody-clicks-gabriel-n-schenker-yhzge/). Same style as ["One slice, end to end"](https://www.linkedin.com/pulse/one-slice-end-gabriel-n-schenker-gomle/) and ["Read models are cheap. Coupling isn't."](https://www.linkedin.com/pulse/read-models-cheap-coupling-isnt-gabriel-n-schenker-7geqe/): plain JavaScript (ESM) on Node 20, [es-dcb-library](https://www.npmjs.com/package/es-dcb-library) 1.0.1 and PostgreSQL 14+.

Every automation here has the same shape: a todo list (a projection), a processor that reads the open rows and sends one command per row, and a command handler that decides from past events. The event the command records takes the row off the list.

| Folder | Slice |
|---|---|
| `CollectionRuns/` | Time-based: collection runs with a `dueAt`; the processor takes a clock and starts the runs that are due |
| `PremiumCollection/` | Todo list + processor: one row per policy and period, charged once; failed attempts retry, the third escalates to a needs-attention lane; a stale request is resent with the same idempotency key |
| `PaymentProviderResult/` | Translation: the provider's webhook becomes PremiumCollected or PremiumCollectionFailed |
| `CollectionDashboard/` | Business monitoring: a read-only query over the two todo tables, including the needs-attention lane, served at `GET /dashboard/collections` |

Shared: `processor.js` (the loop every processor uses), `store.js` (event store), `testkit.js` and `fixtures.js` (test helpers), `server.js` (dashboard endpoint only).

## Run

```bash
npm install
createdb automation_code
export DATABASE_URL=postgres://postgres@localhost:5432/automation_code
npm test     # all scenarios against a real Postgres, one file at a time
npm start    # http://localhost:3000/dashboard/collections
```

`npm test` passes `--test-concurrency=1` (all files share one database) and `--test-force-exit`: es-dcb-library 1.0.1 leaves a 30-second setup-timeout timer running after `ProjectionManager.initialize()`, so without the flag each test file waits about 30 s before it exits.
