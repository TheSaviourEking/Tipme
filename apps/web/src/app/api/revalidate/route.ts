import { timingSafeEqual } from 'node:crypto';
import { revalidateTag } from 'next/cache';
import { businessTag } from '@/lib/business/business-tag';
import { profileTag } from '@/lib/profiles-api';

// A business slug (M7), as the database checks it.
const BUSINESS_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

/**
 * The API calls this when a recipient changes their page, so the cached public page refreshes
 * at once (`expire: 0`: the next visitor never sees the old version).
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
  // TipMe for businesses (PR B2): a business verified, suspended or restored by staff.
  if (typeof body?.business === 'string') {
    if (!BUSINESS_SLUG.test(body.business))
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
