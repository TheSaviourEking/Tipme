'use client';
import { useEffect, useId, useRef, useState } from 'react';
import type {
  OpsMailContent,
  OpsMailRow,
  OpsMailSeriesPoint,
  OpsMailSummary,
  OpsMailTimelineEvent,
} from '@tipme/contracts';
import { Button, Card, EmptyState, Notice, Skeleton } from '@tipme/ui';
import { LineChart, Tile } from '@/components/ops/charts';
import { ReasonAction } from '@/components/ops/reason-action';
import { can, useOpsAccess, when } from '@/lib/ops-client';
import { apiDownload, apiFetch } from '@/lib/session-client';

const PERIODS: Record<string, { label: string; versus: string }> = {
  today: { label: 'Today', versus: 'all of yesterday' },
  yesterday: { label: 'Yesterday', versus: 'the day before' },
  this_week: { label: 'This week', versus: 'the same days last week' },
  last_week: { label: 'Last week', versus: 'the week before' },
  this_month: { label: 'This month', versus: 'the same days last month' },
  last_month: { label: 'Last month', versus: 'the month before' },
};
const STATUSES = [
  'queued',
  'sent',
  'failed',
  'bounced',
  'complained',
  'suppressed',
  'skipped',
  'expired',
];
const EVENT_LABELS: Record<string, string> = {
  queued: 'Queued',
  sent: 'Sent',
  send_failed: 'A send attempt failed',
  delivered: 'Delivered',
  opened: 'Opened',
  clicked: 'Clicked',
  soft_bounce: 'Bounced for now',
  hard_bounce: 'Bounced permanently',
  complaint: 'Marked as spam',
  suppressed: 'Not sent: address blocked',
  skipped_preference: 'Not sent: turned off by the person',
  expired: 'Not sent: its code had expired',
};
const typeLabel = (type: string) => {
  const words = type.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
};
const number = new Intl.NumberFormat('en');
const rate = (value: number | null) =>
  value === null ? 'None sent' : `${Math.round(value * 100)}%`;

function change(pct: number | null, versus: string) {
  if (pct === null) return `Nothing to compare with ${versus}`;
  return `${pct > 0 ? '+' : ''}${pct}% vs ${versus}`;
}

function MessageDrawer({ row }: { row: OpsMailRow }) {
  const access = useOpsAccess();
  const [timeline, setTimeline] = useState<OpsMailTimelineEvent[] | null>(null);
  const [content, setContent] = useState<OpsMailContent | null>(null);
  const [address, setAddress] = useState<string | null | undefined>(undefined);
  const region = useRef<HTMLDivElement>(null);
  // It opens above the list, so take focus (and the view) there.
  useEffect(() => {
    region.current?.focus();
    region.current?.scrollIntoView({ block: 'nearest' });
  }, []);
  useEffect(() => {
    void apiFetch<OpsMailTimelineEvent[]>(
      `/v1/ops/email/messages/${row.id}/timeline`,
    ).then((result) => setTimeline(result.ok ? result.data : []));
  }, [row.id]);
  return (
    <div ref={region} tabIndex={-1} role="region" aria-label="This email">
      <Card className="settings-section">
        <h2>{typeLabel(row.type)}</h2>
        <p>
          To {address ?? row.toHint}
          {row.provider ? `, sent through ${row.provider}` : ''}.
        </p>
        {can(access, 'private.view') && address === undefined && (
          <ReasonAction
            open="Reveal the address"
            field="Why do you need the full address?"
            submit="Reveal"
            onSubmit={async (reason) => {
              const result = await apiFetch<{ address: string | null }>(
                `/v1/ops/email/messages/${row.id}/reveal-recipient`,
                { method: 'POST', body: { reason } },
              );
              if (!result.ok)
                return 'That didn’t go through. Please try again.';
              setAddress(
                result.data.address ??
                  `${row.toHint} (full address deleted after 7 days)`,
              );
              return null;
            }}
          />
        )}
        {timeline === null ? (
          <Skeleton />
        ) : (
          <ol className="ops-list">
            {timeline.map((event, i) => (
              <li key={`${event.kind}-${i}`}>
                {event.kind === 'sent' && event.provider
                  ? `Sent through ${event.provider}`
                  : (EVENT_LABELS[event.kind] ?? event.kind)}
                {event.linkKey ? `: ${event.linkKey.replace(/_/g, ' ')}` : ''},{' '}
                {when(event.occurredAt)}
              </li>
            ))}
          </ol>
        )}
        {content === null ? (
          <Button
            variant="secondary"
            onClick={() =>
              void apiFetch<OpsMailContent>(
                `/v1/ops/email/messages/${row.id}/content`,
              ).then((result) =>
                setContent(result.ok ? result.data : { status: 'withheld' }),
              )
            }
          >
            View email
          </Button>
        ) : content.status === 'withheld' ? (
          <Notice tone="neutral" title="Content withheld">
            This email contains a sign-in or recovery code, or has no saved
            copy, so it can’t be shown.
          </Notice>
        ) : (
          <>
            <p>
              <strong>{content.subject}</strong>
            </p>
            {/* sandbox="": no scripts, no same-origin access, links can't navigate this page. */}
            <iframe
              className="ops-email-preview"
              title={`Email: ${content.subject}`}
              sandbox=""
              srcDoc={content.html}
            />
          </>
        )}
        {row.providerMessageId && (
          <p>Provider message id: {row.providerMessageId}</p>
        )}
      </Card>
    </div>
  );
}

export default function EmailConsolePage() {
  const id = useId();
  const [period, setPeriod] = useState('this_month');
  const [type, setType] = useState('');
  const [status, setStatus] = useState('');
  const [account, setAccount] = useState('');
  const [summary, setSummary] = useState<OpsMailSummary | null>(null);
  const [series, setSeries] = useState<OpsMailSeriesPoint[]>([]);
  const [rows, setRows] = useState<OpsMailRow[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [chosen, setChosen] = useState<OpsMailRow | null>(null);
  const [numbersFailed, setNumbersFailed] = useState(false);
  const [listFailed, setListFailed] = useState(false);
  const [provider, setProvider] = useState('');
  const versus = PERIODS[period]?.versus ?? 'the period before';

  // Each response is ignored once a newer choice has been made.
  useEffect(() => {
    let current = true;
    void apiFetch<OpsMailSummary>(
      `/v1/ops/email/summary?period=${period}`,
    ).then((result) => {
      if (!current) return;
      setNumbersFailed(!result.ok);
      if (result.ok) setSummary(result.data);
    });
    void apiFetch<OpsMailSeriesPoint[]>(
      `/v1/ops/email/series?period=${period}`,
    ).then((result) => {
      if (!current) return;
      if (result.ok) setSeries(result.data);
      else setNumbersFailed(true);
    });
    return () => {
      current = false;
    };
  }, [period]);

  // Typing an account waits for a pause, so it isn't a request per keystroke.
  const [accountQuery, setAccountQuery] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setAccountQuery(account.trim()), 300);
    return () => clearTimeout(timer);
  }, [account]);

  const filterQuery = () => {
    const query = new URLSearchParams({ period });
    if (type) query.set('type', type);
    if (status) query.set('status', status);
    if (provider) query.set('provider', provider);
    if (accountQuery) query.set('account', accountQuery);
    return query;
  };
  const query = filterQuery().toString();
  type Page = { rows: OpsMailRow[]; nextCursor: string | null };
  useEffect(() => {
    let current = true;
    void apiFetch<Page>(`/v1/ops/email/messages?${query}`).then((result) => {
      if (!current) return;
      setListFailed(!result.ok);
      if (!result.ok) return;
      setRows(result.data.rows);
      setCursor(result.data.nextCursor);
    });
    return () => {
      current = false;
    };
  }, [query]);
  const showMore = async (after: string) => {
    const asked = query;
    const result = await apiFetch<Page>(
      `/v1/ops/email/messages?${asked}&cursor=${encodeURIComponent(after)}`,
    );
    if (asked !== latestQuery.current) return;
    setListFailed(!result.ok);
    if (!result.ok) return;
    setRows((current) => [...(current ?? []), ...result.data.rows]);
    setCursor(result.data.nextCursor);
  };
  const latestQuery = useRef(query);
  useEffect(() => {
    latestQuery.current = query;
  }, [query]);
  const [exportFailed, setExportFailed] = useState(false);

  const tile = (label: string, key: keyof OpsMailSummary['totals']) => {
    const total = summary?.totals[key];
    return (
      <Tile
        key={key}
        label={label}
        value={total ? number.format(total.count) : '–'}
        previous={total ? change(total.changePct, versus) : ''}
      />
    );
  };
  const download = (kind: 'summary' | 'messages') =>
    void apiDownload(
      `/v1/ops/email/export.csv?${query}&kind=${kind}`,
      `tipme-email-${kind}-${period}.csv`,
    ).then((result) => setExportFailed(!result.ok));
  const hourly = period === 'today';
  const label = (date: string) => (hourly ? `${date.slice(11)}:00` : date);

  return (
    <>
      <h1>Email</h1>
      <p>Every email TipMe sends, without going to the provider.</p>
      <div className="ops-filters">
        <div className="tm-field">
          <label htmlFor={`${id}-period`}>Period</label>
          <select
            id={`${id}-period`}
            className="tm-input"
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
          >
            {Object.entries(PERIODS).map(([value, { label: text }]) => (
              <option key={value} value={value}>
                {text}
              </option>
            ))}
          </select>
        </div>
      </div>
      {numbersFailed && (
        <Notice tone="error" title="Couldn’t load the numbers">
          These may be out of date. Please refresh the page.
        </Notice>
      )}
      <div className="ops-tiles">
        {tile('Sent', 'sent')}
        {tile('Delivered', 'delivered')}
        {tile('Bounced', 'bounced')}
        {tile('Spam complaints', 'complained')}
        {tile('Opened', 'opened')}
        {tile('Clicked', 'clicked')}
        {tile('Failed', 'failed')}
      </div>
      {summary && (
        <p>
          Delivery rate {rate(summary.rates.delivery)}, open rate{' '}
          {rate(summary.rates.open)}, click rate {rate(summary.rates.click)}.
          Opens are approximate: some mail apps load images automatically.
          {summary.queueAgeSeconds > 0 &&
            ` The oldest waiting email has been queued for ${summary.queueAgeSeconds} seconds.`}
        </p>
      )}
      <Card className="settings-section">
        <LineChart
          title={`Emails sent (faint line: ${versus})`}
          unit="Emails"
          points={series.map((p) => ({ label: label(p.date), value: p.sent }))}
          {...(hourly
            ? {}
            : {
                previous: series.map((p) => ({
                  label: label(p.date),
                  value: p.previousSent,
                })),
              })}
        />
      </Card>
      <Card className="settings-section">
        <LineChart
          title="Emails that bounced or failed"
          unit="Emails"
          points={series.map((p) => ({
            label: label(p.date),
            value: p.bounced + p.failed,
          }))}
        />
      </Card>
      {summary && summary.byType.length > 0 && (
        <Card className="settings-section">
          <h2>By type</h2>
          <ul className="ops-list">
            {summary.byType.map((row) => (
              <li key={row.type}>
                {typeLabel(row.type)}: {number.format(row.sent)} (
                {number.format(row.previous)} {versus})
              </li>
            ))}
          </ul>
          <h2>By category</h2>
          <ul className="ops-list">
            {summary.byCategory.map((row) => (
              <li key={row.category}>
                {typeLabel(row.category)}: {number.format(row.sent)} (
                {number.format(row.previous)} {versus})
              </li>
            ))}
          </ul>
          <h2>By provider</h2>
          <ul className="ops-list">
            {summary.byProvider.map((row) => (
              <li key={row.provider}>
                {row.provider}: {number.format(row.sent)} (
                {number.format(row.previous)} {versus})
              </li>
            ))}
          </ul>
        </Card>
      )}
      <h2>Every email created in this period</h2>
      <div className="ops-filters">
        <div className="tm-field">
          <label htmlFor={`${id}-type`}>Type</label>
          <select
            id={`${id}-type`}
            className="tm-input"
            value={type}
            onChange={(e) => setType(e.target.value)}
          >
            <option value="">All</option>
            {[
              ...new Set([...(summary?.types ?? []), ...(type ? [type] : [])]),
            ].map((value) => (
              <option key={value} value={value}>
                {typeLabel(value)}
              </option>
            ))}
          </select>
        </div>
        <div className="tm-field">
          <label htmlFor={`${id}-status`}>Status</label>
          <select
            id={`${id}-status`}
            className="tm-input"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="">All</option>
            {STATUSES.map((value) => (
              <option key={value} value={value}>
                {typeLabel(value)}
              </option>
            ))}
          </select>
        </div>
        <div className="tm-field">
          <label htmlFor={`${id}-provider`}>Provider</label>
          <select
            id={`${id}-provider`}
            className="tm-input"
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
          >
            <option value="">All</option>
            {summary?.byProvider.map((p) => (
              <option key={p.provider} value={p.provider}>
                {p.provider}
              </option>
            ))}
          </select>
        </div>
        <div className="tm-field">
          <label htmlFor={`${id}-account`}>Account (handle or user id)</label>
          <input
            id={`${id}-account`}
            className="tm-input"
            value={account}
            maxLength={64}
            onChange={(e) => setAccount(e.target.value)}
          />
        </div>
      </div>
      <div className="ops-actions">
        <Button variant="secondary" onClick={() => download('messages')}>
          Export emails (CSV)
        </Button>
        <Button variant="secondary" onClick={() => download('summary')}>
          Export numbers (CSV)
        </Button>
      </div>
      {exportFailed && (
        <Notice tone="error" title="The export didn’t finish">
          There may be too many emails. Choose a shorter period or add a filter.
        </Notice>
      )}
      {listFailed && (
        <Notice tone="error" title="Couldn’t load the emails">
          This list may be out of date. Please try again.
        </Notice>
      )}
      {chosen && <MessageDrawer key={chosen.id} row={chosen} />}
      {rows === null ? (
        <Skeleton />
      ) : rows.length === 0 ? (
        <EmptyState title="No emails">
          Nothing matches this period and these filters.
        </EmptyState>
      ) : (
        <ul className="ops-list">
          {rows.map((row) => (
            <li key={row.id} className="ops-row">
              <Button variant="quiet" onClick={() => setChosen(row)}>
                {typeLabel(row.type)} to {row.toHint}
              </Button>
              <p>
                {when(row.createdAt)}
                {row.handle ? `, @${row.handle}` : ''}, {typeLabel(row.status)}
                {row.lastEvent
                  ? `. Last: ${EVENT_LABELS[row.lastEvent] ?? row.lastEvent}`
                  : ''}
                {row.provider ? ` (${row.provider})` : ''}
              </p>
            </li>
          ))}
        </ul>
      )}
      {cursor && (
        <Button variant="secondary" onClick={() => void showMore(cursor)}>
          Show more
        </Button>
      )}
    </>
  );
}
