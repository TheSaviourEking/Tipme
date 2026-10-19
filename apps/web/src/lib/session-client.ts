'use client';

/** Calls the API as the signed-in recipient: the session cookie travels, never readable here. */
const API_ORIGIN =
  process.env.NEXT_PUBLIC_API_ORIGIN ?? 'http://localhost:4000';

export type SessionResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; code: string; fields?: string[] };

export async function apiFetch<T>(
  path: string,
  init: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): Promise<SessionResult<T>> {
  const method = init.method ?? 'GET';
  let response: Response;
  try {
    response = await fetch(`${API_ORIGIN}${path}`, {
      method,
      credentials: 'include',
      cache: 'no-store',
      headers: {
        ...(method === 'GET'
          ? {}
          : { 'content-type': 'application/json', 'x-tipme-csrf': '1' }),
        ...init.headers,
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  } catch {
    return { ok: false, status: 0, code: 'NETWORK' };
  }
  if (response.status === 204)
    return { ok: true, status: 204, data: undefined as T };
  const body = (await response.json().catch(() => null)) as {
    data?: T;
    error?: { code?: string; fields?: string[] };
  } | null;
  if (response.ok && body && 'data' in body)
    return { ok: true, status: response.status, data: body.data as T };
  return {
    ok: false,
    status: response.status,
    code: body?.error?.code ?? 'INTERNAL_ERROR',
    ...(body?.error?.fields ? { fields: body.error.fields } : {}),
  };
}

/** A short, human label for the devices list ("Chrome on Android"). */
export function deviceLabel(): string {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'Browser';
  const os = /Android/.test(ua)
    ? 'Android'
    : /iPhone|iPad/.test(ua)
      ? 'iOS'
      : /Mac OS X/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Linux/.test(ua)
            ? 'Linux'
            : 'a device';
  return `${browser} on ${os}`;
}
