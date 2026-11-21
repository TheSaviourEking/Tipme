/**
 * The short code a Redis error reply starts with (OOM, MISCONF, NOSCRIPT, READONLY, LOADING...),
 * or 'unknown'. Only that word is ever returned: the rest of a reply can name keys.
 */
export function redisErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown';
  const match = /^([A-Z]{2,20})(?:\s|$)/.exec(error.message);
  return match?.[1] ?? 'unknown';
}

/**
 * Logs at most one line per key per window. The next line that does get through carries
 * `suppressed`: how many were held back since the last one. A failing Redis makes BullMQ raise
 * the same error thousands of times a second; unbounded, that filled a disk (21 Nov 2026).
 */
export function createRateLimitedWarn(options: {
  warn(fields: object): void;
  windowMs?: number;
  now?: () => number;
}): (key: string, fields: Record<string, unknown>) => void {
  const { warn, windowMs = 10_000, now = Date.now } = options;
  const windows = new Map<string, { loggedAt: number; suppressed: number }>();
  return (key, fields) => {
    const at = now();
    const window = windows.get(key);
    if (window && at - window.loggedAt < windowMs) {
      window.suppressed += 1;
      return;
    }
    warn({ ...fields, suppressed: window?.suppressed ?? 0 });
    windows.set(key, { loggedAt: at, suppressed: 0 });
  };
}

/** The BullMQ worker's `error` handler: the error's name and Redis code, rate-limited per code. */
export function workerErrorLogger(options: {
  logger: { warn(fields: object): void };
  now?: () => number;
}): (error: Error) => void {
  const warn = createRateLimitedWarn({
    warn: (fields) => options.logger.warn(fields),
    ...(options.now ? { now: options.now } : {}),
  });
  return (error) => {
    const code = redisErrorCode(error);
    warn(code, { event: 'worker.error', error: error.name, code });
  };
}
