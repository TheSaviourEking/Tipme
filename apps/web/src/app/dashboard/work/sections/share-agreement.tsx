'use client';
import { useCallback, useEffect, useId, useState } from 'react';
import {
  SHARE_OPTIONS_BPS,
  SHARE_REPORT_LIMIT,
  SHARE_REPORT_REASONS,
  type MyMembership,
  type ShareAgreementView,
  type ShareBps,
  type ShareReportReason,
} from '@tipme/contracts';
import { Button, Choice, Skeleton, StateLine, TextareaField } from '@tipme/ui';
import {
  acceptShare,
  counterShare,
  declineShare,
  loadMyShares,
  reportBusiness,
  shareDate,
  shareProblem,
} from '@/lib/business/shares-api';

// Business PR R2-C1, board section 3: the staff member decides. Accept, Decline, or suggest another
// split; and report the business to TipMe, which the business is never told about.

const REASON_WORDS: Record<ShareReportReason, string> = {
  pressure: 'I’m being pressured to accept',
  wrong_share: 'The share isn’t what we agreed',
  other: 'Something else',
};

function standing(view: ShareAgreementView): string {
  if (view.state === 'in_force')
    return view.youKeepPercent === 100
      ? 'You keep all your tips here.'
      : `You keep ${view.youKeepPercent}% of what you receive from tips here.`;
  return `From ${shareDate(view.startsOn)}, you keep ${view.youKeepPercent}%.`;
}

function Proposal({
  view,
  onChanged,
}: {
  view: ShareAgreementView;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const takes = 100 - view.youKeepPercent;
  const [bps, setBps] = useState<ShareBps>(
    (SHARE_OPTIONS_BPS.find((option) => option !== takes * 100) ??
      0) as ShareBps,
  );
  const run = async (step: () => Promise<{ ok: boolean; code?: string }>) => {
    setBusy(true);
    setProblem(null);
    const result = await step();
    setBusy(false);
    if (result.ok) onChanged();
    else setProblem(shareProblem(result.code ?? ''));
  };
  const asResult = (r: { ok: boolean; code?: string }) =>
    r.ok ? { ok: true } : { ok: false, code: r.code };

  if (view.proposedBy === 'member')
    return (
      <p className="tm-hint">
        You suggested keeping {view.youKeepPercent}% from{' '}
        {shareDate(view.startsOn)}. Waiting for {view.businessName}.
      </p>
    );
  return (
    <div className="work-share__proposal">
      <p className="work-share__line">
        {view.businessName} asks to keep {takes}% of the tips you get there,
        from {shareDate(view.startsOn)}. You keep{' '}
        <strong>{view.youKeepPercent}%</strong>.
      </p>
      <div className="work-share__actions">
        <Button
          disabled={busy}
          onClick={() =>
            void run(() => acceptShare(view.agreementId).then(asResult))
          }
        >
          Accept
        </Button>
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() =>
            void run(() => declineShare(view.agreementId).then(asResult))
          }
        >
          Decline
        </Button>
        <Button
          variant="quiet"
          disabled={busy}
          aria-expanded={suggesting}
          onClick={() => setSuggesting((open) => !open)}
        >
          Suggest another split
        </Button>
      </div>
      {suggesting && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void run(() => counterShare(view.agreementId, bps).then(asResult));
          }}
        >
          <fieldset className="work-share__options">
            <legend>You keep / business takes</legend>
            {SHARE_OPTIONS_BPS.filter((option) => option !== takes * 100).map(
              (option) => (
                <Choice
                  key={option}
                  name={`counter-${view.agreementId}`}
                  value={option}
                  checked={bps === option}
                  onChange={() => setBps(option)}
                >
                  {`${100 - option / 100}/${option / 100}`}
                </Choice>
              ),
            )}
          </fieldset>
          <Button type="submit" disabled={busy}>
            Send to {view.businessName}
          </Button>
        </form>
      )}
      {problem && <StateLine tone="error">{problem}</StateLine>}
    </div>
  );
}

function Report({ membership }: { membership: MyMembership }) {
  const bodyId = useId();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<ShareReportReason>('pressure');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<'sent' | 'failed' | null>(null);
  const name = membership.business.name;
  if (state === 'sent')
    return (
      <StateLine tone="status">
        Thanks. TipMe will look into it. {name} isn’t told about your report.
      </StateLine>
    );
  if (!open)
    return (
      <Button variant="quiet" onClick={() => setOpen(true)}>
        Report {name} to TipMe
      </Button>
    );
  return (
    <form
      className="work-share__report"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        const text = body.trim();
        void reportBusiness(membership.memberId, {
          reason,
          ...(text ? { body: text } : {}),
        }).then((result) => {
          setBusy(false);
          setState(result.ok ? 'sent' : 'failed');
        });
      }}
    >
      <fieldset>
        <legend>What’s wrong?</legend>
        {SHARE_REPORT_REASONS.map((option) => (
          <Choice
            key={option}
            name={`report-${membership.memberId}`}
            value={option}
            checked={reason === option}
            onChange={() => setReason(option)}
          >
            {REASON_WORDS[option]}
          </Choice>
        ))}
      </fieldset>
      <TextareaField
        id={bodyId}
        label="Tell us more (optional)"
        hint={`Only TipMe staff read this; ${name} never sees it.`}
        maxLength={SHARE_REPORT_LIMIT}
        value={body}
        onChange={(event) => setBody(event.target.value)}
      />
      <Button type="submit" disabled={busy}>
        Send report
      </Button>
      {state === 'failed' && (
        <StateLine tone="error">
          We couldn’t send that just now. Please try again.
        </StateLine>
      )}
    </form>
  );
}

export function ShareAgreementCard({
  membership,
}: {
  membership: MyMembership;
}) {
  const [views, setViews] = useState<ShareAgreementView[] | null | undefined>(
    undefined,
  );
  const load = useCallback(() => {
    void loadMyShares().then((loaded) =>
      setViews(loaded.ok && Array.isArray(loaded.data) ? loaded.data : null),
    );
  }, []);
  useEffect(load, [load]);

  if (views === undefined) return <Skeleton label="Loading your share" />;
  // Off: sharing tips with a business isn't open, and nothing else shows.
  if (views === null)
    return <p className="tm-hint">You keep all your tips here.</p>;
  const here = views.filter((view) => view.memberId === membership.memberId);
  const agreed = here.filter((view) => view.state !== 'proposed');
  const proposal = here.find((view) => view.state === 'proposed');
  return (
    <div className="work-share">
      {agreed.length === 0 ? (
        <p>You keep all your tips here.</p>
      ) : (
        agreed.map((view) => <p key={view.agreementId}>{standing(view)}</p>)
      )}
      {proposal && <Proposal view={proposal} onChanged={load} />}
      <p className="tm-hint">
        A share is of what you receive after TipMe’s fee, and only with your
        agreement. Declining keeps today’s split. The business isn’t told how
        you answered: on the start date it sees only the split that applies.
        Tips through your own page, outside the business, are never shared.
      </p>
      <Report membership={membership} />
    </div>
  );
}
