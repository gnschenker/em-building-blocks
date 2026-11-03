import { queryItem } from 'es-dcb-library';
import { defineProjection, createEventDispatcher } from 'es-dcb-library/projections';

// Todo list: premium collection runs that are scheduled but not started.
// Each row has its own due date. A run that is late stays on the list, visibly.
export const collectionRunsDueProjection = defineProjection({
  name: 'collection-runs-due',
  query: queryItem({ types: ['CollectionRunScheduled', 'CollectionRunStarted'] }),
  async setup(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS collection_runs_due (
        period  TEXT PRIMARY KEY,                -- e.g. '2026-12'
        due_at  TIMESTAMPTZ NOT NULL,
        started BOOLEAN NOT NULL DEFAULT false
      )`);
  },
  handler: createEventDispatcher({
    CollectionRunScheduled: (data, _e, c) =>
      c.query('INSERT INTO collection_runs_due (period, due_at) VALUES ($1, $2) ON CONFLICT DO NOTHING', [data.period, data.dueAt]),
    CollectionRunStarted: (data, _e, c) =>
      c.query('UPDATE collection_runs_due SET started = true WHERE period = $1', [data.period]),
  }),
});

// Only the rows whose date has passed. "Now" is a parameter, not a hidden clock.
export async function listDueCollectionRuns(pool, now) {
  const { rows } = await pool.query(
    'SELECT period FROM collection_runs_due WHERE NOT started AND due_at <= $1 ORDER BY due_at', [now]);
  return rows.map((r) => ({ period: r.period }));
}
