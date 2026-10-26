import { NextResponse, type NextRequest } from 'next/server';
import { shortLinkTarget } from '@/lib/handle-redirect';
import { gateDecision, PREVIEW_COOKIE } from '@/lib/preview-gate';
import {
  launchDecision,
  legacyProfileTarget,
  parseProductionLaunchAt,
} from '@/lib/production-launch';

/**
 * Short links (/ada → /@ada) are a real 308 before anything else. Then, on staging/preview only:
 * when PREVIEW_PASSWORD is set, every page needs the preview ticket. Without it the visitor is
 * sent to the password page (and back afterwards).
 */
export function proxy(request: NextRequest) {
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
  if (!password) return NextResponse.next();
  const { pathname, search } = request.nextUrl;
  const decision = gateDecision({
    path: pathname,
    ticket: request.cookies.get(PREVIEW_COOKIE)?.value,
    password,
  });
  if (decision !== 'login') {
    const response = NextResponse.next();
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
  matcher: ['/((?!_next/static|_next/image).*)'],
};
