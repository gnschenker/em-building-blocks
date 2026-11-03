import { queryItem } from 'es-dcb-library';
import { defineProjection } from 'es-dcb-library/projections';

const DAY_MS = 24 * 60 * 60 * 1000;

// Read model for the ops team: one row per cancellation, never a row for a policy that stayed.
export const coolingOffCancellationsProjection = (store) =>
  defineProjection({
    name: 'cooling-off-cancellations', // also the key of this projection's checkpoint row
    query: queryItem({ types: ['PolicyCancelledInCoolingOff'] }),
    async setup(client) {
      await client.query(`
        CREATE TABLE IF NOT EXISTS cooling_off_cancellations (
          policy_id        TEXT PRIMARY KEY,
          policy_number    TEXT NOT NULL,
          requested_at     TIMESTAMPTZ NOT NULL,
          reason           TEXT,
          days_into_window INTEGER NOT NULL
        )`);
    },
    // Runs inside the transaction that also moves the checkpoint. Safe to replay.
    async handler(cancelled, client) {
      const { policyId, requestedAt, reason } = cancelled.data;
      const { events: [issued] } = await store.load(
        queryItem({ types: ['PolicyIssued'], tags: [`policy:${policyId}`] }),
      );
      const days = Math.floor((Date.parse(requestedAt) - Date.parse(issued.data.issuedAt)) / DAY_MS);
      await client.query(
        `INSERT INTO cooling_off_cancellations (policy_id, policy_number, requested_at, reason, days_into_window)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (policy_id) DO NOTHING`,
        [policyId, issued.data.policyNumber, requestedAt, reason, days],
      );
    },
  });

// Query handler: the ops list, newest first.
export async function listCoolingOffCancellations(pool) {
  const { rows } = await pool.query('SELECT * FROM cooling_off_cancellations ORDER BY requested_at DESC');
  return rows.map((row) => ({
    policyNumber: row.policy_number,
    requestedAt: row.requested_at.toISOString(),
    reason: row.reason,
    daysIntoWindow: row.days_into_window,
  }));
}
