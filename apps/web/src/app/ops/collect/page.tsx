'use client';
import Link from 'next/link';
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import type {
  OpsCollectDispute,
  OpsCollectHeld,
  OpsCollectTransfer,
  OpsCollectUnclaimed,
} from '@tipme/contracts';
import {
  Button,
  Card,
  InputField,
  Skeleton,
  Slip,
  TextareaField,
} from '@tipme/ui';
import {
  ActionOutcome,
  outcomeOf,
  type ActionOutcomeState,
} from '@/components/ops/action-outcome';
import { LoadFailed } from '@/components/dashboard/load-failed';
import { Money } from '@/components/money';
import { refusalWords } from '@/lib/ops-answers';
import { can, useOpsAccess } from '@/lib/ops-client';
import { opsAct, opsFetch } from '@/lib/ops-staff-api';

type Overview = {
  held: OpsCollectHeld;
  review: OpsCollectTransfer[];
  disputes: OpsCollectDispute[];
  unclaimed: OpsCollectUnclaimed[];
};

async function loadOverview(): Promise<Overview | null> {
  const [held, review, disputes, unclaimed] = await Promise.all([
    opsFetch<OpsCollectHeld>('/v1/ops/collect/held'),
    opsFetch<OpsCollectTransfer[]>('/v1/ops/collect/transfers?status=review'),
    opsFetch<OpsCollectDispute[]>('/v1/ops/collect/disputes'),
    opsFetch<OpsCollectUnclaimed[]>('/v1/ops/collect/unclaimed'),
  ]);
  if (!held.ok || !review.ok || !disputes.ok || !unclaimed.ok) return null;
  return {
    held: held.data,
    review: review.data,
    disputes: disputes.data,
    unclaimed: unclaimed.data,
  };
}

/**
 * You collect at a glance (spec §9): what TipMe holds for recipients, transfers waiting on a person,
 * open disputes and recipients past the holding cap, each a link to its screen. Support's change of
 * a verified name is here too, for whoever holds `recoveries.manage`.
 */
export default function CollectOverviewPage() {
  const access = useOpsAccess();
  const [state, setState] = useState<Overview | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    const next = await loadOverview();
    setFailed(next === null);
    if (next) setState(next);
  }, []);
  useEffect(() => {
    void loadOverview().then((next) => {
      setFailed(next === null);
      if (next) setState(next);
    });
  }, []);

  const open = state?.disputes.filter(
    (d) => d.status === 'open' || d.status === 'responded',
  );
  const ngn = state?.held.totals.find((t) => t.currency === 'NGN');
  return (
    <section className="dashboard-section ops-page-body">
      <h1>You collect</h1>
      <p className="tm-hint">
        Tips TipMe takes on its own payment partner account and holds for each
        recipient until it moves to them. Every money action here waits for a
        second person.
      </p>
      {failed && (
        <LoadFailed dense title="Couldn’t load You collect" onRetry={load}>
          Your role may not include it, or the connection failed.
        </LoadFailed>
      )}
      {!state && !failed && <Skeleton label="Loading You collect" />}
      {state && (
        <div className="ops-tiles" data-testid="collect-overview">
          <Link className="ops-tile" href="/ops/collect/held">
            <span className="ops-tile__label">Held for recipients</span>
            <span className="ops-tile__value">
              <Money minor={ngn?.heldMinor ?? '0'} />
            </span>
            <span className="ops-tile__previous">
              {state.held.recipients.length} recipient
              {state.held.recipients.length === 1 ? '' : 's'}
            </span>
          </Link>
          <Link
            className="ops-tile"
            href="/ops/collect/transfers?status=review"
          >
            <span className="ops-tile__label">Transfers in review</span>
            <span className="ops-tile__value">{state.review.length}</span>
          </Link>
          <Link className="ops-tile" href="/ops/collect/disputes">
            <span className="ops-tile__label">Open disputes</span>
            <span className="ops-tile__value">{open?.length ?? 0}</span>
          </Link>
          <Link className="ops-tile" href="/ops/collect/unclaimed">
            <span className="ops-tile__label">Past the holding cap</span>
            <span className="ops-tile__value">{state.unclaimed.length}</span>
          </Link>
        </div>
      )}
      {can(access, 'recoveries.manage') && <NameChange />}
    </section>
  );
}

/** Support's change of a verified name (`collect_name.change`): a second person decides. */
function NameChange() {
  const id = useId();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ActionOutcomeState | null>(null);
  const send = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const value = (name: string) => String(data.get(name) ?? '').trim();
    const [handle, first, last, reason] = [
      value('handle').replace(/^@/, ''),
      value('first'),
      value('last'),
      value('reason'),
    ];
    if (!handle || !first || !last)
      return setError('Write the page’s username and the full new name.');
    if (reason.length < 10)
      return setError('Please write a reason of at least 10 characters.');
    setBusy(true);
    setError('');
    const answer = await opsAct('/v1/ops/collect/name', {
      method: 'POST',
      body: { handle, first, last, reason },
    });
    setBusy(false);
    if (answer.kind === 'refused') return setError(refusalWords(answer));
    form.reset();
    setOutcome(
      outcomeOf(
        answer,
        `@${handle}’s verified name is changed. Nothing more is sent to them until the payment partner checks the new name with their bank details.`,
        'The name in use stays the same until then.',
      ),
    );
  };
  return (
    <Card className="settings-section">
      <h2>Change a verified name</h2>
      <p className="tm-hint">
        Only after checking it with the person. The name stays locked, and the
        payment partner checks the new name when they add their bank details
        again; transfers to them wait until then.
      </p>
      {outcome && <ActionOutcome outcome={outcome} />}
      <form className="ops-reason" onSubmit={(e) => void send(e)} noValidate>
        <InputField id={`${id}-handle`} name="handle" label="Page username" />
        <InputField
          id={`${id}-first`}
          name="first"
          label="First name, as on their bank account"
          autoComplete="off"
        />
        <InputField
          id={`${id}-last`}
          name="last"
          label="Last name, as on their bank account"
          autoComplete="off"
        />
        <TextareaField
          id={`${id}-reason`}
          name="reason"
          label="What you checked"
          hint="Recorded in the audit log with your name and the time. The names are not."
          maxLength={500}
        />
        {error && (
          <Slip dense tone="error" title="Not done">
            {error}
          </Slip>
        )}
        <Button
          variant="continue"
          type="submit"
          disabled={busy}
          aria-busy={busy}
        >
          Ask for approval
        </Button>
      </form>
    </Card>
  );
}
