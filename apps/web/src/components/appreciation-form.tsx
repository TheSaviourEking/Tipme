'use client';
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { TipAmounts, TipPurpose, TipQuote } from '@tipme/contracts';
import {
  AmountChoice,
  Badge,
  Button,
  Card,
  InputField,
  Notice,
  TextareaField,
} from '@tipme/ui';
import { track } from '@/lib/analytics';
import { newUuid } from '@/lib/random-id';
import { createTip, quoteTip, type ApiFailure } from '@/lib/api-client';
import { formatDemoAmount } from '@/lib/demo-amount';
import { amountOptions } from '@/lib/tip-amounts';
import { purposeOptions } from '@/lib/tip-purpose';
import { pendingTipKey, statusTokenKey } from '@/lib/pending-tip';
import { paymentModeCopy } from '@/lib/payment-mode-copy';
import type { PaymentMode } from '@/lib/payment-mode';
import { TippingOpensSoon } from './tipping-opens-soon';
import { Arrow } from './brand';

type QuoteState =
  | { kind: 'idle' }
  | { kind: 'loading'; amount: number }
  | { kind: 'ready'; quote: TipQuote }
  | { kind: 'failed'; amount: number; message: string };

const newIdempotencyKey = newUuid;

const failureMessage = (failure: ApiFailure, rangeText: string): string => {
  if (failure.code === 'NETWORK')
    return 'We couldn’t reach TipMe. Check your connection and try again.';
  if (failure.code === 'RATE_LIMITED')
    return 'That was a lot of tries. Please wait a minute, then try again.';
  if (failure.code === 'VALIDATION_FAILED')
    // This page already blocks amounts outside its range, so a refusal usually means the
    // recipient changed their amounts since it loaded (PR-012): ask for a refresh.
    return `That amount can’t be tipped here right now (this page allows ${rangeText}). Please refresh the page to see the current amounts.`;
  if (failure.code === 'PROFILE_NOT_FOUND')
    return 'This person can’t receive tips right now.';
  if (failure.code === 'PAYMENT_ACCOUNT_REQUIRED')
    return 'This person hasn’t finished setting up payments yet, so they can’t receive tips right now. Nothing was charged.';
  if (failure.code === 'PAYMENT_START_REJECTED')
    return 'The payment couldn’t be started, and nothing was charged. Please try again later.';
  if (failure.code === 'PROVIDER_OUTCOME_UNKNOWN')
    return 'We couldn’t confirm whether your payment started. Please don’t tip again yet: wait a few minutes, and TipMe will check. Nothing is shown as paid until it is confirmed.';
  if (failure.code === 'DEPENDENCY_UNAVAILABLE')
    return 'The payment provider is unavailable right now. Nothing was charged. Please try again in a moment.';
  return 'Something went wrong on our side. Please try again.';
};

export function AppreciationForm({
  paymentMode,
  recipient,
  handle,
  compact = false,
  collapseExtras = false,
  celebration,
  tipAmounts,
  surface = 'home',
}: {
  /** This copy's payment mode, read by the page on the server. */
  paymentMode: PaymentMode;
  recipient: string;
  handle: string;
  /** This page's amounts (PR-012): the standard ones, or a Pro page's own. */
  tipAmounts?: TipAmounts;
  compact?: boolean;
  /** Tuck the optional name and "remember" choices behind a disclosure (profile panel). */
  collapseExtras?: boolean;
  /** A moment the recipient shared: supporters may add their tip to it. */
  celebration?: { momentId: string; label: string };
  /** A person's own page has its own heading and wording, and a Tip bar on phones. */
  surface?: 'home' | 'profile';
}) {
  const id = useId();
  const copy = paymentModeCopy(paymentMode);
  // The API refused as not open (switched off since this page loaded): close the form.
  const [closed, setClosed] = useState(false);
  const options = amountOptions(tipAmounts);
  const presets = options.presets;
  const [joining, setJoining] = useState(false);
  const [selection, setSelection] = useState('');
  const [custom, setCustom] = useState('');
  const [message, setMessage] = useState('');
  const [payerName, setPayerName] = useState('');
  const [purpose, setPurpose] = useState<TipPurpose | ''>('');
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
  const form = useRef<HTMLFormElement>(null);
  const onProfile = surface === 'profile';

  const amount =
    selection === 'other'
      ? options.parse(custom)
      : (presets.find((preset) => String(preset.minor) === selection)?.minor ??
        null);

  const fetchQuote = async (minor: number) => {
    const request = ++latestQuote.current;
    setQuote({ kind: 'loading', amount: minor });
    const result = await quoteTip(handle, minor);
    if (request !== latestQuote.current) return null;
    draftKey.current = null;
    if (!result.ok) {
      if (result.code === 'TIPPING_NOT_OPEN') setClosed(true);
      setQuote({
        kind: 'failed',
        amount: minor,
        message: failureMessage(result, options.rangeText),
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
          ? `Enter an amount of ${options.rangeText}, like ${presets[0]?.label ?? '1,000'} or 2,500.50.`
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
      ...(purpose ? { purpose } : {}),
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
    if (result.code === 'TIPPING_NOT_OPEN') {
      setClosed(true);
      return;
    }
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
    setNotice(failureMessage(result, options.rangeText));
  };

  // On a phone the Tip bar can be pressed from anywhere on the page: bring a problem into view,
  // above the bar (the page's scroll padding), however far away the supporter was.
  const problem =
    error || notice || (shown.kind === 'failed' ? shown.message : '');
  useEffect(() => {
    if (!onProfile || !problem) return;
    form.current
      ?.querySelector('.tm-notice, .tm-field-error')
      ?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }, [onProfile, problem]);

  // The Tip bar steps aside while a field has focus (CSS). Android's back gesture closes the
  // keyboard but leaves the field focused, which would leave the bar away: end the editing too.
  useEffect(() => {
    const view = window.visualViewport;
    if (!onProfile || !view) return;
    let { height, scale } = view;
    const resized = () => {
      const grew = view.height - height > 120 && view.scale === scale;
      ({ height, scale } = view);
      const field = document.activeElement;
      if (
        grew &&
        matchMedia('(max-width: 860px)').matches &&
        field instanceof HTMLElement &&
        field.matches(
          'input:not([type="radio"], [type="checkbox"]), select, textarea',
        )
      )
        field.blur();
    };
    view.addEventListener('resize', resized);
    return () => view.removeEventListener('resize', resized);
  }, [onProfile]);

  const ready = shown.kind === 'ready' ? shown.quote : null;
  const busy = submitting || shown.kind === 'loading';
  const extras = (
    <>
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
            Kept only in this browser, so we can celebrate your tips. No amounts
            or messages.
          </small>
        </span>
      </label>
    </>
  );
  if (closed || !copy.payable)
    return (
      <TippingOpensSoon announce={closed} {...(onProfile ? { handle } : {})} />
    );
  return (
    <Card
      className={`appreciation-card ${compact ? 'appreciation-card--compact' : ''}`}
    >
      <div className="composer-topline">
        <span className="eyebrow">A little appreciation</span>
        {copy.formBadge && <Badge>{copy.formBadge}</Badge>}
      </div>
      {/* No browser form restoration: after Back, the controls must match React's state. */}
      <form
        ref={form}
        onSubmit={submit}
        noValidate
        autoComplete="off"
        {...(submitting ? { 'data-submitting': '' } : {})}
      >
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
        {onProfile ? (
          <h2>Tip {recipient}</h2>
        ) : (
          <>
            <h2>Make {recipient}’s day.</h2>
            <p className="composer-description">
              A small gesture. A very human thank you.
            </p>
          </>
        )}
        <fieldset
          disabled={submitting}
          aria-describedby={`${id}-currency ${error && selection !== 'other' ? `${id}-error` : ''}`}
        >
          <legend>Choose an amount</legend>
          <p id={`${id}-currency`} className="tm-hint">
            Amounts are in NGN.
          </p>
          <div className="amount-options">
            {presets.map((preset, index) => (
              <AmountChoice
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
                ₦{preset.label}
              </AmountChoice>
            ))}
            <AmountChoice
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
            </AmountChoice>
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
            maxLength={16}
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
            hint={`${options.rangeText}.`}
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
            <p className="tip-payment-total">
              You pay {formatDemoAmount(Number(ready.payerTotalMinor))}
            </p>
          )}
        </div>
        <div className="tm-field">
          <label htmlFor={`${id}-purpose`}>
            What is this tip for? (optional)
          </label>
          <select
            id={`${id}-purpose`}
            className="tm-input"
            value={purpose}
            disabled={submitting}
            onChange={(event) => {
              const selected = purposeOptions.find(
                (option) => option.value === event.currentTarget.value,
              );
              setPurpose(selected?.value ?? '');
              draftKey.current = null;
            }}
          >
            <option value="">Choose a reason</option>
            {purposeOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
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
        {collapseExtras ? (
          <details className="composer-extras">
            <summary>Add your name or remember tips</summary>
            <div className="composer-extras__body">{extras}</div>
          </details>
        ) : (
          extras
        )}
        {notice && (
          <Notice tone="error" title="Not sent yet">
            {notice}
          </Notice>
        )}
        {/* A fixed bar on a phone's public page (CSS): still this form's one submit button. */}
        <div className="composer-action">
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
        </div>
        <p className="composer-disclaimer">
          {copy.formDisclaimer && (
            <>
              {copy.formDisclaimer}
              <br />
            </>
          )}
          You’ll confirm on the payment provider’s page next.
        </p>
        {onProfile && copy.formTrust && (
          <p className="composer-trust">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <rect x="5" y="11" width="14" height="9" rx="2" />
              <path d="M8 11V8a4 4 0 0 1 8 0v3" />
            </svg>
            <span>{copy.formTrust}</span>
          </p>
        )}
      </form>
    </Card>
  );
}
