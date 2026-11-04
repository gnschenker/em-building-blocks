# Translation slices: inbound facts in life and health insurance

Same style as ["One slice, end to end"](https://www.linkedin.com/pulse/one-slice-end-gabriel-n-schenker-gomle/), ["Read models are cheap. Coupling isn't."](https://www.linkedin.com/pulse/read-models-cheap-coupling-isnt-gabriel-n-schenker-7geqe/) and ["The work nobody clicks"](https://www.linkedin.com/pulse/work-nobody-clicks-gabriel-n-schenker-yhzge/): plain JavaScript (ESM) on Node 20, [es-dcb-library](https://www.npmjs.com/package/es-dcb-library) 1.0.1 and PostgreSQL 14+.

Translation is inbound only. An external system's event is stored as-is, then converted into the language of this system. A separate worker then issues a command, which records a business event. Translation itself holds no business rules. Your worker command is where every rule applies.

Translation is related to an anti-corruption layer but narrower: one small, inbound-only slice with the same shape every time.

Every translator here has the same two-step shape. Diff any two folders and only the domain mapping and its decision model change.

```
external event
    -> translation todo list                 (never closed)
    -> translation automation + command      (pure mapping)
    -> internal event
    -> worker todo list                      (closed by the outcome)
    -> worker automation + command           (all rules)
    -> business event
```

The feed endpoint stores the external event and returns. Processors read the todo lists and issue the commands.

## Two steps

**Translation is pure mapping.** Codes, units and ids only. No existence checks, no state checks. The only allowed condition is dedupe on the source event id (a DCB tag on that id, `failIfEventsMatch` + `after`). Unknown codes skip: `translate` returns `null`, no internal event is recorded, and the item stays on the translation todo list.

The translation todo list is fed by the external event and is never closed: no backward arrow, no done marker. The processor can see the same row again; the command records the internal event once because the source event id is the deterministic id.

**The worker holds every business rule.** Its todo list is fed by the internal event and is closed by the worker's outcome: the business event on success, or a rejection event so the item still leaves the list (ApplicationNotFound, ApplicationNotInUnderwriting, CollectionNotFound, AttemptNotInFlight, PolicyNotFound, PolicyNotInForce).

| Step | Function | Role |
|---|---|---|
| External event | `ingest(store, payload)` | Stored as-is, named for its business meaning, never `...Received` |
| Translation todo list | `listToTranslate(pool)` | Every external event. Never closed |
| Mapping | `translate(payload)` | Pure. Returns the internal data, or `null` to skip |
| Translation command | `recordTranslation(store, payload)` | Mapping plus source-id dedupe. Records the internal event |
| Translation processor | `processTranslations({ pool, store })` | Loop over the translation todo list |
| Worker todo list | `listToApply(pool)` | Open rows only. Closed by the outcome |
| Worker command | `issue(store, command)` | Where business rules apply, and the outcome is recorded |
| Worker processor | `processWork({ pool, store })` | Loop over the worker todo list |

| Folder | External event | Translation command / event | Worker command / events |
|---|---|---|---|
| `LabResult/` | `LabResult` | `TranslateLabResult` → `UnderwritingEvidenceObserved` | `RecordUnderwritingEvidence` → `UnderwritingEvidenceRecorded` or `UnderwritingEvidenceRejected` |
| `DirectDebitReturn/` | `DirectDebitReturn` | `TranslateDirectDebitReturn` → `CollectionReturnObserved` | `RecordCollectionAttemptFailed` → `PremiumCollectionAttemptFailed` or `CollectionReturnRejected` |
| `DeathRegistryNotice/` | `DeathRegistryNotice` | `TranslateDeathRegistryNotice` → `DeathNoticeObserved` | `OpenDeathClaim` → `DeathClaimOpened` or `DeathClaimRejected` |

Shared: `processor.js` (the loop every processor uses), `store.js` (event store), `testkit.js` (test helpers), `server.js` (the three feed endpoints, plus the processors).

## Run

```bash
npm install
createdb translation_code
export DATABASE_URL=postgres://postgres@localhost:5432/translation_code
npm test
npm start    # POST http://localhost:3000/feeds/lab-results
```

`npm test` passes `--test-concurrency=1` (all files share one database) and `--test-force-exit`: es-dcb-library 1.0.1 leaves a 30-second setup-timeout timer running after `ProjectionManager.initialize()`, so without the flag each test file waits about 30 s before it exits.
