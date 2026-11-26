'use client';
import Link from 'next/link';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { LiveEventType, OpsIssue } from '@tipme/contracts';
import { Badge, Button, EmptyWell, Skeleton, Slip } from '@tipme/ui';
import { age, ISSUE_KIND_LABELS, SEVERITY_LABELS } from '@/lib/ops-client';
import { opsFetch } from '@/lib/ops-staff-api';
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

/** The rows that decide whether the first page changed: order, status and priority. */
const shape = (rows: OpsIssue[]) =>
  rows.map((i) => `${i.id}:${i.status}:${i.priority ? 1 : 0}`).join(',');

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
  const [issues, setIssues] = useState<OpsIssue[] | null>(null);
  const [more, setMore] = useState(false);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(0);
  // More than the first page is showing: a change then offers to show it, rather than replacing
  // the rows under the reader (the base design's Tips-page rule).
  const [extraPages, setExtraPages] = useState(false);
  const [newChanges, setNewChanges] = useState(false);
  const latest = useRef({ filters, issues, extraPages });
  useEffect(() => {
    latest.current = { filters, issues, extraPages };
  });
  const asked = useRef(0);

  /** The first page with the current filters; an older answer never replaces a newer one. */
  const firstPage = useCallback(async () => {
    const mine = ++asked.current;
    const result = await opsFetch<OpsIssue[]>(query(latest.current.filters));
    if (mine !== asked.current) return;
    setNow(Date.now());
    if (!result.ok) return setFailed(true);
    setFailed(false);
    setIssues(result.data);
    setMore(result.data.length === 50);
    setExtraPages(false);
    setNewChanges(false);
  }, []);

  // A signal means something changed: deeper in the list it may not show on the first page.
  useLiveEvents(
    ISSUES_CHANGED,
    async () => {
      if (latest.current.extraPages) setNewChanges(true);
      else await firstPage();
    },
    { resync: false },
  );
  // A resync (the ready, the fallback poll, the tab coming back) only says "check": with more
  // pages showing, offer the change only if the first page differs.
  useLiveEvents(NO_SIGNALS, async () => {
    if (!latest.current.extraPages) return firstPage();
    const shown = latest.current.issues?.slice(0, 50) ?? [];
    const result = await opsFetch<OpsIssue[]>(query(latest.current.filters));
    if (result.ok && shape(result.data) !== shape(shown)) setNewChanges(true);
  });

  useEffect(() => {
    void firstPage();
  }, [filters, firstPage]);

  // No stream covering the page (live updates off, or no EventSource): today's 30 s refresh.
  const status = useLiveStatus();
  const ownTimer = ownTimerRuns(status);
  useEffect(() => {
    if (!ownTimer) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void firstPage();
    }, 30_000);
    return () => clearInterval(timer);
  }, [filters, firstPage, ownTimer]);

  const loadMore = async () => {
    const last = issues?.at(-1);
    if (!last) return;
    const result = await opsFetch<OpsIssue[]>(query(filters, last.id));
    if (result.ok) {
      setIssues([...(issues ?? []), ...result.data]);
      setMore(result.data.length === 50);
      setExtraPages(true);
    }
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
          <Button variant="quiet" onClick={() => void firstPage()}>
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
