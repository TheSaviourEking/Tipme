import { AsyncLocalStorage } from 'node:async_hooks';
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

// A dead peer is noticed from here, with the sysctls in compose.production.yml.
const KEEPALIVE_DELAY_MS = 10_000;
// Frees the server's slot when a client vanishes mid-transaction. Transactions wait only on the
// database and Redis, never a provider, and a serious action's run gives up at 15 s, so a healthy one
// is never idle this long. Only idle time counts: a long statement or a lock wait is not affected.
const IDLE_IN_TRANSACTION_MS = 60_000;

interface TransactionScope {
  pool: pg.Pool;
  client?: pg.PoolClient;
  released?: boolean;
}
const transactionScope = new AsyncLocalStorage<TransactionScope>();

/** The size now of the pool the current transaction came from; null outside createDatabase's. */
export const currentPoolMax = (): number | null =>
  transactionScope.getStore()?.pool.options.max ?? null;

// Connection errors from pg, marked as they pass so only these count as the database's network
// failures (errors.ts): a fetch failing the same way elsewhere is somebody else's.
export const connectionErrors = new WeakSet<object>();

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
          else connectionErrors.add(error);
          done(error);
        },
      );
    };
  return BackingOffClient;
}

/** Remembers the client each transaction took, and whether it went back. */
function noteTransactionClients(pool: pg.Pool): void {
  const connect = pool.connect.bind(pool) as (...args: unknown[]) => unknown;
  (pool as { connect: unknown }).connect = (...args: unknown[]) => {
    const scope = transactionScope.getStore();
    const result = connect(...args);
    if (!scope || scope.client || args.length > 0) return result;
    return (result as Promise<pg.PoolClient>).then((client) => {
      scope.client = client;
      const release = client.release.bind(client);
      client.release = (destroy?: boolean | Error) => {
        scope.released = true;
        return release(destroy);
      };
      return client;
    });
  };
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
    /** Migrations only: give up on a table lock, so statements don't queue behind the wait. */
    lockTimeoutMillis?: number;
    idleInTransactionMillis?: number;
  } = {},
): DatabaseHandle {
  const connectGate: ConnectGate = {};
  const pool = new pg.Pool({
    connectionString: url,
    max: options.max ?? 2,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 5000,
    Client: backingOffClient(connectGate),
    keepAlive: true,
    keepAliveInitialDelayMillis: KEEPALIVE_DELAY_MS,
    idle_in_transaction_session_timeout:
      options.idleInTransactionMillis ?? IDLE_IN_TRANSACTION_MS,
    ...(options.lockTimeoutMillis
      ? { lock_timeout: options.lockTimeoutMillis }
      : {}),
  });
  // Idle-client errors surface through queries and readiness, not by crashing the process.
  pool.on('error', () => undefined);
  // The pool stops listening while a client is checked out, so a connection lost between two
  // statements of a transaction would otherwise crash the process. The next statement still fails,
  // and the transaction rolls back on the server.
  pool.on('connect', (client) => client.on('error', () => undefined));
  const db = drizzle(pool, { schema });
  noteTransactionClients(pool);
  const transaction = db.transaction.bind(db);
  db.transaction = ((...args: Parameters<typeof transaction>) => {
    const scope: TransactionScope = { pool };
    return transactionScope
      .run(scope, () => transaction(...args))
      .finally(() => {
        // Drizzle 0.45 runs BEGIN before its try, so a BEGIN that fails never releases the client.
        // At a pool of one, that would be the copy's only connection, gone for good.
        if (scope.client && !scope.released) scope.client.release(true);
      });
  }) as typeof transaction;
  return {
    db,
    pool,
    connectGate,
    close: () => closeWithin(pool),
  };
}
