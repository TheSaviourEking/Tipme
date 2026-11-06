/**
 * Per-tab hand-offs between the tip form and the status page (sessionStorage): whether the supporter
 * opted in to being remembered, and the receipt token once it has left the URL fragment.
 */
export const pendingTipKey = (tipId: string) => `tipme.pending.${tipId}`;
export const statusTokenKey = (tipId: string) => `tipme.token.${tipId}`;

// A business's slug (M7): anything else is not ours.
const BUSINESS_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

export function readPendingTip(
  storage: Pick<Storage, 'getItem'> | undefined,
  tipId: string,
): { optIn: boolean; handle: string | null; business: string | null } {
  const none = { optIn: false, handle: null, business: null };
  try {
    const parsed: unknown = JSON.parse(
      storage?.getItem(pendingTipKey(tipId)) ?? 'null',
    );
    if (typeof parsed !== 'object' || parsed === null) return none;
    const { optIn, handle, business } = parsed as Record<string, unknown>;
    return {
      optIn: optIn === true,
      handle: typeof handle === 'string' ? handle : null,
      // Where the tip was made (PR B4): remembered with it only when the supporter opted in.
      business:
        typeof business === 'string' && BUSINESS_SLUG.test(business)
          ? business
          : null,
    };
  } catch {
    return none;
  }
}
