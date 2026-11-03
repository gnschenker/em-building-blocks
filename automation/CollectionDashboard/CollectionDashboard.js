// Business monitoring: the todo lists the processors already use, read-only.
// No new tables, no new infrastructure. Overdue = past its due date and still open.
export async function getCollectionDashboard(pool, now, graceHours = 24) {
  const runs = await pool.query(
    'SELECT period, due_at, due_at < $1 AS overdue FROM collection_runs_due WHERE NOT started ORDER BY due_at', [now]);
  const premiums = await pool.query(
    `SELECT collection_id, status, due_at, due_at + make_interval(hours => $2) < $1 AS overdue
     FROM premiums_to_collect WHERE status IN ('open', 'requested') ORDER BY due_at, collection_id`, [now, graceHours]);
  const attention = await pool.query(
    `SELECT collection_id, due_at, attempt, last_reason FROM premiums_to_collect
     WHERE status = 'needs_attention' ORDER BY due_at, collection_id`);
  const at = (d) => d.toISOString();
  return {
    runsNotStarted: runs.rows.map((r) => ({ id: r.period, dueAt: at(r.due_at), overdue: r.overdue })),
    premiumsNotCollected: premiums.rows.map((r) => ({ id: r.collection_id, dueAt: at(r.due_at), overdue: r.overdue, status: r.status })),
    needsAttention: attention.rows.map((r) => ({ id: r.collection_id, dueAt: at(r.due_at), attempts: r.attempt, reason: r.last_reason })),
  };
}
