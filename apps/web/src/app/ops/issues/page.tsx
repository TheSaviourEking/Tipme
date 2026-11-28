'use client';
import Link from 'next/link';
import {
  useCallback,
  useEffect,
  useId,
  useReducer,
  useRef,
  useState,
} from 'react';
import type { LiveEventType, OpsIssue } from '@tipme/contracts';
import { Badge, Button, EmptyWell, Skeleton, Slip } from '@tipme/ui';
import { age, ISSUE_KIND_LABELS, SEVERITY_LABELS } from '@/lib/ops-client';
import { opsFetch } from '@/lib/ops-staff-api';
import type { LiveRead } from '@/lib/live-refetch';
import {
  INITIAL_ISSUES_LIST,
  createFirstPageReads,
  issuesListReducer,
  type FirstPageMode,
} from '@/lib/issues-list';
import { ownTimerRuns } from '@/lib/own-timer';
import { useLiveEvents, useLiveStatus } from '@/components/live/live-provider';

const ISSUES_CHANGED: readonly LiveEventType[] = ['ops.issues.changed'];
const NO_SIGNALS: readonly LiveEventType[] = [];

type Filters = { status: string; severity: string };

const query = (filters: Filters, cursor?: string) => {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.severity) params.set('severity', filters.severity);
  if (cursor) params.set('cursor', cursor);
  return `/v1/ops/issues?${params.toString()}`;
};

/**
 * Everything that needs a person, newest first. With live updates, the first page reads again on
 * `ops.issues.changed`; without them (or while the stream is off), every 30 seconds while open.
 */
export default function IssuesPage() {
  const id = useId();
  const [filters, setFilters] = useState<Filters>({
    status: 'open',
    severity: '',
  });
  // Every answer applies to the list as it is when it lands (src/lib/issues-list.ts): a first
  // page and a "Show more" in flight together never drop or mix each other's rows.
  const [list, dispatch] = useReducer(
    issuesListReducer<OpsIssue>,
    INITIAL_ISSUES_LIST,
  );
  const { issues, more, newChanges, failed } = list;
  const [now, setNow] = useState(0);
  const filtersNow = useRef(filters);
  useEffect(() => {
    filtersNow.current = filters;
  });
  const [reads] = useState(createFirstPageReads);

  /**
   * The first page with the current filters. An older answer never replaces a newer one, and a
   * pending replace (filters, "New changes: show") is never downgraded by a later signal read.
   */
  const firstPage = useCallback(
    // `live`: the stream started this read (not the person), so it is not staff activity.
    async (mode: FirstPageMode, live?: LiveRead) => {
      const ticket = reads.start(mode);
      const result = await opsFetch<OpsIssue[]>(
        query(filtersNow.current),
        live,
      );
      const apply = reads.land(ticket, result.ok);
      if (!apply) return;
      setNow(Date.now());
      if (!result.ok) dispatch({ type: 'firstFailed' });
      else dispatch({ type: 'first', rows: result.data, mode: apply });
    },
    [reads],
  );

  // A signal means something changed; with more pages showing it offers the change instead of
  // replacing rows under the reader (the base design's Tips-page rule).
  useLiveEvents(ISSUES_CHANGED, (live) => firstPage('signal', live), {
    resync: false,
  });
  // A resync (the ready, the fallback poll, the tab coming back) only says "check".
  useLiveEvents(NO_SIGNALS, (live) => firstPage('check', live));

  useEffect(() => {
    void firstPage('replace');
  }, [filters, firstPage]);

  // No stream covering the page (live updates off, or no EventSource): today's 30 s refresh.
  const status = useLiveStatus();
  const ownTimer = ownTimerRuns(status);
  useEffect(() => {
    if (!ownTimer) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void firstPage('replace');
    }, 30_000);
    return () => clearInterval(timer);
  }, [filters, firstPage, ownTimer]);

  const loadMore = async () => {
    const last = issues?.at(-1);
    if (!last) return;
    const generation = list.generation;
    const result = await opsFetch<OpsIssue[]>(query(filters, last.id));
    // Dropped by the reducer if a newer first page replaced the list meanwhile, or if this row is
    // no longer last (a double-click already added the page).
    if (result.ok)
      dispatch({ type: 'more', rows: result.data, generation, after: last.id });
  };

  return (
    <section
      className="dashboard-section ops-page-body"
      aria-labelledby={`${id}-title`}
    >
      <h1 id={`${id}-title`}>Issues</h1>
      <div className="ops-filters">
        <div className="tm-field">
          <label htmlFor={`${id}-status`}>Status</label>
          <select
            id={`${id}-status`}
            className="tm-input"
            value={filters.status}
            onChange={(e) => setFilters({ ...filters, status: e.target.value })}
          >
            <option value="open">Open</option>
            <option value="resolved">Resolved</option>
            <option value="">All</option>
          </select>
        </div>
        <div className="tm-field">
          <label htmlFor={`${id}-severity`}>Kind of problem</label>
          <select
            id={`${id}-severity`}
            className="tm-input"
            value={filters.severity}
            onChange={(e) =>
              setFilters({ ...filters, severity: e.target.value })
            }
          >
            <option value="">All</option>
            <option value="money">Money</option>
            <option value="account">Account</option>
            <option value="info">Info</option>
          </select>
        </div>
      </div>
      {failed && (
        <Slip dense tone="error" title="Couldn’t load the issues">
          {ownTimer || status === 'polling'
            ? 'Check your connection; the list retries every 30 seconds.'
            : 'Check your connection; the list tries again when something changes.'}
        </Slip>
      )}
      {newChanges && (
        <p>
          <Button variant="quiet" onClick={() => void firstPage('replace')}>
            New changes: show
          </Button>
        </p>
      )}
      {!issues && !failed && <Skeleton label="Loading issues" />}
      {issues?.length === 0 && (
        <EmptyWell title="Nothing needs you">
          <p>No issues match these filters.</p>
        </EmptyWell>
      )}
      {issues && issues.length > 0 && (
        <ul className="ops-list">
          {issues.map((issue) => (
            <li key={issue.id}>
              <Link href={`/ops/issues/${issue.id}`} className="ops-row">
                <span className="ops-row__head">
                  <Badge
                    className={`ops-severity ops-severity--${issue.severity}`}
                  >
                    {SEVERITY_LABELS[issue.severity]}
                  </Badge>
                  <strong>{ISSUE_KIND_LABELS[issue.kind] ?? issue.kind}</strong>
                  {/* Priority support: a Pro member's request, sorted first. */}
                  {issue.priority && (
                    <Badge className="ops-priority">Pro · answer first</Badge>
                  )}
                  <span className="tm-hint">
                    {issue.status === 'resolved' ? 'Resolved · ' : ''}
                    {age(issue.openedAt, now)}
                  </span>
                </span>
                <span>{issue.summary}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {more && (
        <Button variant="secondary" onClick={() => void loadMore()}>
          Show more
        </Button>
      )}
    </section>
  );
}
