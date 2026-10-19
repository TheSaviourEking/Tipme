'use client';
import Link from 'next/link';
import { useEffect, useId, useState } from 'react';
import type { OpsIssue } from '@tipme/contracts';
import { Badge, Button, EmptyState, Notice, Skeleton } from '@tipme/ui';
import { age, ISSUE_KIND_LABELS, SEVERITY_LABELS } from '@/lib/ops-client';
import { apiFetch } from '@/lib/session-client';

type Filters = { status: string; severity: string };

const query = (filters: Filters, cursor?: string) => {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.severity) params.set('severity', filters.severity);
  if (cursor) params.set('cursor', cursor);
  return `/v1/ops/issues?${params.toString()}`;
};

/** Everything that needs a person, newest first; refreshed every 30 seconds while open. */
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

  useEffect(() => {
    const load = () =>
      void apiFetch<OpsIssue[]>(query(filters)).then((result) => {
        setNow(Date.now());
        if (!result.ok) return setFailed(true);
        setFailed(false);
        setIssues(result.data);
        setMore(result.data.length === 50);
      });
    load();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, 30_000);
    return () => clearInterval(timer);
  }, [filters]);

  const loadMore = async () => {
    const last = issues?.at(-1);
    if (!last) return;
    const result = await apiFetch<OpsIssue[]>(query(filters, last.id));
    if (result.ok) {
      setIssues([...(issues ?? []), ...result.data]);
      setMore(result.data.length === 50);
    }
  };

  return (
    <section className="dashboard-section" aria-labelledby={`${id}-title`}>
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
        <Notice tone="error" title="Couldn’t load the issues">
          Check your connection; the list retries every 30 seconds.
        </Notice>
      )}
      {!issues && !failed && <Skeleton label="Loading issues" />}
      {issues?.length === 0 && (
        <EmptyState title="Nothing needs you">
          No issues match these filters.
        </EmptyState>
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
