import { NextResponse, type NextRequest } from 'next/server';
import { shortLinkTarget } from '@/lib/handle-redirect';
import { gateDecision, PREVIEW_COOKIE } from '@/lib/preview-gate';

/**
 * Short links (/ada → /@ada) are a real 308 before anything else. Then, on staging/preview only:
 * when PREVIEW_PASSWORD is set, every page needs the preview ticket. Without it the visitor is
 * sent to the password page (and back afterwards).
 */
export function proxy(request: NextRequest) {
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
  // Static build files load without the ticket (they hold no data); everything else is gated.
  matcher: ['/((?!_next/static|_next/image).*)'],
};
