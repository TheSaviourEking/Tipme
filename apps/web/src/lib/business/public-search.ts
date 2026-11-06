import type { BusinessPersonMatch } from '@tipme/contracts';

/** The TipMe API, called from the browser (CORS allows only this web app's origin). */
const API_ORIGIN =
  process.env.NEXT_PUBLIC_API_ORIGIN ?? 'http://localhost:4000';

export type PeopleSearch =
  | { ok: true; people: BusinessPersonMatch[] }
  | { ok: false; reason: 'network' | 'rate_limited' | 'failed' };

/** "I don't see them" (PR B4): people anywhere at the business whose name starts with `q`. */
export async function searchPeople(
  business: string,
  q: string,
): Promise<PeopleSearch> {
  let response: Response;
  try {
    response = await fetch(
      `${API_ORIGIN}/v1/b/${encodeURIComponent(business)}/people?q=${encodeURIComponent(q)}`,
      {
        cache: 'no-store',
        // Staging/preview: every call carries the preview cookie (PR-010).
        credentials:
          process.env.NEXT_PUBLIC_PREVIEW_GATE === 'on' ? 'include' : 'omit',
      },
    );
  } catch {
    return { ok: false, reason: 'network' };
  }
  if (response.status === 429) return { ok: false, reason: 'rate_limited' };
  const body = (await response.json().catch(() => null)) as {
    data?: unknown;
  } | null;
  if (!response.ok || !Array.isArray(body?.data))
    return { ok: false, reason: 'failed' };
  return { ok: true, people: body.data as BusinessPersonMatch[] };
}
