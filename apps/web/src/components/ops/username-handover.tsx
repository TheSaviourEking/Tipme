'use client';
import { useId, useRef, useState, type FormEvent } from 'react';
import type {
  OpsHandoverAccount,
  OpsHandoverLink,
  OpsHandoverLinkCreated,
  UsernameHandedOver,
} from '@tipme/contracts';
import {
  Button,
  InputField,
  Slip,
  StandingWarning,
  TextareaField,
} from '@tipme/ui';
import { ReasonAction } from '@/components/ops/reason-action';
import { claimLinkUrl } from '@/lib/claim-link';
import { when } from '@/lib/ops-client';
import { outcomeIsUnknown, refusalWords } from '@/lib/ops-answers';
import { opsAct } from '@/lib/ops-staff-api';

/*
 * Handing a reserved username to one account (owner's approval, 18 Nov 2026): a one-time claim link
 * staff copy and send themselves, or giving the name to an account they find. The server checks
 * everything again (usernames.manage, a fresh code), and records each step in the audit log.
 */

// A link's end, written out in Lagos time ("2 December 2026").
const day = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'long',
  timeZone: 'Africa/Lagos',
});
const dayOf = (iso: string) => day.format(new Date(iso));

type Refusal = { status: number; code: string; message?: string };

/** The reserved name's claim link: the open one, a new one shown once, and cancelling. */
export function HandoverLinkPanel({
  name,
  link,
  onChanged,
  onRefused,
}: {
  name: string;
  link: OpsHandoverLink | null | undefined;
  /** The name's card re-reads what it is now. */
  onChanged: () => void;
  /** A refusal that means the name changed underneath: the page says so at the top. */
  onRefused: (result: Refusal) => Promise<string | null>;
}) {
  const id = useId();
  const [shown, setShown] = useState<{ url: string; expiresAt: string } | null>(
    null,
  );
  const [copied, setCopied] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const open = link && !shown ? link : null;
  // When the card opened: an open link past its end reads as expired (the claim refuses it anyway).
  const [openedAt] = useState(() => Date.now());
  const expired = open ? Date.parse(open.expiresAt) <= openedAt : false;

  const create = async (reason: string) => {
    const result = await opsAct<OpsHandoverLinkCreated>(
      `/v1/ops/usernames/${encodeURIComponent(name)}/handover-link`,
      { method: 'POST', body: { reason } },
    );
    if (result.kind === 'refused') return onRefused(result);
    if (result.kind === 'waiting') return null;
    setCopied(false);
    setShown({
      url: claimLinkUrl(location.origin, result.data.path),
      expiresAt: result.data.link.expiresAt,
    });
    // The field holds the only copy: focus and select it, ready to copy.
    requestAnimationFrame(() => field.current?.select());
    onChanged();
    return null;
  };

  const cancel = async (reason: string) => {
    const result = await opsAct<OpsHandoverLink>(
      `/v1/ops/usernames/${encodeURIComponent(name)}/handover-link/cancel`,
      { method: 'POST', body: { reason } },
    );
    if (result.kind === 'refused') return onRefused(result);
    setShown(null);
    onChanged();
    return null;
  };

  const copy = async () => {
    if (!shown) return;
    try {
      await navigator.clipboard.writeText(shown.url);
      setCopied(true);
    } catch {
      // No clipboard here: the link is selected, ready for the keyboard's copy.
      field.current?.select();
    }
  };

  return (
    <section className="ops-handover" aria-labelledby={`${id}-title`}>
      <h4 id={`${id}-title`}>Claim link</h4>
      {shown ? (
        <Slip dense tone="done" title="Copy this link now">
          It’s shown only this once, and TipMe keeps no copy. Send it to them
          yourself: TipMe sends nothing. It works once, until{' '}
          {dayOf(shown.expiresAt)}, and only for @{name}.
        </Slip>
      ) : open ? (
        <dl className="ops-facts">
          <div>
            <dt>Claim link</dt>
            <dd>
              {expired
                ? `Expired on ${dayOf(open.expiresAt)}`
                : `Open until ${dayOf(open.expiresAt)}`}
            </dd>
          </div>
          <div>
            <dt>Made by</dt>
            <dd>{open.createdBy ?? 'A staff member'}</dd>
          </div>
          <div>
            <dt>Made</dt>
            <dd>{when(open.createdAt)}</dd>
          </div>
        </dl>
      ) : (
        <p className="tm-hint">
          No claim link. Make one for the person who should have @{name}. It
          works once, for 14 days, and you send it yourself.
        </p>
      )}
      {shown && (
        <div className="ops-handover__link">
          <InputField
            ref={field}
            id={`${id}-link`}
            label={`Claim link for @${name}`}
            readOnly
            value={shown.url}
            onFocus={(e) => e.currentTarget.select()}
          />
          <Button variant="continue" onClick={() => void copy()}>
            {copied ? 'Copied' : 'Copy link'}
          </Button>
          <span role="status" className="sr-only">
            {copied ? 'Link copied' : ''}
          </span>
        </div>
      )}
      <div className="ops-actions">
        <ReasonAction
          open={
            open || shown ? 'Create a new claim link…' : 'Create claim link…'
          }
          field="Why make a claim link?"
          hint={
            open || shown
              ? 'The link already made stops working. Recorded in the audit log with your name and the time.'
              : 'Recorded in the audit log with your name and the time.'
          }
          submit="Create claim link"
          onSubmit={create}
        />
        {(open || shown) && (
          <ReasonAction
            open="Cancel the claim link…"
            field="Why cancel the claim link?"
            submit="Cancel the claim link"
            variant="quiet"
            onSubmit={cancel}
          />
        )}
      </div>
    </section>
  );
}

const pageWords = (account: OpsHandoverAccount) => {
  const page = account.page;
  if (!page) return 'An account with no page yet';
  return [
    `@${page.handle}`,
    page.displayName,
    page.plan === 'pro' ? 'Pro' : 'Free',
    page.pageState === 'live' ? 'live' : 'not live',
    page.suspended ? 'paused' : null,
  ]
    .filter(Boolean)
    .join(', ');
};

/** Find an account by its username or whole email, confirm, and give it the reserved name. */
export function GiveToAccount({
  name,
  onGiven,
  onRefused,
}: {
  name: string;
  onGiven: (given: UsernameHandedOver) => void;
  onRefused: (result: Refusal) => Promise<string | null>;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<OpsHandoverAccount[] | null>(null);
  const [finding, setFinding] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (!open)
    return (
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Give to an account…
      </Button>
    );

  const find = async (event: FormEvent) => {
    event.preventDefault();
    if (query.trim().length < 2) {
      setError('Type their username, or their whole email address.');
      return;
    }
    setFinding(true);
    setError('');
    const result = await opsAct<OpsHandoverAccount[]>(
      '/v1/ops/usernames/handover-accounts',
      { method: 'POST', body: { query: query.trim() } },
    );
    setFinding(false);
    if (result.kind === 'refused') {
      setFound(null);
      setError(refusalWords(result));
      return;
    }
    if (result.kind === 'done') setFound(result.data);
  };

  const account = found?.[0] ?? null;

  const give = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!account || busy) return;
    const reason = String(
      new FormData(event.currentTarget).get('reason') ?? '',
    ).trim();
    if (reason.length < 10) {
      setError('Please write at least 10 characters.');
      return;
    }
    setBusy(true);
    setError('');
    const result = await opsAct<UsernameHandedOver>(
      `/v1/ops/usernames/${encodeURIComponent(name)}/assign`,
      { method: 'POST', body: { userId: account.userId, reason } },
    );
    setBusy(false);
    if (result.kind === 'refused') {
      if (result.status === 400) {
        setError(refusalWords(result));
        return;
      }
      if (outcomeIsUnknown(result)) {
        setError(
          'We can’t say whether it went through. Check the name again before trying again.',
        );
        return;
      }
      // The name or the account changed underneath: the page re-reads and says so.
      if (result.code !== 'HANDOVER_ACCOUNT_UNAVAILABLE') {
        await onRefused(result);
        return;
      }
      setError(refusalWords(result));
      return;
    }
    if (result.kind === 'done') {
      setOpen(false);
      onGiven(result.data);
    }
  };

  return (
    <section className="ops-handover" aria-labelledby={`${id}-title`}>
      <h4 id={`${id}-title`}>Give @{name} to an account</h4>
      <form
        className="settings-form"
        aria-label={`Find the account to give @${name} to`}
        onSubmit={(e) => void find(e)}
      >
        <InputField
          id={`${id}-query`}
          label="Their username or email"
          hint="Their current username, or the whole email address they confirmed. Nothing else matches, and no email is shown."
          autoComplete="off"
          spellCheck={false}
          maxLength={254}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setFound(null);
          }}
        />
        <div className="ops-actions">
          <Button
            type="submit"
            variant="secondary"
            disabled={finding}
            aria-busy={finding}
          >
            Find
          </Button>
          <Button
            variant="quiet"
            onClick={() => {
              setOpen(false);
              setFound(null);
              setQuery('');
              setError('');
            }}
          >
            Cancel
          </Button>
        </div>
      </form>
      {found && found.length === 0 && (
        <Slip dense tone="neutral" title="No account matches">
          Check the spelling, or make a claim link for them instead.
        </Slip>
      )}
      {account && (
        <form className="ops-reason" onSubmit={(e) => void give(e)}>
          <dl className="ops-facts">
            <div>
              <dt>Account</dt>
              <dd>{pageWords(account)}</dd>
            </div>
            <div>
              <dt>Found by</dt>
              <dd>{account.foundBy === 'email' ? 'Email' : 'Username'}</dd>
            </div>
          </dl>
          <p>
            {account.page
              ? `@${account.page.handle}’s username becomes @${name}. @${account.page.handle} keeps leading to their page, and their tips, balance and plan don’t change. It doesn’t use one of their username changes.`
              : `This account gets a page at @${name}. It isn’t live until they set it up.`}
          </p>
          {account.liveCheckoutListed && (
            <StandingWarning dense title="Listed for live checkout">
              This page is listed in LIVE_CHECKOUT_HANDLES. Update it to the new
              username, or it loses live checkout.
            </StandingWarning>
          )}
          <TextareaField
            id={`${id}-reason`}
            name="reason"
            label={`Why give @${name} to this account?`}
            hint="Recorded in the audit log with your name and the time."
            minLength={10}
            maxLength={500}
            required
          />
          <div className="ops-actions">
            <Button
              type="submit"
              variant="continue"
              disabled={busy}
              aria-busy={busy}
            >
              {account.page
                ? `Give @${name} to @${account.page.handle}`
                : `Give @${name} to this account`}
            </Button>
          </div>
        </form>
      )}
      {error && (
        <Slip dense tone="error" title="Not done">
          {error}
        </Slip>
      )}
    </section>
  );
}
