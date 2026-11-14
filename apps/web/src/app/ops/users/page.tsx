'use client';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import {
  COVER_COLOURS,
  type OpsPeoplePage,
  type OpsPerson,
  type OpsPersonEmail,
} from '@tipme/contracts';
import { Badge, Button, EmptyWell, Notice, ProBadge } from '@tipme/ui';
import { AvatarImage } from '@/components/avatar';
import { ReasonAction } from '@/components/ops/reason-action';
import { naira } from '@/lib/money';
import { refusalWords } from '@/lib/ops-answers';
import { can, useOpsAccess } from '@/lib/ops-client';
import {
  activeWords,
  filtersOn,
  formatCount,
  joinedWords,
  PAGE_STATUS_WORDS,
  pageAfterPerPage,
  pageNumbers,
  PAYOUTS_WORDS,
  PEOPLE_DEFAULTS,
  PEOPLE_VIEW_KEY,
  peopleSearch,
  PLAN_WORDS,
  readPeopleQuery,
  showingWords,
  SORT_WORDS,
  withChange,
  type PeoplePageStatus,
  type PeoplePayouts,
  type PeoplePlan,
  type PeopleQuery,
  type PeopleSort,
  type PerPage,
} from '@/lib/ops-people-view';
import { opsFetch } from '@/lib/ops-staff-api';

/** From here the table, the inline filters and the numbered pager; below it, the phone layout. */
const WIDE = '(min-width: 48rem)';
type View = 'list' | 'grid';

function useWide(): boolean {
  const [wide, setWide] = useState(
    () => typeof window === 'undefined' || matchMedia(WIDE).matches,
  );
  useEffect(() => {
    const query = matchMedia(WIDE);
    const change = () => setWide(query.matches);
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, []);
  return wide;
}

/** List or Grid, remembered for this person in this browser (storage may be blocked). */
function useView(): [View, (view: View) => void] {
  const [view, setView] = useState<View>(() => {
    try {
      return localStorage.getItem(PEOPLE_VIEW_KEY) === 'grid' ? 'grid' : 'list';
    } catch {
      return 'list';
    }
  });
  const choose = (next: View) => {
    setView(next);
    try {
      localStorage.setItem(PEOPLE_VIEW_KEY, next);
    } catch {
      // Blocked storage: the choice lasts for this visit only.
    }
  };
  return [view, choose];
}

const nameOf = (person: OpsPerson) => person.displayName ?? 'No name yet';
const initialsOf = (person: OpsPerson) =>
  (person.displayName ?? '?')
    .split(/\s+/)
    .map((part) => Array.from(part)[0] ?? '')
    .slice(0, 2)
    .join('')
    .toUpperCase();
const pageHref = (handle: string) =>
  `/ops/pages?handle=${encodeURIComponent(handle)}`;

function Portrait({ person, size }: { person: OpsPerson; size: number }) {
  return (
    <span className="ops-people__avatar" aria-hidden="true">
      {person.avatarPath ? (
        <AvatarImage
          src={person.avatarPath}
          name={nameOf(person)}
          width={size}
          height={size}
          sizes={`${size}px`}
        />
      ) : (
        <span className="avatar--initials">{initialsOf(person)}</span>
      )}
    </span>
  );
}

function PlanMark({ plan }: { plan: OpsPerson['plan'] }) {
  return plan === 'pro' ? <ProBadge /> : <Badge>Free</Badge>;
}

function StatusMark({ status }: { status: PeoplePageStatus }) {
  return (
    <Badge className={`ops-people__status ops-people__status--${status}`}>
      {status !== 'none' && <span className="ops-people__dot" aria-hidden />}
      {PAGE_STATUS_WORDS[status]}
    </Badge>
  );
}

function BusinessMark() {
  return <Badge className="ops-people__business">Business</Badge>;
}

/** The name, linking to the page's details; no page yet, no link. */
function NameLink({ person }: { person: OpsPerson }) {
  return person.handle ? (
    <Link className="ops-people__link" href={pageHref(person.handle)}>
      {nameOf(person)}
    </Link>
  ) : (
    <span>{nameOf(person)}</span>
  );
}

/** The masked email, or the full one once revealed; the reveal button for private.view. */
function EmailText({
  person,
  revealed,
  canReveal,
  onReveal,
}: {
  person: OpsPerson;
  revealed: string | null | undefined;
  canReveal: boolean;
  onReveal: () => void;
}) {
  if (revealed !== undefined)
    return <span className="ops-people__email">{revealed ?? 'No email'}</span>;
  return (
    <span className="ops-people__email-cell">
      <span className="ops-people__email">{person.email ?? 'No email'}</span>
      {canReveal && person.email && (
        <Button
          variant="quiet"
          className="ops-people__reveal-button"
          aria-label={`Reveal ${nameOf(person)}’s email`}
          onClick={onReveal}
        >
          Reveal
        </Button>
      )}
    </span>
  );
}

function RevealForm({
  person,
  onDone,
  onCancel,
}: {
  person: OpsPerson;
  onDone: (email: string | null) => void;
  onCancel: () => void;
}) {
  return (
    <ReasonAction
      startOpen
      open="Reveal email"
      field={`Why do you need ${nameOf(person)}’s full email?`}
      submit="Reveal"
      onCancel={onCancel}
      onSubmit={async (reason) => {
        const result = await opsFetch<OpsPersonEmail>(
          `/v1/ops/users/${encodeURIComponent(person.id)}/reveal`,
          { method: 'POST', body: { reason } },
        );
        if (!result.ok) return refusalWords(result);
        onDone(result.data.email);
        return null;
      }}
    />
  );
}

type Reveal = {
  /** When the page opened: "last active" is read against it. */
  now: number;
  revealed: Record<string, string | null>;
  revealing: string | null;
  canReveal: boolean;
  start: (id: string) => void;
  finish: (id: string, email: string | null) => void;
  cancel: () => void;
};

function PeopleTable({
  items,
  money,
  sort,
  reveal,
}: {
  items: OpsPerson[];
  money: boolean;
  sort: PeopleSort;
  reveal: Reveal;
}) {
  const columns = money ? 8 : 7;
  return (
    <div className="ops-table-wrap">
      <table className="ops-table ops-people__table">
        <thead>
          <tr>
            <th
              scope="col"
              aria-sort={sort === 'name' ? 'ascending' : undefined}
            >
              Account
            </th>
            <th scope="col">Email</th>
            <th scope="col">Plan</th>
            <th scope="col">Page</th>
            <th scope="col">Payouts</th>
            <th
              scope="col"
              aria-sort={
                sort === 'newest'
                  ? 'descending'
                  : sort === 'oldest'
                    ? 'ascending'
                    : undefined
              }
            >
              Joined
            </th>
            <th scope="col">Last active</th>
            {money && (
              <th
                scope="col"
                aria-sort={sort === 'most_tips' ? 'descending' : undefined}
              >
                Tips received
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {items.map((person) => (
            <PersonRows
              key={person.id}
              person={person}
              money={money}
              columns={columns}
              reveal={reveal}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PersonRows({
  person,
  money,
  columns,
  reveal,
}: {
  person: OpsPerson;
  money: boolean;
  columns: number;
  reveal: Reveal;
}) {
  return (
    <>
      <tr className={person.handle ? 'ops-people__row--linked' : undefined}>
        <td>
          <span className="ops-people__who">
            <Portrait person={person} size={36} />
            <span>
              <strong>
                <NameLink person={person} />
              </strong>
              {person.business && <BusinessMark />}
              <small>
                {person.handle ? `@${person.handle}` : 'No page yet'}
              </small>
            </span>
          </span>
        </td>
        <td>
          <EmailText
            person={person}
            revealed={reveal.revealed[person.id]}
            canReveal={reveal.canReveal}
            onReveal={() => reveal.start(person.id)}
          />
        </td>
        <td>
          <PlanMark plan={person.plan} />
        </td>
        <td>
          <StatusMark status={person.pageStatus} />
        </td>
        <td
          className={person.payoutsSetUp ? 'ops-people__yes' : 'ops-people__no'}
        >
          {person.payoutsSetUp ? 'Set up' : 'Not set up'}
        </td>
        <td>{joinedWords(person.joinedAt)}</td>
        <td>{activeWords(person.lastActiveAt, reveal.now)}</td>
        {money && (
          <td className="ops-people__money">
            {naira(person.tipsTotalMinor ?? '0')}
          </td>
        )}
      </tr>
      {reveal.revealing === person.id && (
        <tr className="ops-people__reveal-row">
          <td colSpan={columns}>
            <RevealForm
              person={person}
              onDone={(email) => reveal.finish(person.id, email)}
              onCancel={reveal.cancel}
            />
          </td>
        </tr>
      )}
    </>
  );
}

/** The phone list: the table's fields stacked, in the same order. */
function PeopleStack({
  items,
  money,
  reveal,
}: {
  items: OpsPerson[];
  money: boolean;
  reveal: Reveal;
}) {
  return (
    <ul className="ops-people__stack">
      {items.map((person) => (
        <li
          key={person.id}
          className={
            person.handle
              ? 'ops-people__stacked ops-people__row--linked'
              : 'ops-people__stacked'
          }
        >
          <Portrait person={person} size={40} />
          <div className="ops-people__stacked-text">
            <strong>
              <NameLink person={person} />
            </strong>
            <small>
              {person.handle ? `@${person.handle}` : 'No page yet'} ·{' '}
              <EmailText
                person={person}
                revealed={reveal.revealed[person.id]}
                canReveal={reveal.canReveal}
                onReveal={() => reveal.start(person.id)}
              />
            </small>
            <span className="ops-people__badges">
              {person.business && <BusinessMark />}
              <PlanMark plan={person.plan} />
              <StatusMark status={person.pageStatus} />
              <Badge>
                {person.payoutsSetUp ? 'Payouts set up' : 'No payouts yet'}
              </Badge>
            </span>
            <small>
              Joined {joinedWords(person.joinedAt)} · active{' '}
              {activeWords(person.lastActiveAt, reveal.now).toLowerCase()}
              {money && ` · ${naira(person.tipsTotalMinor ?? '0')} in tips`}
            </small>
            {reveal.revealing === person.id && (
              <RevealForm
                person={person}
                onDone={(email) => reveal.finish(person.id, email)}
                onCancel={reveal.cancel}
              />
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

function coverStyle(person: OpsPerson): React.CSSProperties | undefined {
  if (person.pageStatus === 'none') return undefined;
  const colour =
    COVER_COLOURS.find((one) => one.id === person.coverColour) ??
    COVER_COLOURS.find((one) => one.id === 'violet');
  return colour
    ? {
        background: `linear-gradient(120deg, ${colour.base}, ${colour.tone})`,
      }
    : undefined;
}

function PeopleGrid({ items }: { items: OpsPerson[] }) {
  return (
    <ul className="ops-people__grid">
      {items.map((person) => {
        const body = (
          <>
            <span
              className={
                person.pageStatus === 'none'
                  ? 'ops-people__cover ops-people__cover--none'
                  : 'ops-people__cover'
              }
              style={coverStyle(person)}
              aria-hidden="true"
            />
            <Portrait person={person} size={52} />
            <span className="ops-people__card-body">
              <strong className="ops-people__card-name">
                {nameOf(person)}
              </strong>
              <span className="ops-people__card-handle">
                {person.handle ? `@${person.handle}` : 'No page yet'}
              </span>
              <span className="ops-people__badges">
                {person.business && <BusinessMark />}
                <PlanMark plan={person.plan} />
                <StatusMark status={person.pageStatus} />
              </span>
              <span className="ops-people__card-joined">
                Joined {joinedWords(person.joinedAt)}
              </span>
            </span>
          </>
        );
        return (
          <li key={person.id}>
            {person.handle ? (
              <Link className="ops-people__card" href={pageHref(person.handle)}>
                {body}
              </Link>
            ) : (
              <div className="ops-people__card">{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function LoadingRows({ view }: { view: View }) {
  return (
    <div className="ops-people__loading" role="status">
      <span className="sr-only">Loading accounts</span>
      {view === 'grid' ? (
        <div className="ops-people__grid" aria-hidden="true">
          {Array.from({ length: 6 }, (_, i) => (
            <span key={i} className="ops-people__skel-card" />
          ))}
        </div>
      ) : (
        <div aria-hidden="true">
          {Array.from({ length: 6 }, (_, i) => (
            <span key={i} className="ops-people__skel-row" />
          ))}
        </div>
      )}
    </div>
  );
}

function Select<T extends string | number>({
  id,
  label,
  value,
  choices,
  onChange,
  unset = null,
}: {
  id: string;
  label: string;
  value: T | null;
  choices: [T | null, string][];
  onChange: (value: T | null) => void;
  /** The value that means "nothing chosen" (null for filters, newest for the sort). */
  unset?: T | null;
}) {
  return (
    <div className="tm-field">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        className={value === unset ? 'tm-input' : 'tm-input ops-people__set'}
        value={value === null ? '' : String(value)}
        onChange={(event) => {
          const raw = event.target.value;
          const found = choices.find(([v]) => String(v ?? '') === raw);
          onChange(found ? found[0] : null);
        }}
      >
        {choices.map(([v, words]) => (
          <option key={String(v ?? '')} value={String(v ?? '')}>
            {words}
          </option>
        ))}
      </select>
    </div>
  );
}

/** One choice of several, as large chips (the phone sheet). */
function Chips<T extends string>({
  label,
  value,
  choices,
  onChange,
}: {
  label: string;
  value: T | null;
  choices: [T | null, string][];
  onChange: (value: T | null) => void;
}) {
  return (
    <div className="ops-people__chips-field">
      <p className="ops-people__chips-label" id={`chips-${label}`}>
        {label}
      </p>
      <div
        className="filter-row"
        role="group"
        aria-labelledby={`chips-${label}`}
      >
        {choices.map(([v, words]) => (
          <Button
            key={String(v ?? 'all')}
            variant={value === v ? 'primary' : 'secondary'}
            aria-pressed={value === v}
            onClick={() => onChange(v)}
          >
            {words}
          </Button>
        ))}
      </div>
    </div>
  );
}

const planChoices = (all: string): [PeoplePlan | null, string][] => [
  [null, all],
  ['free', PLAN_WORDS.free],
  ['pro', PLAN_WORDS.pro],
];
const statusChoices = (all: string): [PeoplePageStatus | null, string][] => [
  [null, all],
  ...(['live', 'offline', 'suspended', 'none'] as const).map(
    (status): [PeoplePageStatus, string] => [status, PAGE_STATUS_WORDS[status]],
  ),
];
const payoutChoices = (all: string): [PeoplePayouts | null, string][] => [
  [null, all],
  ['set_up', PAYOUTS_WORDS.set_up],
  ['not_set_up', PAYOUTS_WORDS.not_set_up],
];
const sortChoices = (money: boolean): [PeopleSort, string][] =>
  (
    [
      'newest',
      'oldest',
      'name',
      ...(money ? ['most_tips' as const] : []),
    ] as const
  ).map((sort): [PeopleSort, string] => [sort, SORT_WORDS[sort]]);

function DateField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="tm-field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="date"
        className={value ? 'tm-input ops-people__set' : 'tm-input'}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

function Pager({
  page,
  perPage,
  total,
  wide,
  hrefFor,
  onPerPage,
}: {
  page: number;
  perPage: PerPage;
  total: number;
  wide: boolean;
  hrefFor: (page: number) => string;
  onPerPage: (perPage: PerPage) => void;
}) {
  const id = useId();
  const last = Math.max(1, Math.ceil(total / perPage));
  const step = (to: number, words: ReactNode, rel: 'prev' | 'next') =>
    to < 1 || to > last ? (
      <span
        className="tm-button tm-button--secondary ops-people__step"
        aria-disabled="true"
      >
        {words}
      </span>
    ) : (
      <Link
        className="tm-button tm-button--secondary ops-people__step"
        data-material="raised"
        href={hrefFor(to)}
        rel={rel}
        scroll={false}
      >
        {words}
      </Link>
    );
  return (
    <nav className="ops-people__pager" aria-label="Pages">
      <p className="ops-people__showing">
        {showingWords(page, perPage, total)}
      </p>
      {wide && (
        <div className="ops-people__per-page">
          <label htmlFor={`${id}-per`}>Per page</label>
          <select
            id={`${id}-per`}
            className="tm-input"
            value={perPage}
            onChange={(event) =>
              onPerPage(Number(event.target.value) as PerPage)
            }
          >
            {[25, 50, 100].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="ops-people__pages">
        {step(page - 1, '‹ Previous', 'prev')}
        {wide ? (
          <ul className="ops-people__numbers">
            {pageNumbers(page, last).map((n, index) =>
              n === 'gap' ? (
                <li key={`gap-${index}`} aria-hidden="true">
                  …
                </li>
              ) : (
                <li key={n}>
                  <Link
                    href={hrefFor(n)}
                    scroll={false}
                    aria-current={n === page ? 'page' : undefined}
                    aria-label={`Page ${n}`}
                  >
                    {formatCount(n)}
                  </Link>
                </li>
              ),
            )}
          </ul>
        ) : (
          <span className="ops-people__page-words">
            Page {formatCount(page)} of {formatCount(last)}
          </span>
        )}
        {step(page + 1, 'Next ›', 'next')}
      </div>
    </nav>
  );
}

/**
 * People (owner's ask, 14 Nov 2026; OpsUsers board): every account, as a list or a grid, a page at
 * a time. Everything but the List/Grid choice lives in the address. Each row opens the page in
 * Pages; nothing can be changed from here. Emails are masked; private.view holders reveal one with
 * a reason, as for a business contact.
 */
export default function OpsPeoplePage() {
  const id = useId();
  const access = useOpsAccess();
  const allowed = can(access, 'search.view');
  const money = can(access, 'private.view');
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const state = readPeopleQuery(params, { privateView: money });
  const search = peopleSearch(state);
  const wide = useWide();
  const [view, setView] = useView();

  const [result, setResult] = useState<{
    search: string;
    data: OpsPeoplePage;
  } | null>(null);
  const [failedSearch, setFailedSearch] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [revealed, setRevealed] = useState<Record<string, string | null>>({});
  // The open reveal form belongs to the page it was opened on; another page has none open.
  const [revealingOn, setRevealingOn] = useState<{
    search: string;
    id: string;
  } | null>(null);
  const revealing = revealingOn?.search === search ? revealingOn.id : null;
  const setRevealing = (personId: string | null) =>
    setRevealingOn(personId ? { search, id: personId } : null);
  const [now] = useState(() => Date.now());

  const hrefOf = useCallback(
    (next: PeopleQuery) => {
      const text = peopleSearch(next);
      return text ? `${pathname}?${text}` : pathname;
    },
    [pathname],
  );
  const go = useCallback(
    (next: PeopleQuery, how: 'push' | 'replace' = 'push') =>
      router[how](hrefOf(next), { scroll: false }),
    [router, hrefOf],
  );

  useEffect(() => {
    if (!allowed) return;
    let current = true;
    void opsFetch<OpsPeoplePage>(
      `/v1/ops/users${search ? `?${search}` : ''}`,
    ).then((answer) => {
      if (!current) return;
      if (answer.ok) {
        setResult({ search, data: answer.data });
        setFailedSearch(null);
      } else setFailedSearch(search);
    });
    return () => {
      current = false;
    };
  }, [allowed, search, attempt]);

  // A shared link past the end: the server served the last page, and the address says so too.
  const served = result?.search === search ? result.data : null;
  useEffect(() => {
    if (served && served.page !== state.page)
      go({ ...state, page: served.page }, 'replace');
  }, [served, state, go]);

  // The search box: typed text goes to the address after a pause (replacing, not stacking history).
  const [text, setText] = useState(state.q);
  // Back, Clear filters or a shared link change the search: the box follows (during render, as
  // React advises for state that tracks a prop).
  const [shownQ, setShownQ] = useState(state.q);
  if (shownQ !== state.q) {
    setShownQ(state.q);
    // What was typed stays as typed (a trailing space mid-name) when the address only caught up.
    if (state.q.trim() !== text.trim()) setText(state.q);
  }
  const typed = useRef(false);
  useEffect(() => {
    if (!typed.current || text.trim() === state.q.trim()) return;
    const timer = setTimeout(
      () => go(withChange(state, { q: text }), 'replace'),
      300,
    );
    return () => clearTimeout(timer);
  }, [text, state, go]);
  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    if (text.trim() !== state.q.trim()) go(withChange(state, { q: text }));
  };

  const sheet = useRef<HTMLDialogElement>(null);
  const filtersButton = useRef<HTMLButtonElement>(null);

  if (!allowed)
    return (
      <Notice tone="neutral" title="Not part of your role">
        Seeing everyone needs the “search.view” permission.
      </Notice>
    );

  const change = (patch: Partial<PeopleQuery>) => go(withChange(state, patch));
  const clearAll = () => {
    setText('');
    go(PEOPLE_DEFAULTS);
  };
  const filtered = filtersOn(state) > 0 || state.q.trim() !== '';
  const shown = served ?? (result ? result.data : null);
  const loading = result?.search !== search && failedSearch !== search;
  const failed = failedSearch === search;
  const reveal: Reveal = {
    now,
    revealed,
    revealing,
    canReveal: money,
    start: setRevealing,
    finish: (personId, email) => {
      setRevealed((before) => ({ ...before, [personId]: email }));
      setRevealing(null);
    },
    cancel: () => setRevealing(null),
  };

  const filterFields = (
    <>
      <Select
        id={`${id}-plan`}
        label="Plan"
        value={state.plan}
        choices={planChoices('All')}
        onChange={(plan) => change({ plan })}
      />
      <Select
        id={`${id}-status`}
        label="Page"
        value={state.pageStatus}
        choices={statusChoices('Any')}
        onChange={(pageStatus) => change({ pageStatus })}
      />
      <Select
        id={`${id}-payouts`}
        label="Payouts"
        value={state.payouts}
        choices={payoutChoices('All')}
        onChange={(payouts) => change({ payouts })}
      />
      <DateField
        id={`${id}-from`}
        label="Joined from"
        value={state.joinedFrom}
        onChange={(joinedFrom) => change({ joinedFrom })}
      />
      <DateField
        id={`${id}-to`}
        label="Joined to"
        value={state.joinedTo}
        onChange={(joinedTo) => change({ joinedTo })}
      />
      <Select
        id={`${id}-sort`}
        label="Sort"
        value={state.sort}
        choices={sortChoices(money)}
        unset="newest"
        onChange={(sort) => change({ sort: sort ?? 'newest' })}
      />
    </>
  );

  const chips: [string, Partial<PeopleQuery>][] = [
    ...(state.plan
      ? [
          [`Plan: ${PLAN_WORDS[state.plan]}`, { plan: null }] as [
            string,
            Partial<PeopleQuery>,
          ],
        ]
      : []),
    ...(state.pageStatus
      ? [
          [
            `Page: ${PAGE_STATUS_WORDS[state.pageStatus]}`,
            { pageStatus: null },
          ] as [string, Partial<PeopleQuery>],
        ]
      : []),
    ...(state.payouts
      ? [
          [`Payouts: ${PAYOUTS_WORDS[state.payouts]}`, { payouts: null }] as [
            string,
            Partial<PeopleQuery>,
          ],
        ]
      : []),
    ...(state.joinedFrom
      ? [
          [
            `Joined from ${joinedWords(`${state.joinedFrom}T12:00:00Z`)}`,
            { joinedFrom: '' },
          ] as [string, Partial<PeopleQuery>],
        ]
      : []),
    ...(state.joinedTo
      ? [
          [
            `Joined to ${joinedWords(`${state.joinedTo}T12:00:00Z`)}`,
            { joinedTo: '' },
          ] as [string, Partial<PeopleQuery>],
        ]
      : []),
  ];

  return (
    <div className="ops-dashboard ops-people">
      <div className="ops-people__top">
        <h1 id={`${id}-title`}>People</h1>
        <p className="ops-people__count" aria-live="polite">
          {shown
            ? `${formatCount(shown.total)} ${filtered ? (shown.total === 1 ? 'account matches' : 'accounts match') : shown.total === 1 ? 'account' : 'accounts'}`
            : ''}
        </p>
        <div
          className="filter-row ops-people__view"
          role="group"
          aria-label="View"
        >
          {(['list', 'grid'] as const).map((choice) => (
            <Button
              key={choice}
              variant={view === choice ? 'primary' : 'secondary'}
              aria-pressed={view === choice}
              onClick={() => setView(choice)}
            >
              {choice === 'list' ? 'List' : 'Grid'}
            </Button>
          ))}
        </div>
      </div>
      <p className="tm-hint">
        Every account on TipMe, with or without a live page. Open one to see its
        page details. Opening this list and each search are recorded in the
        audit log (without what you typed).
      </p>

      <form
        role="search"
        aria-label="Find people"
        className={wide ? 'ops-people__filters' : 'ops-people__phone-bar'}
        onSubmit={submitSearch}
      >
        <div className="tm-field ops-people__search">
          <label htmlFor={`${id}-q`}>Search</label>
          <input
            id={`${id}-q`}
            className="tm-input"
            type="search"
            autoComplete="off"
            spellCheck={false}
            maxLength={100}
            placeholder={money ? 'Name, @handle or email' : 'Name or @handle'}
            value={text}
            onChange={(event) => {
              typed.current = true;
              setText(event.target.value);
            }}
          />
        </div>
        {wide ? (
          filterFields
        ) : (
          <Button
            ref={filtersButton}
            variant="secondary"
            aria-haspopup="dialog"
            onClick={() => sheet.current?.showModal()}
          >
            {filtersOn(state) > 0 ? `Filters · ${filtersOn(state)}` : 'Filters'}
          </Button>
        )}
      </form>

      {!wide && (
        <dialog
          ref={sheet}
          className="ops-frame__sheet ops-people__sheet"
          aria-labelledby={`${id}-sheet-title`}
          onClose={() => filtersButton.current?.focus({ preventScroll: true })}
          onClick={(event) => {
            if (event.target === event.currentTarget) sheet.current?.close();
          }}
        >
          <div className="ops-frame__sheet-body ops-people__sheet-body">
            <div className="ops-frame__grab" aria-hidden="true" />
            <div className="ops-people__sheet-head">
              <h2 id={`${id}-sheet-title`}>Filters</h2>
              <Button variant="quiet" onClick={clearAll}>
                Clear all
              </Button>
            </div>
            <Chips
              label="Plan"
              value={state.plan}
              choices={planChoices('All')}
              onChange={(plan) => change({ plan })}
            />
            <Chips
              label="Page"
              value={state.pageStatus}
              choices={statusChoices('Any')}
              onChange={(pageStatus) => change({ pageStatus })}
            />
            <Chips
              label="Payouts"
              value={state.payouts}
              choices={payoutChoices('All')}
              onChange={(payouts) => change({ payouts })}
            />
            <div className="ops-people__dates">
              <DateField
                id={`${id}-sheet-from`}
                label="Joined from"
                value={state.joinedFrom}
                onChange={(joinedFrom) => change({ joinedFrom })}
              />
              <DateField
                id={`${id}-sheet-to`}
                label="Joined to"
                value={state.joinedTo}
                onChange={(joinedTo) => change({ joinedTo })}
              />
            </div>
            <Select
              id={`${id}-sheet-sort`}
              label="Sort"
              value={state.sort}
              choices={sortChoices(money)}
              unset="newest"
              onChange={(sort) => change({ sort: sort ?? 'newest' })}
            />
            <Button onClick={() => sheet.current?.close()}>
              {shown
                ? `Show ${formatCount(shown.total)} ${shown.total === 1 ? 'account' : 'accounts'}`
                : 'Show accounts'}
            </Button>
          </div>
        </dialog>
      )}

      {(chips.length > 0 || filtered) && (
        <div className="ops-people__chips">
          {chips.length > 0 && <span>Filtered by</span>}
          {chips.map(([words, patch]) => (
            <Button
              key={words}
              variant="secondary"
              className="ops-people__chip"
              aria-label={`Remove filter ${words}`}
              onClick={() => change(patch)}
            >
              {words} <span aria-hidden="true">×</span>
            </Button>
          ))}
          <Button variant="quiet" onClick={clearAll}>
            Clear filters
          </Button>
        </div>
      )}

      <section
        aria-labelledby={`${id}-title`}
        aria-busy={loading}
        className={
          loading && shown
            ? 'ops-people__results ops-people__results--stale'
            : 'ops-people__results'
        }
        data-testid="ops-people"
      >
        {failed ? (
          <>
            <Notice tone="error" title="We couldn’t load the list">
              The connection may have dropped. Your filters are kept.
            </Notice>
            <Button
              variant="secondary"
              onClick={() => setAttempt((n) => n + 1)}
            >
              Try again
            </Button>
          </>
        ) : !shown ? (
          <LoadingRows view={view} />
        ) : shown.items.length === 0 ? (
          <EmptyWell
            title={filtered ? 'No accounts match.' : 'No accounts yet.'}
            action={
              filtered ? (
                <Button variant="secondary" onClick={clearAll}>
                  Clear filters
                </Button>
              ) : undefined
            }
          >
            {filtered ? 'Try a different spelling, or fewer filters.' : null}
          </EmptyWell>
        ) : view === 'grid' ? (
          <PeopleGrid items={shown.items} />
        ) : wide ? (
          <PeopleTable
            items={shown.items}
            money={money}
            sort={state.sort}
            reveal={reveal}
          />
        ) : (
          <PeopleStack items={shown.items} money={money} reveal={reveal} />
        )}
      </section>

      {shown && shown.total > 0 && !failed && (
        <Pager
          page={shown.page}
          perPage={shown.perPage}
          total={shown.total}
          wide={wide}
          hrefFor={(page) => hrefOf({ ...state, page })}
          onPerPage={(perPage) =>
            go({
              ...state,
              perPage,
              page: pageAfterPerPage(shown.page, shown.perPage, perPage),
            })
          }
        />
      )}
    </div>
  );
}
