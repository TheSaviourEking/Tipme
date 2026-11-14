// Business sign-up, Task D6: the hats one login wears (its page, businesses, work), for the
// account-menu switcher. Pure: unit tests load it.
import type {
  BusinessStatus,
  MyAccount,
  MyBusinessRoles,
} from '@tipme/contracts';

export type Hat =
  | { kind: 'page'; handle: string }
  | {
      kind: 'owner' | 'manager';
      businessId: string;
      name: string;
      status: BusinessStatus;
      /** Business Pro's plan, once the API sends one (Phase A). */
      plan?: 'free' | 'pro';
    }
  | {
      kind: 'work';
      memberId: string;
      businessName: string;
      locationName: string;
    };

/**
 * YOU (the page), then BUSINESSES YOU OWN, then the ones you manage, then WHERE I WORK. Each only
 * when the login has it; with businesses off (`roles` null) only the page.
 */
export function hatsOf(
  account: MyAccount,
  roles: MyBusinessRoles | null,
): Hat[] {
  const hats: Hat[] = [];
  if (account.handle) hats.push({ kind: 'page', handle: account.handle });
  const manages = roles?.manages ?? [];
  for (const kind of ['owner', 'manager'] as const)
    for (const entry of manages) {
      if ((entry.role === 'owner') !== (kind === 'owner')) continue;
      const plan = (entry as { plan?: unknown }).plan;
      hats.push({
        kind,
        businessId: entry.businessId,
        name: entry.name,
        status: entry.status,
        ...(plan === 'free' || plan === 'pro' ? { plan } : {}),
      });
    }
  for (const work of roles?.works ?? [])
    hats.push({
      kind: 'work',
      memberId: work.memberId,
      businessName: work.businessName,
      locationName: work.locationName,
    });
  return hats;
}

export function hatHref(hat: Hat): string {
  if (hat.kind === 'page') return '/dashboard';
  if (hat.kind === 'work') return '/dashboard/work';
  return `/dashboard/business?business=${encodeURIComponent(hat.businessId)}`;
}

/**
 * The hat the address shows. Business pages: the business in `?business=`, else the first one
 * (as the Business page opens it). Work: the first job. Settings, help and What's new belong to
 * the login and say nothing (null); any other dashboard page is the page's own.
 */
export function currentHat(
  hats: Hat[],
  pathname: string,
  search: string,
): Hat | null {
  const under = (base: string) =>
    pathname === base || pathname.startsWith(`${base}/`);
  if (under('/dashboard/business')) {
    const asked = new URLSearchParams(search).get('business');
    const businesses = hats.filter(
      (hat) => hat.kind === 'owner' || hat.kind === 'manager',
    );
    return (
      businesses.find(
        (hat) => 'businessId' in hat && hat.businessId === asked,
      ) ??
      businesses[0] ??
      null
    );
  }
  if (under('/dashboard/work'))
    return hats.find((hat) => hat.kind === 'work') ?? null;
  if (
    ['/dashboard/settings', '/dashboard/help', '/dashboard/whats-new'].some(
      under,
    )
  )
    return null;
  return hats.find((hat) => hat.kind === 'page') ?? null;
}

/** The words a hat goes by on the button and in the menu. */
export function hatLabel(hat: Hat): string {
  if (hat.kind === 'page') return 'My page';
  if (hat.kind === 'work') return hat.businessName;
  return hat.name;
}
