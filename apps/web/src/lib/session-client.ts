'use client';

/** Calls the API as the signed-in recipient: the session cookie travels, never readable here. */
const API_ORIGIN =
  process.env.NEXT_PUBLIC_API_ORIGIN ?? 'http://localhost:4000';

/** A path on the API, for images the browser asks for with the session cookie. */
export const apiUrl = (path: string) => `${API_ORIGIN}${path}`;

export type SessionResult<T> =
  | { ok: true; status: number; data: T }
  | {
      ok: false;
      status: number;
      code: string;
      fields?: string[];
      /** A fixed reason code, on the few refusals that have one. */
      reason?: string;
      /** The API's fixed words for this code. */
      message?: string;
    };

export async function apiFetch<T>(
  path: string,
  init: {
    method?: string;
    body?: unknown;
    /** A file sent as it is (a photo upload, PR-013), with its own content type. */
    file?: Blob;
    headers?: Record<string, string>;
    /** Gives up after this long, as a network failure; the outcome of a write is then unknown. */
    timeoutMs?: number;
  } = {},
): Promise<SessionResult<T>> {
  const method = init.method ?? 'GET';
  const abort = init.timeoutMs ? new AbortController() : undefined;
  if (abort) setTimeout(() => abort.abort(), init.timeoutMs);
  let response: Response;
  try {
    response = await fetch(`${API_ORIGIN}${path}`, {
      method,
      ...(abort ? { signal: abort.signal } : {}),
      credentials: 'include',
      cache: 'no-store',
      headers: {
        ...(method === 'GET'
          ? {}
          : {
              'content-type': init.file?.type || 'application/json',
              'x-tipme-csrf': '1',
            }),
        ...init.headers,
      },
      ...(init.file
        ? { body: init.file }
        : init.body === undefined
          ? {}
          : { body: JSON.stringify(init.body) }),
    });
  } catch {
    return { ok: false, status: 0, code: 'NETWORK' };
  }
  if (response.status === 204)
    return { ok: true, status: 204, data: undefined as T };
  const body = (await response.json().catch(() => null)) as {
    data?: T;
    error?: {
      code?: string;
      fields?: string[];
      reason?: string;
      message?: string;
    };
  } | null;
  if (response.ok && body && 'data' in body)
    return { ok: true, status: response.status, data: body.data as T };
  return {
    ok: false,
    status: response.status,
    code: body?.error?.code ?? 'INTERNAL_ERROR',
    ...(body?.error?.fields ? { fields: body.error.fields } : {}),
    ...(body?.error?.reason ? { reason: body.error.reason } : {}),
    ...(body?.error?.message ? { message: body.error.message } : {}),
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

/** Downloads a file the signed-in recipient owns (the session cookie travels, as above). */
export async function apiDownload(
  path: string,
  filename: string,
): Promise<{ ok: boolean }> {
  let response: Response;
  try {
    response = await fetch(`${API_ORIGIN}${path}`, {
      credentials: 'include',
      cache: 'no-store',
    });
  } catch {
    return { ok: false };
  }
  if (!response.ok) return { ok: false };
  const link = document.createElement('a');
  link.href = URL.createObjectURL(await response.blob());
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  return { ok: true };
}
