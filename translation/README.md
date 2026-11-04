# Translation slices: inbound facts in life and health insurance

Same style as ["One slice, end to end"](https://www.linkedin.com/pulse/one-slice-end-gabriel-n-schenker-gomle/), ["Read models are cheap. Coupling isn't."](https://www.linkedin.com/pulse/read-models-cheap-coupling-isnt-gabriel-n-schenker-7geqe/) and ["The work nobody clicks"](https://www.linkedin.com/pulse/work-nobody-clicks-gabriel-n-schenker-yhzge/): plain JavaScript (ESM) on Node 20, [es-dcb-library](https://www.npmjs.com/package/es-dcb-library) 1.0.1 and PostgreSQL 14+.

Translation is inbound only. An external system's event is converted into the language of this system, and that then leads to a command, which records an event. Your command is where business rules apply. Translation itself holds none.

This is not an anti-corruption layer. An ACL is a bidirectional, synchronous facade that wraps a foreign model's API for outbound calls. Translation is one-way and inbound: it reacts to facts that already happened elsewhere and turns them into facts in this system.

Every translator here has the same shape. Diff any two folders and the only changes are the domain mapping.

| Step | Function | Role |
|---|---|---|
| External type | `external(...)` | Foreign payload, not a type this system records |
| Mapping | `translate(payload)` | Pure. Returns a command, or `null` to ignore |
| Dedupe key | `sourceTag(id)` | The external event id, used as a DCB tag |
| Command | `issue(store, command)` | Where business rules apply, and the event is recorded |
| Ingress | `ingest(store, payload)` | Map, then issue. Unknown codes never reach the command |

| Folder | External system | Command |
|---|---|---|
| `LabResult/` | Medical lab results feed: lab codes and units become underwriting evidence | Record underwriting evidence |
| `DirectDebitReturn/` | Bank or payment-provider debit return: a failed debit becomes a collection attempt failing | Record a premium collection attempt failed |
| `DeathRegistryNotice/` | Government death registry: a death notice becomes a death claim | Open a death claim |

Shared: `store.js` (event store), `server.js` (the three feed endpoints).

## Run

```bash
npm install
createdb translation_code
export DATABASE_URL=postgres://postgres@localhost:5432/translation_code
npm test
npm start    # POST http://localhost:3000/feeds/lab-results
```

`npm test` passes `--test-concurrency=1` because all files share one database.
