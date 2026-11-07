import { cacheLife, cacheTag } from 'next/cache';
import type {
  PublicBusiness,
  PublicLocation,
  PublicStaffTipPage,
  StaffPageRedirect,
} from '@tipme/contracts';
import { previewServerKey } from '@tipme/domain';
import { API_ORIGIN } from '@/lib/profiles-api';
// B2's tag: the API's revalidate call after a verify, suspend, restore or shift change expires
// every page of the business at once (merge train 2).
import { businessTag } from './business-tag';

// PR B4: what a location code and a staff code open, read on the web server and cached like a
// person's page. A 404 (unknown, waiting to be verified, paused, closed, or the business feature
// switched off) is cached as "not taking tips"; a failure to reach the API is thrown, never cached.

const LOOKUP_TIMEOUT_MS = 4000;
const SLUG = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export const isBusinessSlug = (raw: string, max: number) =>
  raw.length <= max && SLUG.test(raw.toLowerCase());

async function read<T>(path: string): Promise<T | null> {
  const password = process.env.PREVIEW_PASSWORD;
  const response = await fetch(`${API_ORIGIN}${path}`, {
    redirect: 'manual',
    signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    // Staging/preview: the web server proves itself to the API's gate with the server key.
    ...(password
      ? { headers: { 'x-tipme-preview-key': previewServerKey(password) } }
      : {}),
  });
  if (response.status === 404) return null;
  if (!response.ok)
    throw new Error(`business lookup failed: ${response.status}`);
  return ((await response.json()) as { data: T }).data;
}

export async function getPublicLocation(
  business: string,
  location: string,
): Promise<PublicLocation | null> {
  'use cache';
  // Who is on shift changes through the day: no list is older than about half a minute.
  cacheLife({ stale: 30, revalidate: 30, expire: 300 });
  cacheTag(businessTag(business));
  if (!isBusinessSlug(business, 40) || !isBusinessSlug(location, 30))
    return null;
  return read<PublicLocation>(
    `/v1/b/${encodeURIComponent(business.toLowerCase())}/${encodeURIComponent(location.toLowerCase())}`,
  );
}

/** The business page (`/b/<business>`): its open locations, no people (BusinessProfile board). */
export async function getPublicBusiness(
  business: string,
): Promise<PublicBusiness | null> {
  'use cache';
  // Only names and addresses: refreshed by the business's own tag when staff or managers change it.
  cacheLife({ stale: 30, revalidate: 30, expire: 300 });
  cacheTag(businessTag(business));
  if (!isBusinessSlug(business, 40)) return null;
  return read<PublicBusiness>(
    `/v1/b/${encodeURIComponent(business.toLowerCase())}`,
  );
}

export async function getStaffTipPage(
  business: string,
  location: string,
  handle: string,
): Promise<PublicStaffTipPage | StaffPageRedirect | null> {
  'use cache';
  cacheLife({ stale: 30, revalidate: 30, expire: 300 });
  cacheTag(businessTag(business));
  cacheTag(`profile:${handle.toLowerCase()}`);
  if (
    !isBusinessSlug(business, 40) ||
    !isBusinessSlug(location, 30) ||
    !/^@?[A-Za-z0-9_]{3,30}$/.test(handle)
  )
    return null;
  const page = await read<PublicStaffTipPage | StaffPageRedirect>(
    `/v1/b/${encodeURIComponent(business.toLowerCase())}/${encodeURIComponent(location.toLowerCase())}/${encodeURIComponent(handle.replace(/^@/, ''))}`,
  );
  // Only ever a person's own page.
  if (page && 'redirectTo' in page)
    return /^\/@[a-z0-9_]{3,30}$/i.test(page.redirectTo) ? page : null;
  return page;
}

/** For the pages: a failed lookup is a value they can render (see loadPublicProfile). */
export async function loadPublicLocation(
  business: string,
  location: string,
): Promise<PublicLocation | null | 'unreachable'> {
  try {
    return await getPublicLocation(business, location);
  } catch (error) {
    console.error('business lookup failed', error);
    return 'unreachable';
  }
}

export async function loadPublicBusiness(
  business: string,
): Promise<PublicBusiness | null | 'unreachable'> {
  try {
    return await getPublicBusiness(business);
  } catch (error) {
    console.error('business lookup failed', error);
    return 'unreachable';
  }
}

export async function loadStaffTipPage(
  business: string,
  location: string,
  handle: string,
): Promise<PublicStaffTipPage | StaffPageRedirect | null | 'unreachable'> {
  try {
    return await getStaffTipPage(business, location, handle);
  } catch (error) {
    console.error('business lookup failed', error);
    return 'unreachable';
  }
}

/** `?src=qr` passes through, as on a person's page; nothing else does. */
export function withQrSource(
  path: string,
  searchParams: Record<string, string | string[] | undefined>,
): string {
  return searchParams['src'] === 'qr' ? `${path}?src=qr` : path;
}
