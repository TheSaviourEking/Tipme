/**
 * Tells the web app a public page changed, as the API's ProfileRevalidator does (the same POST and
 * secret). The worker needs it when the take-back sweep moves a page to a new username. With no
 * secret set it does nothing: cached pages then refresh within 5 minutes on their own (the spec's
 * accepted fallback). Best effort: a failure is logged, never thrown.
 */
export function workerRevalidator(
  config: {
    WEB_ORIGIN: string;
    WEB_REVALIDATE_URL?: string | undefined;
    WEB_REVALIDATE_SECRET?: string | undefined;
  },
  deps: {
    fetchImpl?: typeof fetch;
    log?: (entry: { event: string; status: number }) => void;
  } = {},
): ((handle: string) => Promise<void>) | null {
  const secret = config.WEB_REVALIDATE_SECRET;
  if (!secret) return null;
  const url =
    config.WEB_REVALIDATE_URL ??
    `${new URL(config.WEB_ORIGIN).origin}/api/revalidate`;
  const send = deps.fetchImpl ?? fetch;
  return async (handle) => {
    if (!handle) return;
    const status = await send(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ handle, secret }),
      signal: AbortSignal.timeout(2000),
    }).then(
      (response) => (response.ok ? 0 : response.status),
      () => -1,
    );
    if (status !== 0)
      deps.log?.({
        event: 'profile.revalidate_failed',
        status: Math.max(0, status),
      });
  };
}
