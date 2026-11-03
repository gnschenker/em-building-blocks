import { workThrough } from '../processor.js';
import { listDueCollectionRuns } from './CollectionRunsDue.js';
import { startCollectionRun } from './StartCollectionRun.js';

// Same loop as every processor, plus a clock. Tests pass a fixed one;
// production passes () => new Date(). If it was down, the due rows wait for it.
export async function processCollectionRuns({ pool, store, clock }) {
  const now = clock();
  const rows = await listDueCollectionRuns(pool, now);
  return workThrough(rows, (row) => startCollectionRun(store, { period: row.period, now }));
}
