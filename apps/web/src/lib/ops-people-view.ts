// The People screen's state, all of it in the address (owner's ask, 14 Nov 2026): a copied link
// opens the same view and Back works. Pure, and imports nothing, so it can be tested alone. The
// names match the API's query (GET /v1/ops/users), so the same string serves both.

const PER_PAGE = [25, 50, 100] as const;
const SORTS = ['newest', 'oldest', 'name', 'most_tips'] as const;
const PLANS = ['free', 'pro'] as const;
const PAGE_STATUSES = ['live', 'offline', 'suspended', 'none'] as const;
const PAYOUTS = ['set_up', 'not_set_up'] as const;

export type PeopleSort = (typeof SORTS)[number];
export type PeoplePlan = (typeof PLANS)[number];
export type PeoplePageStatus = (typeof PAGE_STATUSES)[number];
export type PeoplePayouts = (typeof PAYOUTS)[number];
export type PerPage = (typeof PER_PAGE)[number];

export interface PeopleQuery {
  page: number;
  perPage: PerPage;
  q: string;
  plan: PeoplePlan | null;
  pageStatus: PeoplePageStatus | null;
  payouts: PeoplePayouts | null;
  joinedFrom: string;
  joinedTo: string;
  sort: PeopleSort;
}

export const PEOPLE_DEFAULTS: PeopleQuery = {
  page: 1,
  perPage: 25,
  q: '',
  plan: null,
  pageStatus: null,
  payouts: null,
  joinedFrom: '',
  joinedTo: '',
  sort: 'newest',
};

/** Words for each choice, on the controls and the filter chips. */
export const SORT_WORDS: Record<PeopleSort, string> = {
  newest: 'Newest first',
  oldest: 'Oldest first',
  name: 'Name A–Z',
  most_tips: 'Most tips received',
};
export const PLAN_WORDS: Record<PeoplePlan, string> = {
  free: 'Free',
  pro: 'Pro',
};
export const PAGE_STATUS_WORDS: Record<PeoplePageStatus, string> = {
  live: 'Live',
  offline: 'Offline',
  suspended: 'Suspended',
  none: 'No page yet',
};
export const PAYOUTS_WORDS: Record<PeoplePayouts, string> = {
  set_up: 'Set up',
  not_set_up: 'Not set up',
};

/** Where each person's List or Grid choice is kept, in this browser. */
export const PEOPLE_VIEW_KEY = 'tipme.ops-people-view';

const oneOf = <T extends string>(list: readonly T[], value: string | null) =>
  (list as readonly string[]).includes(value ?? '') ? (value as T) : null;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The view an address asks for; anything it can't read is the default, never an error. */
export function readPeopleQuery(
  params: URLSearchParams,
  options: { privateView?: boolean } = {},
): PeopleQuery {
  const page = Number(params.get('page'));
  const perPage = Number(params.get('perPage'));
  const sort = oneOf(SORTS, params.get('sort')) ?? 'newest';
  return {
    page: Number.isInteger(page) && page >= 1 ? page : 1,
    perPage: (PER_PAGE as readonly number[]).includes(perPage)
      ? (perPage as PerPage)
      : 25,
    q: (params.get('q') ?? '').slice(0, 100),
    plan: oneOf(PLANS, params.get('plan')),
    pageStatus: oneOf(PAGE_STATUSES, params.get('pageStatus')),
    payouts: oneOf(PAYOUTS, params.get('payouts')),
    joinedFrom: DAY.test(params.get('joinedFrom') ?? '')
      ? (params.get('joinedFrom') as string)
      : '',
    joinedTo: DAY.test(params.get('joinedTo') ?? '')
      ? (params.get('joinedTo') as string)
      : '',
    // Only private.view holders may sort by money; a link from one opens newest-first for others.
    sort:
      sort === 'most_tips' && options.privateView === false ? 'newest' : sort,
  };
}

/** The query string for a view, defaults left out, in a fixed order. */
export function peopleSearch(state: PeopleQuery): string {
  const params = new URLSearchParams();
  if (state.page !== 1) params.set('page', String(state.page));
  if (state.perPage !== 25) params.set('perPage', String(state.perPage));
  if (state.q.trim()) params.set('q', state.q.trim());
  if (state.plan) params.set('plan', state.plan);
  if (state.pageStatus) params.set('pageStatus', state.pageStatus);
  if (state.payouts) params.set('payouts', state.payouts);
  if (state.joinedFrom) params.set('joinedFrom', state.joinedFrom);
  if (state.joinedTo) params.set('joinedTo', state.joinedTo);
  if (state.sort !== 'newest') params.set('sort', state.sort);
  return params.toString();
}

/** A change to the view: any change but the page itself starts again from page 1. */
export function withChange(
  state: PeopleQuery,
  change: Partial<PeopleQuery>,
): PeopleQuery {
  const next = { ...state, ...change };
  return 'page' in change ? next : { ...next, page: 1 };
}

/** First, last, the current page and two either side; a gap of one page shows that page. */
export function pageNumbers(current: number, last: number): (number | 'gap')[] {
  const shown = new Set([1, last]);
  for (let n = current - 2; n <= current + 2; n += 1)
    if (n >= 1 && n <= last) shown.add(n);
  const sorted = [...shown].sort((a, b) => a - b);
  const out: (number | 'gap')[] = [];
  let previous = 0;
  for (const n of sorted) {
    if (n - previous === 2) out.push(n - 1);
    else if (n - previous > 2) out.push('gap');
    out.push(n);
    previous = n;
  }
  return out;
}

const count = new Intl.NumberFormat('en-GB');

export function showingWords(
  page: number,
  perPage: number,
  total: number,
): string {
  if (total === 0) return 'Showing 0 of 0';
  const first = (page - 1) * perPage + 1;
  const last = Math.min(page * perPage, total);
  return `Showing ${count.format(first)}–${count.format(last)} of ${count.format(total)}`;
}

/** The page that keeps the first account now on screen in view at the new size. */
export function pageAfterPerPage(
  page: number,
  from: number,
  to: number,
): number {
  return Math.floor(((page - 1) * from) / to) + 1;
}

/** Filters on, for the phone's "Filters · n". Search and sort are not filters. */
export function filtersOn(state: PeopleQuery): number {
  return [
    state.plan,
    state.pageStatus,
    state.payouts,
    state.joinedFrom,
    state.joinedTo,
  ].filter(Boolean).length;
}

export const formatCount = (n: number) => count.format(n);

const SHORT_DATE = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'Africa/Lagos',
});

/** "9 Nov 2026", the Lagos day. */
export const joinedWords = (iso: string) => SHORT_DATE.format(new Date(iso));

/** "2 hours ago", "Yesterday", "4 days ago", then the date. */
export function activeWords(iso: string | null, now: number): string {
  if (!iso) return 'Never signed in';
  const hours = Math.floor((now - Date.parse(iso)) / 3_600_000);
  if (hours < 1) return 'Within the hour';
  if (hours < 24) return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  if (hours < 48) return 'Yesterday';
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days} days ago`;
  return joinedWords(iso);
}
