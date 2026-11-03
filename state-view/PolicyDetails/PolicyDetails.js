import { queryItem } from 'es-dcb-library';
import { defineProjection, createEventDispatcher } from 'es-dcb-library/projections';

// Read model for the cancel screen: one row per policy, nothing more.
export const policyDetailsProjection = defineProjection({
  name: 'policy-details', // also the key of this projection's checkpoint row
  query: queryItem({ types: ['PolicyIssued', 'PolicyCancelledInCoolingOff'] }),
  async setup(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS policy_details (
        policy_id           TEXT PRIMARY KEY,
        policy_number       TEXT NOT NULL,
        issued_at           TIMESTAMPTZ NOT NULL,
        cooling_off_ends_at TIMESTAMPTZ NOT NULL,
        cancelled           BOOLEAN NOT NULL DEFAULT false
      )`);
  },
  // Runs inside the transaction that also moves the checkpoint. Safe to replay.
  handler: createEventDispatcher({
    PolicyIssued: async (data, _event, client) => {
      await client.query(
        `INSERT INTO policy_details (policy_id, policy_number, issued_at, cooling_off_ends_at)
         VALUES ($1, $2, $3, $4) ON CONFLICT (policy_id) DO NOTHING`,
        [data.policyId, data.policyNumber, data.issuedAt, data.coolingOffEndsAt],
      );
    },
    PolicyCancelledInCoolingOff: async (data, _event, client) => {
      await client.query('UPDATE policy_details SET cancelled = true WHERE policy_id = $1', [data.policyId]);
    },
  }),
});

// Query handler: what the cancel screen asks for. null means unknown policy.
export async function getPolicyDetails(pool, policyId) {
  const { rows } = await pool.query('SELECT * FROM policy_details WHERE policy_id = $1', [policyId]);
  if (rows.length === 0) return null;
  const [row] = rows;
  return {
    policyId: row.policy_id,
    policyNumber: row.policy_number,
    issuedAt: row.issued_at.toISOString(),
    coolingOffEndsAt: row.cooling_off_ends_at.toISOString(),
    cancelled: row.cancelled,
  };
}
