'use client';
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { TipQuote } from '@tipme/contracts';
import {
  Badge,
  Button,
  Card,
  Choice,
  InputField,
  Notice,
  TextareaField,
} from '@tipme/ui';
import { track } from '@/lib/analytics';
import { newUuid } from '@/lib/random-id';
import { createTip, quoteTip, type ApiFailure } from '@/lib/api-client';
import { formatDemoAmount, parseDemoAmount } from '@/lib/demo-amount';
import { pendingTipKey, statusTokenKey } from '@/lib/pending-tip';
import { Arrow } from './brand';

const presets = [
  { label: '1,000', minor: 100000 },
  { label: '2,000', minor: 200000 },
  { label: '5,000', minor: 500000 },
];
type QuoteState =
  | { kind: 'idle' }
  | { kind: 'loading'; amount: number }
  | { kind: 'ready'; quote: TipQuote }
  | { kind: 'failed'; amount: number; message: string };

const newIdempotencyKey = newUuid;

const failureMessage = (failure: ApiFailure): string => {
  if (failure.code === 'NETWORK')
    return 'We couldn’t reach TipMe. Check your connection and try again.';
  if (failure.code === 'RATE_LIMITED')
    return 'That was a lot of tries. Please wait a minute, then try again.';
  if (failure.code === 'VALIDATION_FAILED')
    return 'That amount can’t be tipped. Try an amount from 1 to 100,000 NGN.';
  if (failure.code === 'PROFILE_NOT_FOUND')
    return 'This person can’t receive tips right now.';
  return 'Something went wrong on our side. Please try again.';
};

export function AppreciationForm({
  recipient,
  handle,
  compact = false,
  celebration,
}: {
  recipient: string;
  handle: string;
  compact?: boolean;
  /** A moment the recipient shared: supporters may add their tip to it. */
  celebration?: { momentId: string; label: string };
}) {
  const id = useId();
  const [joining, setJoining] = useState(false);
  const [selection, setSelection] = useState('');
  const [custom, setCustom] = useState('');
  const [message, setMessage] = useState('');
  const [payerName, setPayerName] = useState('');
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState('');
  const [quote, setQuote] = useState<QuoteState>({ kind: 'idle' });
  const [notice, setNotice] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // One key per draft (quote + message): retries and double taps reuse it, so one tip at most.
  const draftKey = useRef<string | null>(null);
  const latestQuote = useRef(0);
  const customField = useRef<HTMLInputElement>(null);
  const firstChoice = useRef<HTMLInputElement>(null);

  const amount =
    selection === 'other'
      ? parseDemoAmount(custom)
      : (presets.find((preset) => String(preset.minor) === selection)?.minor ??
        null);

  const fetchQuote = async (minor: number) => {
    const request = ++latestQuote.current;
    setQuote({ kind: 'loading', amount: minor });
    const result = await quoteTip(handle, minor);
    if (request !== latestQuote.current) return null;
    draftKey.current = null;
    if (!result.ok) {
      setQuote({
        kind: 'failed',
        amount: minor,
        message: failureMessage(result),
      });
      return null;
    }
    setQuote({ kind: 'ready', quote: result.data });
    return result.data;
  };

  // Back from the provider page may restore this page from the back/forward cache mid-submit.
  // Keep the draft key: tapping Tip again replays the same tip, never a second one.
  useEffect(() => {
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) setSubmitting(false);
    };
    addEventListener('pageshow', restored);
    return () => removeEventListener('pageshow', restored);
  }, []);

  // Presets quote at once; a typed amount waits until typing pauses.
  useEffect(() => {
    if (amount === null) {
      // Drop any answer still in flight for an amount that is no longer chosen.
      latestQuote.current += 1;
      return;
    }
    const timer = setTimeout(
      () => void fetchQuote(amount),
      selection === 'other' ? 300 : 0,
    );
    return () => clearTimeout(timer);
    // fetchQuote is recreated each render; the amount is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amount, selection]);

  // What is on screen always belongs to the amount chosen now; an older answer counts as loading.
  const shown: QuoteState =
    amount === null
      ? { kind: 'idle' }
      : quote.kind === 'idle' ||
          (quote.kind === 'ready'
            ? Number(quote.quote.tipMinor) !== amount
            : quote.amount !== amount)
        ? { kind: 'loading', amount }
        : quote;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;
    track('tip_cta_clicked', { surface: 'profile', handle });
    if (!amount) {
      setError(
        selection === 'other'
          ? 'Enter an amount from 1 to 100,000 NGN, like 1500 or 1,500.50.'
          : 'Choose an amount or enter your own.',
      );
      if (selection === 'other') customField.current?.focus();
      else firstChoice.current?.focus();
      return;
    }
    setError('');
    setNotice('');
    // Never pay without a current server quote for exactly this amount.
    const current =
      shown.kind === 'ready' ? shown.quote : await fetchQuote(amount);
    if (!current) return;
    draftKey.current ??= newIdempotencyKey();
    setSubmitting(true);
    const trimmed = message.trim();
    const result = await createTip(draftKey.current, {
      quoteId: current.quoteId,
      ...(trimmed ? { message: trimmed } : {}),
      ...(payerName.trim() ? { payerDisplayLabel: payerName.trim() } : {}),
      ...(joining && celebration
        ? { celebrationMomentId: celebration.momentId }
        : {}),
    });
    if (result.ok) {
      try {
        // The receipt token stays in this tab: it never travels through the provider's pages.
        sessionStorage.setItem(
          statusTokenKey(result.data.tipId),
          result.data.statusToken,
        );
        sessionStorage.setItem(
          pendingTipKey(result.data.tipId),
          JSON.stringify({ optIn: remember, handle }),
        );
      } catch {
        // Without session storage the receipt needs its full link; the tip itself still works.
      }
      track('payment_started', { surface: 'checkout', handle });
      location.assign(result.data.checkoutUrl);
      return;
    }
    setSubmitting(false);
    if (
      result.code === 'QUOTE_EXPIRED' ||
      result.code === 'QUOTE_ALREADY_USED'
    ) {
      // A fresh quote, shown for confirmation: nothing is charged without the supporter's tap.
      // If the refresh itself fails, the quote area already says why.
      if (await fetchQuote(amount))
        setNotice(
          'Your price was refreshed. Please check it and tap Tip again.',
        );
      return;
    }
    setNotice(failureMessage(result));
  };

  const ready = shown.kind === 'ready' ? shown.quote : null;
  const busy = submitting || shown.kind === 'loading';
  return (
    <Card
      className={`appreciation-card ${compact ? 'appreciation-card--compact' : ''}`}
    >
      <div className="composer-topline">
        <span className="eyebrow">A little appreciation</span>
        <Badge>Pretend payments</Badge>
      </div>
      {/* No browser form restoration: after Back, the controls must match React's state. */}
      <form onSubmit={submit} noValidate autoComplete="off">
        {celebration && (
          <div className="celebration-banner">
            <p>
              <span aria-hidden="true">✳ </span>
              Celebrating {recipient}’s {celebration.label}
            </p>
            <Button
              variant={joining ? 'primary' : 'secondary'}
              aria-pressed={joining}
              disabled={submitting}
              onClick={() => {
                setJoining((value) => !value);
                draftKey.current = null;
              }}
            >
              Add to the celebration
            </Button>
          </div>
        )}
        <h2>Make {recipient}’s day.</h2>
        <p className="composer-description">
          A small gesture. A very human thank you.
        </p>
        <fieldset
          disabled={submitting}
          aria-describedby={`${id}-currency ${error && selection !== 'other' ? `${id}-error` : ''}`}
        >
          <legend>Choose an amount</legend>
          <p id={`${id}-currency`} className="tm-hint">
            NGN · Illustrative currency, not a launch commitment.
          </p>
          <div className="amount-options">
            {presets.map((preset, index) => (
              <Choice
                key={preset.minor}
                ref={index === 0 ? firstChoice : undefined}
                name={`amount-${id}`}
                value={String(preset.minor)}
                aria-label={`${preset.label} NGN`}
                checked={selection === String(preset.minor)}
                onChange={() => {
                  setSelection(String(preset.minor));
                  setError('');
                  track('amount_selected', { surface: 'profile', handle });
                }}
              >
                {preset.label}
              </Choice>
            ))}
            <Choice
              name={`amount-${id}`}
              value="other"
              aria-label="Other amount"
              checked={selection === 'other'}
              onChange={() => {
                setSelection('other');
                setError('');
              }}
            >
              Other
            </Choice>
          </div>
          {error && selection !== 'other' && (
            <p className="tm-field-error" role="alert" id={`${id}-error`}>
              {error}
            </p>
          )}
        </fieldset>
        {selection === 'other' && (
          <InputField
            id={`${id}-custom`}
            label="Your amount (NGN)"
            inputMode="decimal"
            autoComplete="off"
            maxLength={10}
            placeholder="e.g. 1500.00"
            value={custom}
            disabled={submitting}
            ref={customField}
            onChange={(event) => {
              if (!custom && event.target.value)
                track('custom_amount_entered', { surface: 'profile', handle });
              setCustom(event.target.value);
              setError('');
            }}
            error={error || undefined}
            hint="Sample range: 1–100,000 NGN."
          />
        )}
        <div className="tip-quote" aria-live="polite">
          {shown.kind === 'loading' && (
            <p className="tm-hint">Getting the latest price…</p>
          )}
          {shown.kind === 'failed' && (
            <div className="tip-quote__failed">
              <p className="tm-field-error">{shown.message}</p>
              <Button
                variant="secondary"
                onClick={() => void fetchQuote(shown.amount)}
              >
                Try again
              </Button>
            </div>
          )}
          {ready && (
            <>
              <dl className="tip-breakdown">
                <div>
                  <dt>Your tip</dt>
                  <dd>{formatDemoAmount(Number(ready.tipMinor))}</dd>
                </div>
                <div>
                  <dt>TipMe fee{ready.feeFree ? ' (fee-free)' : ''}</dt>
                  <dd>−{formatDemoAmount(Number(ready.platformFeeMinor))}</dd>
                </div>
                <div>
                  <dt>Payment provider fee</dt>
                  <dd>−{formatDemoAmount(Number(ready.providerFeeMinor))}</dd>
                </div>
              </dl>
              <p className="tip-net">
                {recipient} receives{' '}
                {formatDemoAmount(Number(ready.recipientNetMinor))} after fees
              </p>
              <p className="tm-hint">
                Illustrative fees from a pretend provider (
                {ready.feePolicyVersion}
                ). You pay {formatDemoAmount(Number(ready.payerTotalMinor))}.
              </p>
            </>
          )}
        </div>
        <TextareaField
          id={`${id}-message`}
          label="Personal message (optional)"
          maxLength={280}
          value={message}
          disabled={submitting}
          onChange={(event) => {
            // That someone started a note, never what it says.
            if (!message && event.target.value)
              track('message_started', { surface: 'profile', handle });
            setMessage(event.target.value);
            draftKey.current = null;
          }}
          placeholder="Your work made a difference. Thank you."
          hint={`${message.length}/280 characters. Sent privately with your tip.`}
        />
        <InputField
          id={`${id}-name`}
          label="Your name (optional)"
          maxLength={60}
          autoComplete="name"
          value={payerName}
          disabled={submitting}
          onChange={(event) => {
            setPayerName(event.target.value);
            draftKey.current = null;
          }}
          hint={`Shown to ${recipient} with your tip. Leave it empty to stay anonymous.`}
        />
        <label className="tip-remember" htmlFor={`${id}-remember`}>
          <input
            id={`${id}-remember`}
            type="checkbox"
            checked={remember}
            disabled={submitting}
            onChange={(event) => setRemember(event.target.checked)}
          />
          <span>
            Remember my tips on this phone
            <small>
              Kept only in this browser, so we can celebrate your tips. No
              amounts or messages.
            </small>
          </span>
        </label>
        {notice && (
          <Notice tone="error" title="Not sent yet">
            {notice}
          </Notice>
        )}
        <Button
          className="composer-submit"
          type="submit"
          disabled={busy}
          aria-busy={busy}
        >
          {submitting
            ? 'Starting your tip…'
            : amount
              ? `Tip ${formatDemoAmount(amount)}`
              : 'Tip'}{' '}
          <Arrow />
        </Button>
        <p className="composer-disclaimer">
          Payments here are pretend: no real money moves.
          <br />
          You’ll confirm on the payment provider’s page next.
        </p>
      </form>
    </Card>
  );
}
