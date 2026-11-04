import { ProjectionManager } from 'es-dcb-library/projections';
import { store, pool } from './store.js';

export { store, pool };
export const given = (...events) => store.append(events);

// Catches the projections up on every committed event, then stops them.
export async function runProjections(...projections) {
  const manager = new ProjectionManager({ pool, store, projections });
  await manager.initialize(); // creates the tables and checkpoint rows if missing
  manager.start();
  await manager.waitUntilLive();
  await manager.stop();
}

// Empty event store, read model tables and checkpoints before each scenario.
export async function reset(projections, tables) {
  await runProjections(...projections);
  await pool.query(`TRUNCATE events, ${tables.join(', ')}`);
  await pool.query('UPDATE projection_checkpoints SET last_tx_id = NULL, last_position = NULL WHERE name = ANY($1)', [
    projections.map((p) => p.name),
  ]);
}

export const events = (types) =>
  pool.query('SELECT type, data FROM events WHERE type = ANY($1) ORDER BY global_position', [types])
    .then((r) => r.rows.map((row) => ({ type: row.type, ...row.data })));
