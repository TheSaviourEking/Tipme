import type {
  ProfileReportReason,
  PublicProPrice,
  TipIntentCreated,
  TipQuote,
  TipStatusView,
} from '@tipme/contracts';

/** The TipMe API, called from the browser (CORS allows only this web app's origin). */
const API_ORIGIN =
  process.env.NEXT_PUBLIC_API_ORIGIN ?? 'http://localhost:4000';

/** `NETWORK` means the API could not be reached; the request can be retried as is. */
export type ApiFailure = { ok: false; status: number; code: string };
export type ApiResult<T> = { ok: true; data: T } | ApiFailure;

async function call<T>(path: string, init: RequestInit): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(`${API_ORIGIN}${path}`, {
      ...init,
      // Statuses and prices are always fresh; nothing here may be cached.
      cache: 'no-store',
      // Staging/preview: every call carries the preview cookie (PR-010).
      credentials:
        process.env.NEXT_PUBLIC_PREVIEW_GATE === 'on'
          ? 'include'
          : API_ORIGIN === ''
            ? 'same-origin'
            : 'omit',
    });
  } catch {
    return { ok: false, status: 0, code: 'NETWORK' };
  }
  const body = (await response.json().catch(() => null)) as {
    data?: T;
    error?: { code?: string };
  } | null;
  if (response.ok && body && 'data' in body)
    return { ok: true, data: body.data as T };
  return {
    ok: false,
    status: response.status,
    code: body?.error?.code ?? 'INTERNAL_ERROR',
  };
}

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

export const quoteTip = (handle: string, amountMinor: number) =>
  call<TipQuote>(
    '/v1/tip-quotes',
    json({ handle, amountMinor: String(amountMinor), currency: 'NGN' }),
  );

/** One idempotency key per draft: a retry or double tap with it can never create a second tip. */
export const createTip = (
  idempotencyKey: string,
  body: { quoteId: string; message?: string },
) =>
  call<TipIntentCreated>(
    '/v1/tip-intents',
    json(body, { 'idempotency-key': idempotencyKey }),
  );

/** The receipt token travels only in this header, never in a URL the server sees. */
export const tipStatus = (tipId: string, token: string) =>
  call<TipStatusView>(`/v1/tips/${encodeURIComponent(tipId)}/status`, {
    headers: { authorization: `Bearer ${token}` },
  });

/**
 * "Stop {name} recognising me", with the receipt's token. 204 whether or not anything was left to
 * stop; a wrong token is 404, like the receipt itself.
 */
export async function stopRecognition(
  tipId: string,
  token: string,
): Promise<{ ok: true } | ApiFailure> {
  let response: Response;
  try {
    response = await fetch(
      `${API_ORIGIN}/v1/tips/${encodeURIComponent(tipId)}/recognition/stop`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        cache: 'no-store',
        credentials:
          process.env.NEXT_PUBLIC_PREVIEW_GATE === 'on'
            ? 'include'
            : API_ORIGIN === ''
              ? 'same-origin'
              : 'omit',
      },
    );
  } catch {
    return { ok: false, status: 0, code: 'NETWORK' };
  }
  if (response.status === 204) return { ok: true };
  const body = (await response.json().catch(() => null)) as {
    error?: { code?: string };
  } | null;
  return {
    ok: false,
    status: response.status,
    code: body?.error?.code ?? 'INTERNAL_ERROR',
  };
}

export const mockCheckoutSummary = (reference: string) =>
  call<{ amountMinor: string; currency: string; recipientDisplayName: string }>(
    `/v1/mock-provider/checkout/${encodeURIComponent(reference)}`,
    {},
  );

export const mockCheckoutPay = (
  reference: string,
  outcome: string,
  method?: 'card' | 'bank_transfer',
) =>
  call<{ returnUrl: string }>(
    `/v1/mock-provider/checkout/${encodeURIComponent(reference)}`,
    json(method ? { outcome, method } : { outcome }),
  );

/** Paid Pro: the price staff set, and whether buying is open on this copy. 404: no price yet. */
export const proPrice = () => call<PublicProPrice>('/v1/pro/price', {});

/** Reporting a page (PR-013): a reason from the list only. The API answers the same either way. */
export const reportPage = (handle: string, reason: ProfileReportReason) =>
  call<{ accepted: true }>(
    `/v1/profiles/${encodeURIComponent(handle)}/report`,
    json({ reason }),
  );
