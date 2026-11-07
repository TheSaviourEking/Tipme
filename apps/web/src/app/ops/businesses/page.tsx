'use client';
import Link from 'next/link';
import { useEffect, useId, useState } from 'react';
import type { OpsBusinessRow } from '@tipme/contracts';
import { Badge, EmptyWell, Skeleton, Slip } from '@tipme/ui';
import {
  listBusinesses,
  OPS_BUSINESS_FILTERS,
  OPS_BUSINESS_STATUS_WORDS,
} from '@/lib/business/ops-api';
import { when } from '@/lib/ops-client';

/**
 * TipMe for businesses (PR B2): every business, newest first, with its contact masked. Staff open
 * one to verify, pause or restore it; "Waiting" is the default, as those need someone.
 */
export default function OpsBusinessesPage() {
  const id = useId();
  const [status, setStatus] = useState<string>('pending');
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState<OpsBusinessRow[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let current = true;
    const timer = setTimeout(
      () =>
        void listBusinesses({ status, q: search }).then((result) => {
          if (!current) return;
          setFailed(!result.ok);
          setRows(result.ok ? result.data : null);
        }),
      search ? 250 : 0,
    );
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [status, search]);

  return (
    <section className="dashboard-section" aria-labelledby={`${id}-title`}>
      <h1 id={`${id}-title`}>Businesses</h1>
      <p className="tm-hint">
        Contacts are hidden. Open a business to reveal them, with a reason.
      </p>
      <div className="ops-filters">
        <div className="tm-field">
          <label htmlFor={`${id}-status`}>Show</label>
          <select
            id={`${id}-status`}
            className="tm-input"
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          >
            {OPS_BUSINESS_FILTERS.map((filter) => (
              <option key={filter.label} value={filter.value}>
                {filter.label}
              </option>
            ))}
          </select>
        </div>
        <div className="tm-field">
          <label htmlFor={`${id}-q`}>Name or web address</label>
          <input
            id={`${id}-q`}
            className="tm-input"
            type="search"
            value={search}
            maxLength={80}
            aria-describedby={`${id}-q-hint`}
            onChange={(event) => setSearch(event.target.value)}
          />
          <p id={`${id}-q-hint`} className="tm-hint">
            At least 2 letters. Searches names and web addresses (like
            yellow-chilli), never contact details.
          </p>
        </div>
      </div>
      {failed && (
        <Slip tone="error" title="Couldn’t load the businesses" dense>
          Check your connection and change a filter to try again.
        </Slip>
      )}
      {!rows && !failed && <Skeleton label="Loading businesses" />}
      {rows?.length === 0 && (
        <EmptyWell title="No businesses here">
          {status === 'pending'
            ? 'Nobody is waiting to be verified.'
            : 'No business matches these filters.'}
        </EmptyWell>
      )}
      {rows && rows.length > 0 && (
        <ul className="ops-list" data-testid="ops-businesses">
          {rows.map((row) => (
            <li key={row.id}>
              <Link href={`/ops/businesses/${row.id}`} className="ops-row">
                <span className="ops-row__head">
                  <strong>{row.name}</strong>
                  <Badge className={`ops-business-status--${row.status}`}>
                    {OPS_BUSINESS_STATUS_WORDS[row.status]}
                  </Badge>
                </span>
                <span>
                  /b/{row.slug} · {row.contactEmailMasked}
                  {row.contactPhoneLast4
                    ? ` · phone ending ${row.contactPhoneLast4}`
                    : ''}
                </span>
                <span className="tm-hint">
                  {row.locations}{' '}
                  {row.locations === 1 ? 'location' : 'locations'} ·{' '}
                  {row.members} staff · since {when(row.createdAt)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
