import { queryItem } from 'es-dcb-library';
import { defineProjection, createEventDispatcher } from 'es-dcb-library/projections';

export const collectionIdFor = (policyId, period) => `collection-${policyId}-${period}`; // deterministic

// Todo list: one row per policy and period. The status column is the lane:
// open (the processor picks it up), requested (waiting for the provider),
// needs_attention (a person works it), collected (done).
export const premiumsToCollectProjection = defineProjection({
  name: 'premiums-to-collect',
  query: queryItem({
    types: ['PolicyIssued', 'PolicyLapsed', 'CollectionRunStarted', 'PremiumCollectionRequested',
      'PremiumCollectionAttemptFailed', 'PremiumCollectionEscalated', 'PremiumCollected'],
  }),
  async setup(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS policies_in_force (policy_id TEXT PRIMARY KEY, premium NUMERIC NOT NULL);
      CREATE TABLE IF NOT EXISTS premiums_to_collect (
        collection_id TEXT PRIMARY KEY,
        policy_id     TEXT NOT NULL,
        period        TEXT NOT NULL,
        amount        NUMERIC NOT NULL,
        due_at        TIMESTAMPTZ NOT NULL,
        status        TEXT NOT NULL DEFAULT 'open',
        attempt       INT NOT NULL DEFAULT 0,
        requested_at  TIMESTAMPTZ,
        last_reason   TEXT
      )`);
  },
  handler: createEventDispatcher({
    PolicyIssued: (d, _e, c) =>
      c.query('INSERT INTO policies_in_force VALUES ($1, $2) ON CONFLICT DO NOTHING', [d.policyId, d.monthlyPremium]),
    PolicyLapsed: (d, _e, c) => c.query('DELETE FROM policies_in_force WHERE policy_id = $1', [d.policyId]),
    CollectionRunStarted: (d, _e, c) =>
      c.query(
        `INSERT INTO premiums_to_collect (collection_id, policy_id, period, amount, due_at)
         SELECT 'collection-' || policy_id || '-' || $1, policy_id, $1, premium, $2 FROM policies_in_force
         ON CONFLICT DO NOTHING`,
        [d.period, d.dueAt]),
    PremiumCollectionRequested: (d, _e, c) =>
      c.query(`UPDATE premiums_to_collect SET status = 'requested', attempt = $2, requested_at = $3 WHERE collection_id = $1`,
        [d.collectionId, d.attempt, d.requestedAt]),
    PremiumCollectionAttemptFailed: (d, _e, c) =>
      c.query(`UPDATE premiums_to_collect SET status = 'open', last_reason = $2 WHERE collection_id = $1 AND status = 'requested'`,
        [d.collectionId, d.reason]),
    PremiumCollectionEscalated: (d, _e, c) => setStatus(c, d.collectionId, 'needs_attention'),
    PremiumCollected: (d, _e, c) => setStatus(c, d.collectionId, 'collected'),
  }),
});
const setStatus = (c, id, status) => c.query('UPDATE premiums_to_collect SET status = $2 WHERE collection_id = $1', [id, status]);

const toItem = (r) => ({ collectionId: r.collection_id, policyId: r.policy_id, period: r.period, amount: Number(r.amount), attempt: r.attempt });

// What the collection processor reads: the open lane.
export async function listPremiumsToCollect(pool) {
  const { rows } = await pool.query("SELECT * FROM premiums_to_collect WHERE status = 'open' ORDER BY collection_id");
  return rows.map(toItem);
}

// Requested longer ago than the window, and the provider never answered.
export async function listStaleRequests(pool, now, windowMinutes = 60) {
  const { rows } = await pool.query(
    `SELECT * FROM premiums_to_collect
     WHERE status = 'requested' AND requested_at < $1::timestamptz - make_interval(mins => $2) ORDER BY collection_id`,
    [now, windowMinutes]);
  return rows.map(toItem);
}

// What a person works from.
export async function listNeedsAttention(pool) {
  const { rows } = await pool.query("SELECT * FROM premiums_to_collect WHERE status = 'needs_attention' ORDER BY collection_id");
  return rows.map((r) => ({ ...toItem(r), reason: r.last_reason }));
}
