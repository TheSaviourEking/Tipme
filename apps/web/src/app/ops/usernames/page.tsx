'use client';
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import {
  TAKE_BACK_CATEGORY_WORDS,
  type OpsReservation,
  type OpsTakeBack,
  type OpsUsernameCheck,
  type OpsUsernamesList,
} from '@tipme/contracts';
import Link from 'next/link';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  InputField,
  Notice,
  Skeleton,
} from '@tipme/ui';
import { ReasonAction } from '@/components/ops/reason-action';
import {
  TakeBackForm,
  type TakeBackAnswer,
} from '@/components/ops/take-back-form';
import { age, can, useOpsAccess, when } from '@/lib/ops-client';
import { outcomeIsUnknown, refusalWords } from '@/lib/ops-answers';
import { takeBackStateWords } from '@/lib/take-back-words';
import { opsAct, opsFetch } from '@/lib/ops-staff-api';

type Said = {
  tone: 'success' | 'error' | 'neutral';
  title: string;
  text: string;
};

const SOURCE_WORDS: Record<OpsReservation['source'], string> = {
  staff: 'Staff',
  take_back: 'Take-back',
};

// A deletion hold's end, written out in Lagos time ("10 November 2026").
const day = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'long',
  timeZone: 'Africa/Lagos',
});

const reserve = (name: string, reason: string) =>
  opsAct<OpsReservation>('/v1/ops/usernames', {
    method: 'POST',
    body: { name, reason },
  });
const release = (name: string, reason: string) =>
  opsAct<{ name: string }>(
    `/v1/ops/usernames/${encodeURIComponent(name)}/release`,
    { method: 'POST', body: { reason } },
  );
const check = (name: string) =>
  opsFetch<OpsUsernameCheck>(
    `/v1/ops/usernames/check/${encodeURIComponent(name)}`,
  );

/** What the checked name is, in words, with the one action that fits. */
function CheckAnswer({
  answer,
  onReserve,
  onRelease,
  onTakeBack,
  onCancelTakeBack,
}: {
  answer: OpsUsernameCheck;
  onReserve: (reason: string) => Promise<string | null>;
  onRelease: (reason: string) => Promise<string | null>;
  onTakeBack: (answer: TakeBackAnswer) => void;
  onCancelTakeBack: (id: string, reason: string) => Promise<string | null>;
}) {
  const id = useId();
  const heading = <h3 id={id}>@{answer.name}</h3>;
  switch (answer.state) {
    case 'invalid':
      return (
        <article aria-labelledby={id} className="ops-row">
          <h3 id={id}>{answer.name || 'That name'}</h3>
          <p>
            <strong>Not a username.</strong> A username is 3 to 30 letters,
            numbers or underscores.
          </p>
        </article>
      );
    case 'built_in':
      return (
        <article aria-labelledby={id} className="ops-row">
          {heading}
          <p>
            <strong>Built in.</strong> TipMe’s own list reserves this. It can’t
            be reserved or released here.
          </p>
        </article>
      );
    case 'free':
      return (
        <article aria-labelledby={id} className="ops-row">
          {heading}
          <p>
            <strong>Free.</strong>{' '}
            {answer.heldUntil
              ? `A deleted page’s username, held until ${day.format(new Date(answer.heldUntil))}. A reservation keeps it after that.`
              : 'Anyone can claim it now.'}
          </p>
          <div className="ops-actions">
            <ReasonAction
              open="Reserve…"
              field="Why reserve this username?"
              submit="Reserve this username"
              onSubmit={onReserve}
            />
          </div>
        </article>
      );
    case 'reserved':
      return (
        <article aria-labelledby={id} className="ops-row">
          {heading}
          <p>
            <strong>Reserved.</strong> Nobody can claim it or change to it.
          </p>
          <Facts reservation={answer.reservation} />
          <div className="ops-actions">
            <ReasonAction
              open="Release…"
              field="Why release this username?"
              submit="Release this username"
              onSubmit={onRelease}
            />
          </div>
        </article>
      );
    case 'page':
      return (
        <article aria-labelledby={id} className="ops-row">
          {heading}
          <p>
            <strong>
              {answer.kind === 'current'
                ? `@${answer.page.handle}’s username.`
                : `An old username of @${answer.page.handle}, which still leads to their page.`}
            </strong>{' '}
            {answer.page.displayName},{' '}
            {answer.page.plan === 'pro' ? 'Pro' : 'Free'}.
          </p>
          {answer.openTakeBack ? (
            <>
              <p>
                <strong>Take-back:</strong>{' '}
                {takeBackStateWords(answer.openTakeBack)} (
                {TAKE_BACK_CATEGORY_WORDS[answer.openTakeBack.category]},{' '}
                {answer.openTakeBack.noticeDays} days’ notice).
              </p>
              <div className="ops-actions">
                <ReasonAction
                  open="Cancel the take-back…"
                  field="Why cancel this take-back?"
                  submit="Cancel the take-back"
                  onSubmit={(reason) =>
                    onCancelTakeBack(answer.openTakeBack!.id, reason)
                  }
                />
              </div>
            </>
          ) : answer.pendingRequestId ? (
            <p>
              <strong>Take-back:</strong> Waiting for approval.{' '}
              <Link href="/ops/approvals">Open Approvals</Link>
            </p>
          ) : (
            <div className="ops-actions">
              <TakeBackForm
                name={answer.name}
                kind={answer.kind}
                page={answer.page}
                facts={answer.facts}
                onDone={onTakeBack}
              />
            </div>
          )}
        </article>
      );
  }
}

function Facts({ reservation }: { reservation: OpsReservation }) {
  return (
    <dl className="ops-facts">
      <div>
        <dt>Reserved by</dt>
        <dd>{reservation.reservedBy ?? 'TipMe, at the end of a take-back'}</dd>
      </div>
      <div>
        <dt>When</dt>
        <dd>{when(reservation.reservedAt)}</dd>
      </div>
      <div>
        <dt>Why</dt>
        <dd>{reservation.reason}</dd>
      </div>
      <div>
        <dt>Source</dt>
        <dd>{SOURCE_WORDS[reservation.source]}</dd>
      </div>
    </dl>
  );
}

/** Staff reserve and release usernames (usernames.manage). The server checks every call. */
export default function UsernamesPage() {
  const id = useId();
  const access = useOpsAccess();
  const allowed = can(access, 'usernames.manage');
  const [name, setName] = useState('');
  const [answer, setAnswer] = useState<OpsUsernameCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkFailed, setCheckFailed] = useState('');
  const [list, setList] = useState<OpsUsernamesList | null>(null);
  const [listFailed, setListFailed] = useState('');
  const [filters, setFilters] = useState({ q: '', state: '' });
  const [said, setSaid] = useState<Said | null>(null);
  const saidAt = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(0);

  const load = useCallback(async (next: { q: string; state: string }) => {
    const query = new URLSearchParams();
    if (next.q.trim()) query.set('q', next.q.trim());
    if (next.state) query.set('state', next.state);
    const text = query.toString();
    const result = await opsFetch<OpsUsernamesList>(
      `/v1/ops/usernames${text ? `?${text}` : ''}`,
    );
    setNow(Date.now());
    if (result.ok) {
      setList(result.data);
      setListFailed('');
    } else setListFailed(refusalWords(result));
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- nothing is set before the await
    if (allowed) void load({ q: '', state: '' });
  }, [allowed, load]);

  const say = (next: Said) => {
    setSaid(next);
    // The form that was open has gone, so focus goes to what happened.
    requestAnimationFrame(() => saidAt.current?.focus());
  };

  const recheck = async (raw: string) => {
    const result = await check(raw);
    if (result.ok) {
      setAnswer(result.data);
      setCheckFailed('');
    } else {
      setAnswer(null);
      setCheckFailed(refusalWords(result));
    }
    return result.ok ? result.data : null;
  };

  if (!allowed)
    return (
      <Notice tone="neutral" title="Not part of your role">
        Reserving usernames needs the usernames.manage permission.
      </Notice>
    );

  const submitCheck = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    setChecking(true);
    setSaid(null);
    await recheck(name);
    setChecking(false);
  };

  // A refusal means the name changed under you (someone reserved or released it, a page took it),
  // so the card re-reads it and redraws, closing the form. The words therefore go to the notice at
  // the top, never into the form that is about to go, and never as a success (review I1). A
  // refused reason (400) is the exception: nothing changed, so it stays in the form to be fixed.
  const refused = async (
    raw: string,
    result: { status: number; code: string; message?: string },
  ) => {
    if (result.status === 400) return refusalWords(result);
    const current = answer?.name === raw ? await recheck(raw) : null;
    void load(filters);
    say({
      tone: 'error',
      title: outcomeIsUnknown(result)
        ? 'We can’t say what happened'
        : 'Not done',
      text: refusalWords(
        result,
        current?.state === 'page' ? { handle: current.page.handle } : undefined,
      ),
    });
    return null;
  };

  const onReserve = async (raw: string, reason: string) => {
    const result = await reserve(raw, reason);
    if (result.kind === 'refused') return refused(raw, result);
    if (result.kind === 'waiting') {
      say({
        tone: 'neutral',
        title: 'Waiting for a second person',
        text: 'It happens once someone approves it in Approvals.',
      });
      return null;
    }
    setAnswer({
      name: result.data.name,
      state: 'reserved',
      reservation: result.data,
    });
    say({
      tone: 'success',
      title: 'Reserved',
      text: `Nobody can claim @${result.data.name} or change to it now. Nobody else is told.`,
    });
    void load(filters);
    return null;
  };

  const onRelease = async (raw: string, reason: string) => {
    const result = await release(raw, reason);
    if (result.kind === 'refused') return refused(raw, result);
    if (result.kind === 'waiting') {
      say({
        tone: 'neutral',
        title: 'Waiting for a second person',
        text: 'It happens once someone approves it in Approvals.',
      });
      return null;
    }
    say({
      tone: 'success',
      title: 'Released',
      text: `@${result.data.name} is free again, unless a deleted page’s hold is still running.`,
    });
    if (answer?.name === result.data.name) void recheck(result.data.name);
    void load(filters);
    return null;
  };

  const onTakeBack = (raw: string) => (outcome: TakeBackAnswer) => {
    say(
      outcome.kind === 'waiting'
        ? {
            tone: 'neutral',
            title: 'Waiting for approval',
            text: 'The take-back starts once someone else approves it in Approvals.',
          }
        : {
            tone: 'success',
            title: outcome.actedAlone ? 'Done alone' : 'Take-back started',
            text: outcome.actedAlone
              ? 'Nobody else could approve it, so it started now, and the owners were alerted. The notice is on its way.'
              : 'The notice is on its way.',
          },
    );
    void recheck(raw);
    void load(filters);
  };

  const onCancelTakeBack =
    (raw: string) => async (takeBackId: string, reason: string) => {
      const result = await opsAct<OpsTakeBack>(
        `/v1/ops/usernames/take-backs/${encodeURIComponent(takeBackId)}/cancel`,
        { method: 'POST', body: { reason } },
      );
      if (result.kind === 'refused') return refused(raw, result);
      say({
        tone: 'success',
        title: 'Take-back cancelled',
        text: 'The username stays with the page. If they had the notice, they are told they can keep it.',
      });
      void recheck(raw);
      void load(filters);
      return null;
    };

  const applyFilters = (event: FormEvent) => {
    event.preventDefault();
    void load(filters);
  };

  return (
    <div className="ops-dashboard">
      <h1>Usernames</h1>
      <p className="tm-hint">
        A reserved username can’t be claimed at sign-up or taken by a handle
        change. The public sees “reserved”, exactly as for TipMe’s own words.
        Reserving and releasing happen at once, with your reason in the audit
        log. Taking a username back from a page waits for a second person when
        one is available.
      </p>
      <div ref={saidAt} tabIndex={-1}>
        {said && (
          <Notice tone={said.tone} title={said.title}>
            {said.text}
          </Notice>
        )}
      </div>

      <Card className="settings-section">
        <h2 id={`${id}-check`}>Check a name</h2>
        <form
          className="settings-form"
          aria-labelledby={`${id}-check`}
          onSubmit={(e) => void submitCheck(e)}
        >
          <InputField
            id={`${id}-name`}
            label="Name"
            hint="Case and - or _ don’t matter: MTN, mtn and Mtn are one name."
            autoComplete="off"
            spellCheck={false}
            maxLength={40}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Button type="submit" disabled={checking} aria-busy={checking}>
            Check
          </Button>
        </form>
        {checkFailed && (
          <Notice tone="error" title="Couldn’t check that name">
            {checkFailed}
          </Notice>
        )}
        {answer && (
          <CheckAnswer
            key={`${answer.name}-${answer.state}`}
            answer={answer}
            onReserve={(reason) => onReserve(answer.name, reason)}
            onRelease={(reason) => onRelease(answer.name, reason)}
            onTakeBack={onTakeBack(answer.name)}
            onCancelTakeBack={onCancelTakeBack(answer.name)}
          />
        )}
      </Card>

      <Card className="settings-section">
        <h2 id={`${id}-take-backs`}>Take-backs</h2>
        {list?.pending && list.pending.length > 0 && (
          <ul className="ops-list">
            {list.pending.map((request) => (
              <li key={request.requestId} className="ops-row">
                @{request.name}: Waiting for approval.{' '}
                <Link href="/ops/approvals">Open Approvals</Link>
              </li>
            ))}
          </ul>
        )}
        {list &&
          (list.takeBacks ?? []).length === 0 &&
          !list.pending?.length && (
            <EmptyState title="No take-backs">
              Check a name above to take it back from a page.
            </EmptyState>
          )}
        {list && (list.takeBacks ?? []).length > 0 && (
          <div
            className="ops-table-wrap"
            role="region"
            aria-labelledby={`${id}-take-backs`}
            tabIndex={0}
          >
            <table className="ops-table">
              <caption className="sr-only">Take-backs, open ones first</caption>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Page</th>
                  <th scope="col">Category</th>
                  <th scope="col">State</th>
                  <th scope="col">Asked by</th>
                  <th scope="col">New username</th>
                </tr>
              </thead>
              <tbody>
                {(list.takeBacks ?? []).map((row) => (
                  <tr key={row.id}>
                    <td>@{row.name}</td>
                    <td>@{row.pageHandle}</td>
                    <td>{TAKE_BACK_CATEGORY_WORDS[row.category]}</td>
                    <td>{takeBackStateWords(row)}</td>
                    <td>{row.requestedBy}</td>
                    <td>{row.newHandle ? `@${row.newHandle}` : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="settings-section">
        <h2 id={`${id}-reserved`}>Reserved</h2>
        <form
          className="ops-filters"
          aria-label="Filter reserved usernames"
          onSubmit={applyFilters}
        >
          <InputField
            id={`${id}-q`}
            label="Starts with"
            autoComplete="off"
            spellCheck={false}
            maxLength={30}
            value={filters.q}
            onChange={(e) => setFilters({ ...filters, q: e.target.value })}
          />
          <div className="tm-field">
            <label htmlFor={`${id}-source`}>Source</label>
            <select
              id={`${id}-source`}
              className="tm-input"
              value={filters.state}
              onChange={(e) =>
                setFilters({ ...filters, state: e.target.value })
              }
            >
              <option value="">All</option>
              <option value="staff">Staff</option>
              <option value="take_back">Take-back</option>
            </select>
          </div>
          <Button type="submit" variant="secondary">
            Show
          </Button>
        </form>
        {listFailed && (
          <Notice tone="error" title="Couldn’t load the reserved usernames">
            {listFailed}
          </Notice>
        )}
        {!list && !listFailed && (
          <Skeleton label="Loading reserved usernames" />
        )}
        {list?.reservations.length === 0 && (
          <EmptyState title="None reserved">
            No staff reservation matches. TipMe’s own list is below.
          </EmptyState>
        )}
        {list?.more && (
          <p className="tm-hint">
            Showing the newest {list.reservations.length}. Search by the start
            of the name to find others, or check a name above.
          </p>
        )}
        {list && list.reservations.length > 0 && (
          <div
            className="ops-table-wrap"
            role="region"
            aria-labelledby={`${id}-reserved`}
            tabIndex={0}
          >
            <table className="ops-table">
              <caption className="sr-only">
                Reserved usernames, newest first
              </caption>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Reserved by</th>
                  <th scope="col">When</th>
                  <th scope="col">Reason</th>
                  <th scope="col">Source</th>
                  <th scope="col">Action</th>
                </tr>
              </thead>
              <tbody>
                {list.reservations.map((row) => (
                  <tr key={row.id}>
                    <td>@{row.name}</td>
                    <td>{row.reservedBy ?? 'TipMe'}</td>
                    <td>
                      {when(row.reservedAt)}
                      {now > 0 && (
                        <span className="tm-hint">
                          {' '}
                          ({age(row.reservedAt, now)})
                        </span>
                      )}
                    </td>
                    <td>{row.reason}</td>
                    <td>{SOURCE_WORDS[row.source]}</td>
                    <td>
                      <ReasonAction
                        open={`Release @${row.name}…`}
                        field={`Why release @${row.name}?`}
                        submit="Release this username"
                        variant="quiet"
                        onSubmit={(reason) => onRelease(row.name, reason)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {list && (
          <details className="ops-section">
            <summary>
              TipMe’s own list <Badge>{list.builtIn.length}</Badge>
            </summary>
            <p className="tm-hint">
              Built into TipMe: its own pages and words it may need. They can’t
              be released here.
            </p>
            <p>{list.builtIn.join(', ')}</p>
          </details>
        )}
      </Card>
    </div>
  );
}
