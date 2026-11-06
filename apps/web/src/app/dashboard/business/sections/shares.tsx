'use client';
import { useCallback, useEffect, useId, useState } from 'react';
import {
  SHARE_OPTIONS_BPS,
  type BusinessDetail,
  type BusinessShareRow,
  type ShareBps,
} from '@tipme/contracts';
import { lagosDateOf, shareStartsAt } from '@tipme/domain';
import { Button, Choice, Skeleton, StateLine } from '@tipme/ui';
import {
  answerSuggestedShare,
  loadBusinessShares,
  proposeShare,
  shareDate,
  shareProblem,
  withdrawShare,
} from '@/lib/business/shares-api';

// Business PR R2-C1, board section 3: the business proposes a split; nothing changes until the
// staff member accepts. The business reads only Accepted, Pending or No change: never "declined".

/** "90/10": staff keeps / business takes. */
const splitLabel = (bps: number) => `${100 - bps / 100}/${bps / 100}`;

function rowLine(row: BusinessShareRow): string {
  const from = row.startsOn ? shareDate(row.startsOn) : '';
  switch (row.state) {
    case 'in_force':
      return row.businessPercent === 0
        ? `Accepted: they keep all their tips, from ${from}.`
        : `Accepted: the business takes ${row.businessPercent}%, from ${from}.`;
    case 'pending':
      return row.proposedBy === 'member'
        ? `They suggest the business takes ${row.businessPercent}%, from ${from}.`
        : `Pending: the business takes ${row.businessPercent}%, from ${from}, if they accept.`;
    case 'no_change':
      return 'No change: they keep all their tips here.';
  }
}

function ShareRow({
  businessId,
  row,
  onChanged,
}: {
  businessId: string;
  row: BusinessShareRow;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const run = async (step: () => Promise<{ ok: boolean; code?: string }>) => {
    setBusy(true);
    setProblem(null);
    const result = await step();
    setBusy(false);
    if (result.ok) onChanged();
    else setProblem(shareProblem(result.code ?? ''));
  };
  const id = row.agreementId;
  return (
    <li className="business-share" data-testid={`share-${row.memberId}`}>
      <p className="business-share__name">{row.shownName}</p>
      <p className="tm-hint">{rowLine(row)}</p>
      {id && row.state === 'pending' && (
        <div className="business-share__actions">
          {row.proposedBy === 'member' ? (
            <>
              <Button
                disabled={busy}
                onClick={() =>
                  void run(() =>
                    answerSuggestedShare(businessId, id, 'accept').then((r) =>
                      r.ok ? { ok: true } : { ok: false, code: r.code },
                    ),
                  )
                }
              >
                Accept {row.shownName}’s split
              </Button>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() =>
                  void run(() =>
                    answerSuggestedShare(businessId, id, 'decline').then((r) =>
                      r.ok ? { ok: true } : { ok: false, code: r.code },
                    ),
                  )
                }
              >
                Keep today’s split
              </Button>
            </>
          ) : (
            <Button
              variant="quiet"
              disabled={busy}
              onClick={() =>
                void run(() =>
                  withdrawShare(businessId, id).then((r) =>
                    r.ok ? { ok: true } : { ok: false, code: r.code },
                  ),
                )
              }
            >
              Withdraw proposal
            </Button>
          )}
        </div>
      )}
      {problem && <StateLine tone="error">{problem}</StateLine>}
    </li>
  );
}

export function SharesSection({ business }: { business: BusinessDetail }) {
  const toId = useId();
  const [rows, setRows] = useState<BusinessShareRow[] | null | undefined>(
    undefined,
  );
  const [memberId, setMemberId] = useState('');
  const [bps, setBps] = useState<ShareBps>(1000);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{
    tone: 'status' | 'error';
    text: string;
  } | null>(null);

  const load = useCallback(() => {
    void loadBusinessShares(business.id).then((loaded) =>
      setRows(loaded.ok && Array.isArray(loaded.data) ? loaded.data : null),
    );
  }, [business.id]);
  useEffect(load, [load]);

  if (rows === undefined) return <Skeleton label="Loading shares of tips" />;
  if (rows === null)
    return (
      <p className="tm-hint">Sharing tips with your business isn’t open yet.</p>
    );
  if (rows.length === 0)
    return (
      <p className="tm-hint">
        When people join your team, you can propose a share of their tips here.
      </p>
    );

  const chosen = rows.find((row) => row.memberId === memberId) ?? rows[0]!;
  const from = shareDate(lagosDateOf(shareStartsAt(new Date())));
  const send = async () => {
    setBusy(true);
    setResult(null);
    const sent = await proposeShare(business.id, chosen.memberId, bps);
    setBusy(false);
    if (sent.ok) {
      setResult({
        tone: 'status',
        text: `Sent to ${chosen.shownName}. Nothing changes unless they accept.`,
      });
      load();
    } else setResult({ tone: 'error', text: shareProblem(sent.code) });
  };

  return (
    <div className="business-shares">
      <ul className="business-shares__list">
        {rows.map((row) => (
          <ShareRow
            key={row.memberId}
            businessId={business.id}
            row={row}
            onChanged={load}
          />
        ))}
      </ul>
      <form
        className="business-shares__propose"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <h3>Propose a split</h3>
        <fieldset className="business-shares__options">
          <legend>Staff keeps / business takes</legend>
          {SHARE_OPTIONS_BPS.map((option) => (
            <Choice
              key={option}
              name="share-split"
              value={option}
              checked={bps === option}
              onChange={() => setBps(option)}
            >
              {splitLabel(option)}
            </Choice>
          ))}
        </fieldset>
        <div className="tm-field">
          <label htmlFor={toId}>To</label>
          <select
            id={toId}
            className="tm-input"
            value={chosen.memberId}
            onChange={(event) => setMemberId(event.target.value)}
          >
            {rows.map((row) => (
              <option key={row.memberId} value={row.memberId}>
                {row.shownName}
              </option>
            ))}
          </select>
        </div>
        <p className="tm-hint">From: {from}</p>
        <p className="tm-hint">
          The share is of what they receive after TipMe’s fee, at most half.
          Nothing changes until they accept, and the split can change at most
          once a month. Tips through their own page, outside the business, are
          never shared.
        </p>
        <Button type="submit" disabled={busy}>
          Send to {chosen.shownName}
        </Button>
        {result && <StateLine tone={result.tone}>{result.text}</StateLine>}
      </form>
    </div>
  );
}
