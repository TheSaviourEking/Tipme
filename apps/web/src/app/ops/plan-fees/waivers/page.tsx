'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import type { OpsFeeWaiverRule, OpsFeeWaivers } from '@tipme/contracts';
import { FEE_WAIVER_STAFF_COPY as C } from '@tipme/contracts/copy';
import { Card, EmptyWell, Skeleton, Slip } from '@tipme/ui';
import { WaiverCost } from '@/components/ops/account-fee-waivers';
import { LoadFailed } from '@/components/dashboard/load-failed';
import { untilLabel } from '@/lib/fee-waiver-dates';
import { loadFeeWaivers, staffWord, when } from '@/lib/ops-client';

/** Who a rule is for: every account of a kind, a page's handle, or a business's name. */
function whoWords(rule: OpsFeeWaiverRule): string {
  if (rule.scope === 'kind') return C.allOf[rule.kind];
  if (rule.handle !== null) return `@${rule.handle}`;
  return rule.businessName ?? C.unknownAccount;
}

/** A row that only ends a waiver (an account's `inherit`, a kind-wide `account`) says so. */
const endsAWaiver = (rule: OpsFeeWaiverRule) =>
  rule.payer === 'inherit' ||
  (rule.scope === 'kind' && rule.payer === 'account');

function payerWords(rule: OpsFeeWaiverRule): string {
  if (rule.payer === 'tipme') return C.tipmePays(null);
  return endsAWaiver(rule) ? C.endsWaiver : C.optedOut;
}

function endWords(rule: OpsFeeWaiverRule): string {
  if (endsAWaiver(rule)) return C.noFee;
  return rule.endsAt === null ? C.noEnd : untilLabel(rule.endsAt);
}

const setByWords = (rule: OpsFeeWaiverRule) =>
  rule.setBy === null ? C.carriedOver : staffWord(rule.setBy);

const approvedByWords = (rule: OpsFeeWaiverRule) =>
  rule.approvedBy !== null
    ? staffWord(rule.approvedBy)
    : rule.setBy === null
      ? C.noFee
      : C.alone;

function Rules({
  title,
  empty,
  rules,
  upcoming,
}: {
  title: string;
  empty: string;
  rules: OpsFeeWaiverRule[];
  upcoming: boolean;
}) {
  const headingId = `fee-waivers-${upcoming ? 'upcoming' : 'in-force'}`;
  const cols = C.columns;
  return (
    <Card className="settings-section ops-section">
      <section aria-labelledby={headingId}>
        <h2 id={headingId}>{title}</h2>
        {rules.length === 0 ? (
          <EmptyWell title={empty} headingLevel={3}>
            <p>{upcoming ? C.noneUpcomingBody : C.hint}</p>
          </EmptyWell>
        ) : (
          <div
            className="ops-table-wrap"
            role="region"
            aria-label={`${title}: every rule`}
            tabIndex={0}
          >
            <table className="ops-table ops-table--stack">
              <thead>
                <tr>
                  <th scope="col">{cols.who}</th>
                  <th scope="col">{cols.fee}</th>
                  <th scope="col">{cols.payer}</th>
                  {upcoming && <th scope="col">{cols.starts}</th>}
                  <th scope="col">{cols.ends}</th>
                  <th scope="col">{cols.setBy}</th>
                  <th scope="col">{cols.approvedBy}</th>
                  {!upcoming && <th scope="col">{cols.cost}</th>}
                  <th scope="col">{cols.reason}</th>
                </tr>
              </thead>
              <tbody>
                {rules.map((rule) => (
                  <tr key={rule.id}>
                    <td data-label={cols.who}>
                      {whoWords(rule)}
                      {rule.kind === 'giving' && (
                        <>
                          {' '}
                          <span className="tm-hint">{C.notLive}</span>
                        </>
                      )}
                    </td>
                    <td data-label={cols.fee}>{C.fees[rule.fee]}</td>
                    <td data-label={cols.payer}>{payerWords(rule)}</td>
                    {upcoming && (
                      <td data-label={cols.starts}>{when(rule.startsAt)}</td>
                    )}
                    <td data-label={cols.ends}>{endWords(rule)}</td>
                    <td data-label={cols.setBy}>{setByWords(rule)}</td>
                    <td data-label={cols.approvedBy}>
                      {approvedByWords(rule)}
                    </td>
                    {!upcoming && (
                      <td data-label={cols.cost}>
                        <WaiverCost cost={rule.cost} />
                      </td>
                    )}
                    <td data-label={cols.reason}>{rule.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </Card>
  );
}

/**
 * Fee waivers (spec 2026-11-23 §6): every rule in force or upcoming, with its scope, end date, who
 * set it, who approved it and its cost so far, as two figures never added together.
 */
export default function FeeWaiversPage() {
  const [state, setState] = useState<OpsFeeWaivers | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    const result = await loadFeeWaivers();
    if (!result.ok) return setFailed(true);
    setFailed(false);
    setState(result.data);
  }, []);
  useEffect(() => {
    void loadFeeWaivers().then((result) => {
      if (!result.ok) return setFailed(true);
      setState(result.data);
    });
  }, []);

  return (
    <section className="dashboard-section ops-page-body">
      <p>
        <Link href="/ops/plan-fees">{C.backToFees}</Link>
      </p>
      <h1>{C.listTitle}</h1>
      <p className="tm-hint">{C.listHint}</p>
      {failed ? (
        <LoadFailed dense title="Couldn’t load the waivers" onRetry={load}>
          Your role may not include them, or the connection failed.
        </LoadFailed>
      ) : !state ? (
        <Skeleton label="Loading the waivers" />
      ) : (
        <>
          {state.tipWaiversPaused && (
            <Slip dense tone="waiting" title={C.pausedTitle}>
              {C.pausedBody}
            </Slip>
          )}
          {state.waitingRequestIds.length > 0 && (
            <Slip dense tone="waiting" title="Waiting for a second person">
              {C.waiting(state.waitingRequestIds.length)}{' '}
              <Link href="/ops/approvals">See it in Approvals</Link>
            </Slip>
          )}
          <Rules
            title={C.inForce}
            empty={C.noneInForce}
            rules={state.inForce}
            upcoming={false}
          />
          <Rules
            title={C.upcoming}
            empty={C.noneUpcoming}
            rules={state.upcoming}
            upcoming
          />
        </>
      )}
    </section>
  );
}
