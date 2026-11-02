import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export type Database = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface DatabaseHandle {
  db: Database;
  pool: pg.Pool;
  connectGate: ConnectGate;
  close(): Promise<void>;
}

/** Told when the server refuses a connection for being full. */
export interface ConnectGate {
  onRefused?: (() => void) | undefined;
}

const FIRST_BACKOFF_MS = 500;
const LONGEST_BACKOFF_MS = 8000;
const CLOSE_DEADLINE_MS = 3000;

/**
 * A client class that stops knocking on a full server: after SQLSTATE 53300, new connections fail at
 * once with the same code for a growing moment, without leaving this process. Connections already
 * open keep working, and everything failed here failed before any work began.
 */
function backingOffClient(gate: ConnectGate): typeof pg.Client {
  type Connect = (
    this: pg.Client,
    done: (error?: Error | null) => void,
  ) => void;
  let backoff = 0;
  let closedUntil = 0;
  class BackingOffClient extends pg.Client {}
  // The pool always passes a callback; pg's overloads leave no way to write that as an override.
  (BackingOffClient.prototype as unknown as { connect: Connect }).connect =
    function (done) {
      if (Date.now() < closedUntil) {
        process.nextTick(
          done,
          Object.assign(new Error('Backing off a full server'), {
            code: '53300',
          }),
        );
        return;
      }
      (pg.Client.prototype.connect as unknown as Connect).call(
        this,
        (error) => {
          if (
            (error as { code?: string } | null | undefined)?.code === '53300'
          ) {
            backoff = Math.min(
              backoff * 2 || FIRST_BACKOFF_MS,
              LONGEST_BACKOFF_MS,
            );
            closedUntil = Date.now() + backoff;
            gate.onRefused?.();
          } else if (!error) backoff = 0;
          done(error);
        },
      );
    };
  return BackingOffClient;
}

/**
 * pool.end() waits for every client's goodbye, and a client whose server went away may never say it
 * (seen across a Postgres restart). Shutting down must not hang on that: the process is leaving.
 */
function closeWithin(pool: pg.Pool): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    pool.end(),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, CLOSE_DEADLINE_MS);
      timer.unref();
    }),
  ]).finally(() => clearTimeout(timer));
}

export function createDatabase(
  url: string,
  options: {
    /** Connections this process may open. Counts against the server's limit (remote-database.md). */
    max?: number;
    /** Longest wait for a connection, whether the pool is busy or the server is slow to answer. */
    connectionTimeoutMillis?: number;
  } = {},
): DatabaseHandle {
  const connectGate: ConnectGate = {};
  const pool = new pg.Pool({
    connectionString: url,
    max: options.max ?? 2,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 5000,
    Client: backingOffClient(connectGate),
  });
  // Idle-client errors surface through queries and readiness, not by crashing the process.
  pool.on('error', () => undefined);
  // The pool stops listening while a client is checked out, so a connection lost between two
  // statements of a transaction would otherwise crash the process. The next statement still fails,
  // and the transaction rolls back on the server.
  pool.on('connect', (client) => client.on('error', () => undefined));
  return {
    db: drizzle(pool, { schema }),
    pool,
    connectGate,
    close: () => closeWithin(pool),
  };
}
