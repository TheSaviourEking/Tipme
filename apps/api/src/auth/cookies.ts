import type { Request, Response } from 'express';
import type { ApiConfig } from '../config.js';

export const SESSION_COOKIE = 'tipme_session';

/** Reads one cookie from the request header (no cookie-parser dependency). */
export function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.cookie ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name)
      return part.slice(index + 1).trim();
  }
  return null;
}

/** `Secure` everywhere except plain-HTTP local development. */
const isLocalHttp = (config: ApiConfig) =>
  /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(config.WEB_ORIGIN);

export function setSessionCookie(
  response: Response,
  config: ApiConfig,
  token: string,
  expiresAt: Date,
): void {
  response.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: !isLocalHttp(config),
    expires: expiresAt,
  });
}

export function clearSessionCookie(
  response: Response,
  config: ApiConfig,
): void {
  response.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: !isLocalHttp(config),
  });
}

/** The admin grant (PR-009): only meaningful together with the session cookie it was opened on. */
export const OPS_COOKIE = 'tipme_ops';

export function setOpsCookie(
  response: Response,
  config: ApiConfig,
  token: string,
  expiresAt: Date,
): void {
  response.cookie(OPS_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: !isLocalHttp(config),
    expires: expiresAt,
  });
}

export function clearOpsCookie(response: Response, config: ApiConfig): void {
  response.clearCookie(OPS_COOKIE, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: !isLocalHttp(config),
  });
}
