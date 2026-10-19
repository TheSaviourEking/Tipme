import type { z } from 'zod';

/** Startup configuration failure. The message names variables only, because values may be credentials. */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

export function parseConfig<S extends z.ZodType>(
  schema: S,
  env: Record<string, string | undefined>,
): z.infer<S> {
  const result = schema.safeParse(env);
  if (result.success) return result.data;
  const names = new Set(
    result.error.issues.map((issue) =>
      String(issue.path[0] ?? 'configuration'),
    ),
  );
  throw new ConfigError(
    `Invalid configuration: ${[...names].sort().join(', ')}`,
  );
}
