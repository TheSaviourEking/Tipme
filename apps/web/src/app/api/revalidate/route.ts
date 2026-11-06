import { timingSafeEqual } from 'node:crypto';
import { revalidateTag } from 'next/cache';
import { businessTag } from '@/lib/business/public-api';
import { profileTag } from '@/lib/profiles-api';

/**
 * The API calls this when a recipient changes their page, so the cached public page refreshes
 * at once (`expire: 0`: the next visitor never sees the old version). `{ business }` (a slug)
 * refreshes every `/b/<business>/...` page instead (PR B4).
 */
export async function POST(request: Request): Promise<Response> {
  const expected = process.env.WEB_REVALIDATE_SECRET ?? '';
  const body = (await request.json().catch(() => null)) as {
    handle?: unknown;
    business?: unknown;
    secret?: unknown;
  } | null;
  const secret = typeof body?.secret === 'string' ? body.secret : '';
  const authorised =
    expected.length >= 32 &&
    secret.length === expected.length &&
    timingSafeEqual(Buffer.from(secret), Buffer.from(expected));
  if (!authorised)
    return Response.json({ revalidated: false }, { status: 401 });
  if (typeof body?.business === 'string' && body.handle === undefined) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(body.business))
      return Response.json({ revalidated: false }, { status: 400 });
    revalidateTag(businessTag(body.business), { expire: 0 });
    return Response.json({ revalidated: true });
  }
  if (
    typeof body?.handle !== 'string' ||
    !/^[a-z0-9_]{3,30}$/.test(body.handle)
  )
    return Response.json({ revalidated: false }, { status: 400 });
  revalidateTag(profileTag(body.handle), { expire: 0 });
  return Response.json({ revalidated: true });
}
