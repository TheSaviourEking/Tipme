'use client';
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import type { OpsApproval } from '@tipme/contracts';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  InputField,
  Notice,
  Skeleton,
  TextareaField,
} from '@tipme/ui';
import { ReasonAction } from '@/components/ops/reason-action';
import { when } from '@/lib/ops-client';
import {
  APPROVAL_STATUS_WORDS,
  approveRefusal,
  refusalWords,
  SERIOUS_ACTION_WORDS,
  STALE_WORDS,
} from '@/lib/ops-answers';
import { opsFetch } from '@/lib/ops-staff-api';

type Said = {
  tone: 'success' | 'error' | 'neutral';
  title: string;
  text: string;
};

function ApproveForm({
  id: requestId,
  onSaid,
  onDecided,
}: {
  id: string;
  onSaid: (said: Said) => void;
  onDecided: () => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const note = String(data.get('note') ?? '').trim();
    setBusy(true);
    const result = await opsFetch(`/v1/ops/approvals/${requestId}/approve`, {
      method: 'POST',
      body: {
        code: String(data.get('code') ?? ''),
        ...(note ? { reason: note } : {}),
      },
    });
    setBusy(false);
    if (result.ok) {
      onSaid({
        tone: 'success',
        title: 'Approved and done',
        text: 'It ran, and the log records you both.',
      });
      onDecided();
      return;
    }
    const { stillWaiting, text } = approveRefusal(result);
    onSaid({
      tone: 'error',
      title: stillWaiting ? 'Not approved yet' : 'This request has closed',
      text,
    });
    if (stillWaiting)
      form.querySelector<HTMLInputElement>('input[name=code]')?.select();
    else onDecided();
  };
  if (!open) return <Button onClick={() => setOpen(true)}>Approve…</Button>;
  return (
    <form className="ops-reason" onSubmit={(e) => void submit(e)}>
      <InputField
        id={`${id}-code`}
        name="code"
        label="Authenticator code"
        hint="Each approval takes its own code, however recently you entered one. It runs at once, after the facts are checked again."
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]{6}"
        maxLength={6}
        required
        autoFocus
      />
      <TextareaField
        id={`${id}-note`}
        name="note"
        label="Note (optional)"
        hint="Recorded with your approval. At least 10 characters if you write one."
        minLength={10}
        maxLength={500}
      />
      <div className="ops-actions">
        <Button type="submit" disabled={busy} aria-busy={busy}>
          Approve and run
        </Button>
        <Button variant="quiet" onClick={() => setOpen(false)}>
          Back
        </Button>
      </div>
    </form>
  );
}

function Waiting({
  row,
  onSaid,
  onDecided,
}: {
  row: OpsApproval;
  onSaid: (said: Said) => void;
  onDecided: () => void;
}) {
  const id = useId();
  const [busy, setBusy] = useState(false);
  const cancel = async () => {
    setBusy(true);
    const result = await opsFetch(`/v1/ops/approvals/${row.id}/cancel`, {
      method: 'POST',
      body: {},
    });
    setBusy(false);
    if (!result.ok) {
      onSaid({
        tone: 'error',
        title: 'Not cancelled',
        text: refusalWords(result),
      });
      return;
    }
    onSaid({
      tone: 'neutral',
      title: 'Cancelled',
      text: 'Cancelled. Nothing changed.',
    });
    onDecided();
  };
  return (
    <article aria-labelledby={id} className="ops-row">
      <h3 id={id}>{SERIOUS_ACTION_WORDS[row.action] ?? row.action}</h3>
      {/* The server's words, fixed when it was asked: masked addresses and written checks included. */}
      <p className="ops-summary">{row.summary}</p>
      <dl className="ops-facts">
        <div>
          <dt>Asked by</dt>
          <dd>{row.mine ? 'You' : (row.requestedByHint ?? 'Staff')}</dd>
        </div>
        <div>
          <dt>Why</dt>
          <dd>{row.reason}</dd>
        </div>
        <div>
          <dt>Asked</dt>
          <dd>{when(row.createdAt)}</dd>
        </div>
        <div>
          <dt>Expires</dt>
          <dd>{when(row.expiresAt)}</dd>
        </div>
      </dl>
      {row.mine && row.nobodyElseQualified && (
        <Notice tone="neutral" title="Nobody else can decide this now">
          The other people who could have approved it have gone. Cancel it, then
          do it again: it will run straight away, and the log will say you acted
          alone.
        </Notice>
      )}
      {!row.mine && !row.canDecide && (
        <p className="tm-hint">
          You can’t decide this one: it concerns you, or it needs something you
          don’t hold.
        </p>
      )}
      <div className="ops-actions">
        {row.canDecide && (
          <>
            <ApproveForm id={row.id} onSaid={onSaid} onDecided={onDecided} />
            <ReasonAction
              open="Reject…"
              field="Why reject it?"
              submit="Reject request"
              onSubmit={async (reason) => {
                const result = await opsFetch(
                  `/v1/ops/approvals/${row.id}/reject`,
                  { method: 'POST', body: { reason } },
                );
                if (!result.ok) return refusalWords(result);
                onSaid({
                  tone: 'neutral',
                  title: 'Rejected',
                  text: 'Rejected. Nothing changed.',
                });
                onDecided();
                return null;
              }}
            />
          </>
        )}
        {row.mine && (
          <Button
            variant="secondary"
            disabled={busy}
            aria-busy={busy}
            onClick={() => void cancel()}
          >
            Cancel my request
          </Button>
        )}
      </div>
    </article>
  );
}

function Closed({ row }: { row: OpsApproval }) {
  return (
    <li className="ops-row">
      <span className="ops-row__head">
        <strong>{SERIOUS_ACTION_WORDS[row.action] ?? row.action}</strong>
        <Badge>{APPROVAL_STATUS_WORDS[row.status] ?? row.status}</Badge>
      </span>
      <span>{row.summary}</span>
      <span>Why asked: {row.reason}</span>
      {row.status === 'stale' && row.decidedReason ? (
        <span>
          {STALE_WORDS[row.decidedReason] ??
            'It did not run: something changed.'}
        </span>
      ) : (
        row.decidedReason && <span>Their words: {row.decidedReason}</span>
      )}
      <span className="tm-hint">
        Asked by {row.mine ? 'you' : (row.requestedByHint ?? 'staff')}
        {row.decidedByHint && `, decided by ${row.decidedByHint}`}
        {row.decidedAt && ` · ${when(row.decidedAt)}`}
      </span>
    </li>
  );
}

/** Serious actions waiting for a second person, and what became of earlier ones. */
export default function ApprovalsPage() {
  const [pending, setPending] = useState<OpsApproval[] | null>(null);
  const [all, setAll] = useState<OpsApproval[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [said, setSaid] = useState<Said | null>(null);
  const saidAt = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const [waiting, everything] = await Promise.all([
      opsFetch<OpsApproval[]>('/v1/ops/approvals?status=pending'),
      opsFetch<OpsApproval[]>('/v1/ops/approvals'),
    ]);
    setFailed(!waiting.ok);
    if (waiting.ok) setPending(waiting.data);
    if (everything.ok) setAll(everything.data);
  }, []);
  useEffect(() => {
    // Only the first read waits on this: load's state changes come after its answers.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- nothing is set before the await
    void load();
  }, [load]);

  const say = (next: Said) => {
    setSaid(next);
    // What the person was on may be gone, so focus goes to what happened.
    requestAnimationFrame(() => saidAt.current?.focus());
  };
  const closed = all?.filter((row) => row.status !== 'pending') ?? [];

  return (
    <div className="ops-dashboard">
      <h1>Approvals</h1>
      <p className="tm-hint">
        Serious actions wait here until a second person who holds the same
        permission decides. When nobody else can, they run at once and the log
        says so, so nothing here ever needs someone who doesn’t exist.
      </p>
      <div ref={saidAt} tabIndex={-1}>
        {said && (
          <Notice tone={said.tone} title={said.title}>
            {said.text}
          </Notice>
        )}
      </div>
      <section
        aria-labelledby="approvals-pending"
        className="dashboard-section"
      >
        <h2 id="approvals-pending">Waiting</h2>
        {failed && (
          <Notice tone="error" title="Couldn’t load what’s waiting">
            There may be requests waiting. Please reload in a moment.
          </Notice>
        )}
        {!pending && !failed && <Skeleton label="Loading approvals" />}
        {pending?.length === 0 && (
          <EmptyState title="Nothing is waiting">
            No request needs a second person right now.
          </EmptyState>
        )}
        {pending && pending.length > 0 && (
          <div className="ops-list">
            {pending.map((row) => (
              <Waiting
                key={row.id}
                row={row}
                onSaid={say}
                onDecided={() => void load()}
              />
            ))}
          </div>
        )}
      </section>
      <section
        aria-labelledby="approvals-history"
        className="dashboard-section"
      >
        <h2 id="approvals-history">History</h2>
        {closed.length === 0 ? (
          <p className="tm-hint">No decisions yet.</p>
        ) : (
          <Card className="settings-section">
            <ul className="ops-list">
              {closed.map((row) => (
                <Closed key={row.id} row={row} />
              ))}
            </ul>
          </Card>
        )}
      </section>
    </div>
  );
}
