import pg from 'pg';
import { PostgresEventStore } from 'es-dcb-library';

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
export const store = new PostgresEventStore({ pool });
await store.initializeSchema(); // creates the events table if missing
