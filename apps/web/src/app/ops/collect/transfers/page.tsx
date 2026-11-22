'use client';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useId, useState } from 'react';
import {
  OPS_COLLECT_TRANSFER_STATUSES,
  type OpsCollectSameBank,
  type OpsCollectTransfer,
} from '@tipme/contracts';
import { Badge, Card, EmptyWell, Skeleton } from '@tipme/ui';
import { CollectAct } from '@/components/ops/collect-act';
import { LoadFailed } from '@/components/dashboard/load-failed';
import { Money } from '@/components/money';
import {
  REVIEW_REASON_WORDS,
  TRANSFER_KIND_WORDS,
  TRANSFER_STATUS_WORDS,
} from '@/lib/collect-ops-words';
import { can, useOpsAccess, when } from '@/lib/ops-client';
import { opsFetch } from '@/lib/ops-staff-api';

/**
 * The collect transfer queue by state (spec §9), with its actions: send a transfer never sent to
 * review (one person, it only stops money); retry one in review, or record one paid once the
 * partner's read-back by its group shows it paid (each a second person). Then the recipients a
 * shared bank account holds, to clear once checked.
 */
export default function CollectTransfersPage() {
  return (
    <Suspense fallback={<Skeleton label="Loading transfers" />}>
      <Transfers />
    </Suspense>
  );
}

function Transfers() {
  const id = useId();
  const access = useOpsAccess();
  const manage = can(access, 'collect.manage');
  const initial = useSearchParams().get('status') ?? '';
  const [status, setStatus] = useState(
    (OPS_COLLECT_TRANSFER_STATUSES as readonly string[]).includes(initial)
      ? initial
      : '',
  );
  const [rows, setRows] = useState<OpsCollectTransfer[] | null>(null);
  const [sameBank, setSameBank] = useState<OpsCollectSameBank[] | null>(null);
  const [failed, setFailed] = useState(false);
  const read = useCallback(
    () =>
      Promise.all([
        opsFetch<OpsCollectTransfer[]>(
          `/v1/ops/collect/transfers${status ? `?status=${status}` : ''}`,
        ),
        opsFetch<OpsCollectSameBank[]>('/v1/ops/collect/same-bank'),
      ]),
    [status],
  );
  const show = useCallback(
    ([transfers, held]: Awaited<ReturnType<typeof read>>) => {
      setFailed(!transfers.ok || !held.ok);
      if (transfers.ok) setRows(transfers.data);
      if (held.ok) setSameBank(held.data);
    },
    [],
  );
  const load = useCallback(async () => show(await read()), [read, show]);
  useEffect(() => {
    void read().then(show);
  }, [read, show]);

  return (
    <section className="dashboard-section ops-page-body">
      <h1>Transfers</h1>
      <div className="ops-filters">
        <div className="tm-field">
          <label htmlFor={`${id}-status`}>State</label>
          <select
            id={`${id}-status`}
            className="tm-input"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="">All</option>
            {OPS_COLLECT_TRANSFER_STATUSES.map((value) => (
              <option key={value} value={value}>
                {TRANSFER_STATUS_WORDS[value]}
              </option>
            ))}
          </select>
        </div>
      </div>
      {failed && (
        <LoadFailed dense title="Couldn’t load the transfers" onRetry={load}>
          Your role may not include them, or the connection failed.
        </LoadFailed>
      )}
      {!rows && !failed && <Skeleton label="Loading transfers" />}
      {rows?.length === 0 && (
        <EmptyWell title="No transfers">
          <p>No transfer is in this state.</p>
        </EmptyWell>
      )}
      {rows && rows.length > 0 && (
        <ul className="ops-list" aria-label="Collect transfers">
          {rows.map((row) => (
            <li key={row.id} className="ops-row" data-testid="collect-transfer">
              <span className="ops-row__head">
                <Badge>{TRANSFER_STATUS_WORDS[row.status]}</Badge>
                <strong>{row.handle ? `@${row.handle}` : 'No page'}</strong>
                <Money minor={row.amountMinor} />
                <span className="tm-hint">{TRANSFER_KIND_WORDS[row.kind]}</span>
              </span>
              <span className="tm-hint">
                {row.status === 'review' && row.reviewReason
                  ? `In review: ${REVIEW_REASON_WORDS[row.reviewReason] ?? row.reviewReason}${row.refused ? ' (the partner refused it; nothing moved)' : ''}. `
                  : ''}
                Group <span className="ops-mono">{row.group}</span>
                {row.bankLast4 ? ` · bank ending ${row.bankLast4}` : ''} ·{' '}
                {row.attempts} attempt{row.attempts === 1 ? '' : 's'} · since{' '}
                {when(row.createdAt)}
              </span>
              {manage && <TransferActions row={row} onDone={load} />}
            </li>
          ))}
        </ul>
      )}
      <Card className="settings-section">
        <h2>Shared bank accounts</h2>
        <p className="tm-hint">
          A recipient who added a bank account another recipient already uses:
          their transfers wait until staff check it and clear the hold.
        </p>
        {sameBank?.length === 0 && (
          <EmptyWell title="None held" headingLevel={3}>
            <p>No recipient is held for a shared bank account.</p>
          </EmptyWell>
        )}
        {sameBank && sameBank.length > 0 && (
          <ul className="ops-list" aria-label="Shared bank account holds">
            {sameBank.map((row) => (
              <li
                key={row.profileId}
                className="ops-row"
                data-testid="same-bank"
              >
                <strong>{row.handle ? `@${row.handle}` : 'No page'}</strong>
                <span>
                  {row.heldTransfers} transfer
                  {row.heldTransfers === 1 ? '' : 's'} held (
                  <Money minor={row.heldMinor} />) · {row.openIssues} open issue
                  {row.openIssues === 1 ? '' : 's'}
                  {row.since ? ` · since ${when(row.since)}` : ''}
                </span>
                {manage && (
                  <CollectAct
                    path={`/v1/ops/collect/same-bank/${row.profileId}/clear`}
                    open="Clear the hold…"
                    field="What you checked about the shared account"
                    submit="Ask to clear"
                    done="The hold is cleared: its transfers are back in the queue, and the recipient is told."
                    meanwhile="Their transfers stay held."
                    onDone={load}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </section>
  );
}

function TransferActions({
  row,
  onDone,
}: {
  row: OpsCollectTransfer;
  onDone: () => Promise<void>;
}) {
  const base = `/v1/ops/collect/transfers/${row.id}`;
  if ((row.status === 'waiting' || row.status === 'ready') && !row.sentAt)
    return (
      <div className="ops-actions">
        <CollectAct
          path={`${base}/review`}
          open="Send to review…"
          field="Why hold this transfer?"
          submit="Hold it"
          done="Held in review. Nothing is sent until it is retried."
          onDone={onDone}
        />
      </div>
    );
  if (row.status !== 'review') return null;
  const retry = row.reviewReason === 'provider' || row.reviewReason === 'staff';
  if (!retry) return null;
  return (
    <div className="ops-actions">
      <CollectAct
        path={`${base}/retry`}
        open="Retry…"
        field="What you checked in the partner dashboard for its group"
        submit="Ask to retry"
        done="Back in the queue: it is sent again with the same key."
        meanwhile="It stays in review."
        onDone={onDone}
      />
      {row.reviewReason === 'provider' && (
        <CollectAct
          path={`${base}/record-paid`}
          open="Record as paid…"
          field="What the partner dashboard shows for its group"
          submit="Ask to record it"
          done="Recorded as paid, as the partner shows it."
          meanwhile="It stays in review; nothing is booked."
          onDone={onDone}
        />
      )}
    </div>
  );
}
