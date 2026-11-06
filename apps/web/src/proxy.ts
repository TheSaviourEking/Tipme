import { NextResponse, type NextRequest } from 'next/server';
import { previewServerKey } from '@tipme/domain';
import { createSinglePlaceRedirect } from '@/lib/business/single-place';
import { shortLinkTarget } from '@/lib/handle-redirect';
import { gateDecision, PREVIEW_COOKIE } from '@/lib/preview-gate';
import {
  launchDecision,
  legacyProfileTarget,
  parseProductionLaunchAt,
} from '@/lib/production-launch';

/**
 * Short links (/kemi → /@kemi; the example people are reserved, so they have none) are a real 308 before anything else. Then, on staging/preview only:
 * when PREVIEW_PASSWORD is set, every page needs the preview ticket. Without it the visitor is
 * sent to the password page (and back afterwards). A business page with one open place is a 307
 * to that place, once the gate has let the visitor through.
 */
const API_ORIGIN =
  process.env.API_INTERNAL_ORIGIN ??
  process.env.NEXT_PUBLIC_API_ORIGIN ??
  'http://localhost:4000';

/** `/b/<business>` with one open place: a real 307 to it (BusinessProfile board). */
const singlePlace = createSinglePlaceRedirect(async (slug) => {
  const password = process.env.PREVIEW_PASSWORD;
  const response = await fetch(
    `${API_ORIGIN}/v1/b/${encodeURIComponent(slug)}`,
    {
      redirect: 'manual',
      signal: AbortSignal.timeout(2000),
      ...(password
        ? { headers: { 'x-tipme-preview-key': previewServerKey(password) } }
        : {}),
    },
  );
  return {
    status: response.status,
    body: response.status === 200 ? await response.json() : null,
  };
});

async function businessRedirect(
  request: NextRequest,
): Promise<NextResponse | null> {
  const place = await singlePlace(
    request.nextUrl.pathname,
    request.nextUrl.searchParams,
  );
  return place ? NextResponse.redirect(new URL(place, request.url), 307) : null;
}

export async function proxy(request: NextRequest) {
  const launch = launchDecision({
    path: request.nextUrl.pathname,
    target: parseProductionLaunchAt(process.env.PRODUCTION_LAUNCH_AT),
    now: Date.now(),
  });
  if (launch === 'rewrite') {
    const response = NextResponse.rewrite(new URL('/coming-soon', request.url));
    response.headers.set('Cache-Control', 'private, no-store, max-age=0');
    response.headers.set('CDN-Cache-Control', 'no-store');
    response.headers.set('Vercel-CDN-Cache-Control', 'no-store');
    response.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
    return response;
  }
  if (launch === 'redirect-home')
    return NextResponse.redirect(new URL('/', request.url), 307);

  const legacyProfile = legacyProfileTarget(
    request.nextUrl.pathname,
    request.nextUrl.searchParams,
  );
  if (legacyProfile)
    return NextResponse.redirect(new URL(legacyProfile, request.url), 308);

  const short = shortLinkTarget(
    request.nextUrl.pathname,
    request.nextUrl.searchParams,
  );
  if (short) return NextResponse.redirect(new URL(short, request.url), 308);
  const password = process.env.PREVIEW_PASSWORD;
  if (!password)
    return (await businessRedirect(request)) ?? NextResponse.next();
  const { pathname, search } = request.nextUrl;
  const decision = gateDecision({
    path: pathname,
    ticket: request.cookies.get(PREVIEW_COOKIE)?.value,
    password,
  });
  if (decision !== 'login') {
    const response = (await businessRedirect(request)) ?? NextResponse.next();
    response.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
    return response;
  }
  const login = new URL('/preview-login', request.url);
  login.searchParams.set('next', `${pathname}${search}`);
  return NextResponse.redirect(login, 303);
}

export const config = {
  // Framework assets bypass Proxy; countdown assets and operational metadata are explicitly
  // exempted by launchDecision, while all user-facing routes are held until the launch instant.
  // The Sentry tunnel (next.config.ts) forwards error reports; it is not a page.
  matcher: ['/((?!_next/static|_next/image|sentry-tunnel).*)'],
};
