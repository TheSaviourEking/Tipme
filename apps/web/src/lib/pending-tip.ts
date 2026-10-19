/**
 * Per-tab hand-offs between the tip form and the status page (sessionStorage): whether the supporter
 * opted in to being remembered, and the receipt token once it has left the URL fragment.
 */
export const pendingTipKey = (tipId: string) => `tipme.pending.${tipId}`;
export const statusTokenKey = (tipId: string) => `tipme.token.${tipId}`;

export function readPendingTip(
  storage: Pick<Storage, 'getItem'> | undefined,
  tipId: string,
): { optIn: boolean; handle: string | null } {
  try {
    const parsed: unknown = JSON.parse(
      storage?.getItem(pendingTipKey(tipId)) ?? 'null',
    );
    if (typeof parsed !== 'object' || parsed === null)
      return { optIn: false, handle: null };
    const { optIn, handle } = parsed as Record<string, unknown>;
    return {
      optIn: optIn === true,
      handle: typeof handle === 'string' ? handle : null,
    };
  } catch {
    return { optIn: false, handle: null };
  }
}
