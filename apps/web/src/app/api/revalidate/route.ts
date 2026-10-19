import { timingSafeEqual } from 'node:crypto';
import { revalidateTag } from 'next/cache';
import { profileTag } from '@/lib/profiles-api';

/**
 * The API calls this when a recipient changes their page, so the cached public page refreshes
 * at once (`expire: 0`: the next visitor never sees the old version).
 */
export async function POST(request: Request): Promise<Response> {
  const expected = process.env.WEB_REVALIDATE_SECRET ?? '';
  const body = (await request.json().catch(() => null)) as {
    handle?: unknown;
    secret?: unknown;
  } | null;
  const secret = typeof body?.secret === 'string' ? body.secret : '';
  const authorised =
    expected.length >= 32 &&
    secret.length === expected.length &&
    timingSafeEqual(Buffer.from(secret), Buffer.from(expected));
  if (!authorised)
    return Response.json({ revalidated: false }, { status: 401 });
  if (
    typeof body?.handle !== 'string' ||
    !/^[a-z0-9_]{3,30}$/.test(body.handle)
  )
    return Response.json({ revalidated: false }, { status: 400 });
  revalidateTag(profileTag(body.handle), { expire: 0 });
  return Response.json({ revalidated: true });
}
