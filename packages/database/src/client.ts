import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export type Database = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface DatabaseHandle {
  db: Database;
  pool: pg.Pool;
  close(): Promise<void>;
}

export function createDatabase(
  url: string,
  options: { max?: number } = {},
): DatabaseHandle {
  const pool = new pg.Pool({
    connectionString: url,
    max: options.max ?? 10,
    connectionTimeoutMillis: 2000,
  });
  // Idle-client errors surface through queries and readiness, not by crashing the process.
  pool.on('error', () => undefined);
  return { db: drizzle(pool, { schema }), pool, close: () => pool.end() };
}
