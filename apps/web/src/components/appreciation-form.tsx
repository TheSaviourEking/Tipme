'use client';
import { useEffect, useId, useRef, useState } from 'react';
import type { CSSProperties, FormEvent, ReactNode } from 'react';
import { flushSync } from 'react-dom';
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
import { formatDemoAmount, formatNaira } from '@/lib/demo-amount';
import { amountOptions, keyLayout } from '@/lib/tip-amounts';
import { purposeOptions } from '@/lib/tip-purpose';
import { pendingTipKey, statusTokenKey } from '@/lib/pending-tip';
import { paymentModeCopy } from '@/lib/payment-mode-copy';
import type { PaymentMode } from '@/lib/payment-mode';
import { TippingOpensSoon } from './tipping-opens-soon';
import { Arrow } from './brand';
import { TipAction } from './tip-action';

type QuoteState =
  | { kind: 'idle' }
  | { kind: 'loading'; amount: number }
  | { kind: 'ready'; quote: TipQuote }
  | { kind: 'failed'; amount: number; message: string };

const newIdempotencyKey = newUuid;
const AMOUNT_MISMATCH =
  'We couldn’t confirm this amount, so nothing was charged. Please refresh the page and try again.';
// The sticky panel's top offset and a little room under it (globals.css).
const PANEL_MARGIN_PX = 32;
// packages/contracts/src/checkout.ts: what a tip may carry.
const MESSAGE_LIMIT = 280;
const NAME_LIMIT = 60;

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
  celebration,
  tipAmounts,
  surface = 'home',
  pilotNotice,
  barNotice,
  business,
}: {
  /** This copy's payment mode, read by the page on the server. */
  paymentMode: PaymentMode;
  recipient: string;
  handle: string;
  /** This page's amounts (PR-012): the standard ones, or a Pro page's own. */
  tipAmounts?: TipAmounts;
  compact?: boolean;
  /** A moment the recipient shared (announced beside the card): supporters may add their tip. */
  celebration?: { momentId: string; label: string };
  /** A person's own page has its own heading and wording, and a Tip bar on phones. */
  surface?: 'home' | 'profile';
  /** The pilot notice, rendered on the server (null outside live mode): it must be seen before paying, under the button and in the phone's Tip bar. */
  pilotNotice?: ReactNode;
  /**
   * The pilot notice as plain text for the phone's Tip bar, or nothing when it is not shown. The
   * server decides, so the bar never holds an empty slot; it has no test id, so the notice under
   * the button stays the one the page is tested by.
   */
  barNotice?: ReactNode;
  /**
   * Tipping someone at a business (PR B4): the form is otherwise exactly the person's own. The tip
   * carries the membership as a label the server checks (and ignores when it no longer holds), and
   * this tab remembers the business for "Tip {name} again", only with the supporter's opt-in.
   */
  business?: { memberId: string; name: string; slug: string };
}) {
  const id = useId();
  const copy = paymentModeCopy(paymentMode);
  // The API refused as not open (switched off since this page loaded): close the form.
  const [closed, setClosed] = useState(false);
  const options = amountOptions(tipAmounts);
  const presets = options.presets;
  const layout = keyLayout(presets.map((preset) => preset.label));
  const [joining, setJoining] = useState(false);
  // Starts on the owner's NGN 2,000, or the preset closest to it. Only a starting point: a page view
  // quotes nothing, and `amount_selected` counts people, not defaults.
  const [selection, setSelection] = useState(
    options.defaultMinor === null ? '' : String(options.defaultMinor),
  );
  const choseAmount = useRef(false);
  const [custom, setCustom] = useState('');
  const [message, setMessage] = useState('');
  // Whether the recipient may show this note on their page. Off by default, offered only while there
  // is a note, and dropped when the note is emptied, so a new note always asks again.
  const [noteMayShow, setNoteMayShow] = useState(false);
  const [payerName, setPayerName] = useState('');
  const [purpose, setPurpose] = useState<TipPurpose | ''>('');
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState('');
  // The optional details stay mounted when closed, so what was typed survives closing.
  const [extrasOpen, setExtrasOpen] = useState(false);
  const [messageError, setMessageError] = useState('');
  const [nameError, setNameError] = useState('');
  const [quote, setQuote] = useState<QuoteState>({ kind: 'idle' });
  const [notice, setNotice] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // One key per draft (quote + message): retries and double taps reuse it, so one tip at most.
  const draftKey = useRef<string | null>(null);
  const latestQuote = useRef(0);
  // Counted once a page view: choosing a key clears the field, and typing again is the same person.
  const customCounted = useRef(false);
  const customField = useRef<HTMLInputElement>(null);
  const firstChoice = useRef<HTMLInputElement>(null);
  const messageField = useRef<HTMLTextAreaElement>(null);
  const nameField = useRef<HTMLInputElement>(null);
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

  // The answer on screen belongs to the amount chosen now. A ready quote for this amount, with its
  // draft key, is what a retry replays, so a retried tip is never a second one.
  const shown: QuoteState =
    amount === null ||
    quote.kind === 'idle' ||
    (quote.kind === 'ready'
      ? Number(quote.quote.tipMinor) !== amount
      : quote.amount !== amount)
      ? { kind: 'idle' }
      : quote;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;
    // A phone's Go key, with the Tip bar and its total stepped aside for the keyboard: bring them
    // back rather than start anything the person can't see.
    const bar = form.current?.querySelector('.composer-action');
    const field = document.activeElement;
    if (
      bar &&
      getComputedStyle(bar).position === 'fixed' &&
      field instanceof HTMLElement &&
      field.matches('input:not([type="radio"], [type="checkbox"]), textarea')
    ) {
      field.blur();
      return;
    }
    track('tip_cta_clicked', { surface: 'profile', handle });
    if (!amount) {
      setError(
        selection === 'other'
          ? `Enter an amount of ${options.rangeText}, like ${presets[0]?.label ?? '1,000'} or 2,500.50.`
          : 'Choose an amount or enter your own.',
      );
      if (selection === 'other') customField.current?.focus();
      else (firstChoice.current ?? customField.current)?.focus();
      return;
    }
    setError('');
    setNotice('');
    // The API's own limits (the fields stop there too). An error in the closed details opens them.
    const tooLongMessage = message.trim().length > MESSAGE_LIMIT;
    const tooLongName = payerName.trim().length > NAME_LIMIT;
    setMessageError(
      tooLongMessage ? `Keep your message to ${MESSAGE_LIMIT} characters.` : '',
    );
    setNameError(
      tooLongName ? `Keep your name to ${NAME_LIMIT} characters.` : '',
    );
    if (tooLongMessage || tooLongName) {
      flushSync(() => setExtrasOpen(true));
      (tooLongMessage ? messageField : nameField).current?.focus();
      return;
    }
    // Never pay without a current server quote for exactly this amount.
    // Disabled from here on, so a double tap starts one tip.
    setSubmitting(true);
    const current =
      shown.kind === 'ready' ? shown.quote : await fetchQuote(amount);
    if (!current) {
      setSubmitting(false);
      return;
    }
    // The button says exactly what is charged. If the server ever disagrees, charge nothing.
    if (
      Number(current.tipMinor) !== amount ||
      Number(current.payerTotalMinor) !== amount
    ) {
      latestQuote.current += 1;
      draftKey.current = null;
      setQuote({ kind: 'failed', amount, message: AMOUNT_MISMATCH });
      setSubmitting(false);
      return;
    }
    draftKey.current ??= newIdempotencyKey();
    const trimmed = message.trim();
    const result = await createTip(draftKey.current, {
      quoteId: current.quoteId,
      ...(trimmed ? { message: trimmed } : {}),
      ...(trimmed && noteMayShow ? { noteMayShow: true as const } : {}),
      ...(purpose ? { purpose } : {}),
      ...(payerName.trim() ? { payerDisplayLabel: payerName.trim() } : {}),
      ...(joining && celebration
        ? { celebrationMomentId: celebration.momentId }
        : {}),
      ...(business ? { businessMemberId: business.memberId } : {}),
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
          JSON.stringify({
            optIn: remember,
            handle,
            ...(business ? { business: business.slug } : {}),
          }),
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
      // Nothing is charged without the supporter's tap. If the refresh itself fails, the quote area
      // already says why.
      if (await fetchQuote(amount))
        setNotice('That took a little too long. Please tap Tip again.');
      return;
    }
    setNotice(failureMessage(result, options.rangeText));
  };

  // On a phone the Tip bar can be pressed from anywhere on the page: bring a problem into view,
  // above the bar (the page's scroll padding), however far away the supporter was.
  const problem =
    error ||
    messageError ||
    nameError ||
    notice ||
    (shown.kind === 'failed' ? shown.message : '');
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
        field.matches('input:not([type="radio"], [type="checkbox"]), textarea')
      )
        field.blur();
    };
    view.addEventListener('resize', resized);
    return () => view.removeEventListener('resize', resized);
  }, [onProfile]);

  // Scroll padding and page padding follow the bar's real height: a notice or a failed quote
  // makes it taller, and the Report link must still clear it.
  useEffect(() => {
    const bar = form.current?.querySelector('.composer-action');
    if (!onProfile || !bar) return;
    const root = document.documentElement;
    const observer = new ResizeObserver(() => {
      root.style.setProperty(
        '--tip-bar',
        `${bar.getBoundingClientRect().height}px`,
      );
    });
    observer.observe(bar);
    return () => {
      observer.disconnect();
      root.style.removeProperty('--tip-bar');
    };
  }, [onProfile, closed]);

  // Tipping closed since this page loaded: the announcement beside the form goes with it.
  useEffect(() => {
    if (!closed) return;
    const announcement = document.querySelector<HTMLElement>(
      '.profile-celebration',
    );
    if (announcement) announcement.hidden = true;
  }, [closed]);

  // The tipping panel stays in view (CSS, sticky) only while it fits the window: a taller one
  // scrolls with the page, or its Tip button would stay below the fold. Opening the details can
  // make it taller while it is stuck: the scroll moves with it, so what is on screen stays put.
  useEffect(() => {
    const panel = form.current?.closest<HTMLElement>('[data-tip-panel]');
    if (!onProfile || !panel) return;
    const measure = () => {
      if (!matchMedia('(min-width: 861px)').matches) {
        panel.removeAttribute('data-taller-than-window');
        return;
      }
      const taller = panel.offsetHeight + PANEL_MARGIN_PX > innerHeight;
      if (taller === panel.hasAttribute('data-taller-than-window')) return;
      const before = panel.getBoundingClientRect().top;
      panel.toggleAttribute('data-taller-than-window', taller);
      const keepInPlace = () => {
        const moved = panel.getBoundingClientRect().top - before;
        if (moved) scrollBy({ top: moved, behavior: 'instant' });
      };
      keepInPlace();
      // The browser's scroll anchoring may nudge the page once more on the next layout.
      requestAnimationFrame(keepInPlace);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(panel);
    addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      removeEventListener('resize', measure);
      panel.removeAttribute('data-taller-than-window');
    };
  }, [onProfile, closed]);

  const busy = submitting;
  const extras = (
    <>
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
        maxLength={MESSAGE_LIMIT}
        value={message}
        disabled={submitting}
        ref={messageField}
        onChange={(event) => {
          // That someone started a note, never what it says.
          if (!message && event.target.value)
            track('message_started', { surface: 'profile', handle });
          setMessage(event.target.value);
          if (!event.target.value.trim()) setNoteMayShow(false);
          setMessageError('');
          draftKey.current = null;
        }}
        placeholder="Your work made a difference. Thank you."
        hint={`${message.length}/${MESSAGE_LIMIT} characters. Sent privately with your tip.`}
        error={messageError || undefined}
      />
      {message.trim() && (
        <label className="tip-remember" htmlFor={`${id}-note-may-show`}>
          <input
            id={`${id}-note-may-show`}
            type="checkbox"
            checked={noteMayShow}
            disabled={submitting}
            onChange={(event) => {
              setNoteMayShow(event.target.checked);
              draftKey.current = null;
            }}
          />
          <span>
            {recipient} may show this note on their page
            <small>
              With your name, if you gave one. Without this, your note stays
              private.
            </small>
          </span>
        </label>
      )}
      <InputField
        id={`${id}-name`}
        label="Your name (optional)"
        maxLength={NAME_LIMIT}
        autoComplete="name"
        value={payerName}
        disabled={submitting}
        ref={nameField}
        onChange={(event) => {
          setPayerName(event.target.value);
          setNameError('');
          draftKey.current = null;
        }}
        hint={`Shown to ${recipient} with your tip. Leave it empty to stay anonymous.`}
        error={nameError || undefined}
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
  // On a person's page a failed quote rides in the Tip bar, which hides while a field has
  // focus and takes a live region with it. So the words are read from one hidden region outside
  // the bar, and the visible copies stay out of the accessibility tree. Try again stays in it.
  const shownOnly = onProfile ? ({ 'aria-hidden': true } as const) : {};
  const quoteArea = (
    <div
      className="tip-quote"
      {...(onProfile ? {} : { 'aria-live': 'polite' })}
    >
      {shown.kind === 'failed' && (
        <div className="tip-quote__failed">
          <p className="tm-field-error" {...shownOnly}>
            {shown.message}
          </p>
          <Button
            variant="secondary"
            disabled={submitting}
            onClick={() => form.current?.requestSubmit()}
          >
            Try again
          </Button>
        </div>
      )}
    </div>
  );
  if (closed || !copy.payable)
    return (
      <TippingOpensSoon
        announce={closed}
        {...(onProfile ? { handle, name: recipient } : {})}
      />
    );
  return (
    <Card
      className={`appreciation-card ${compact ? 'appreciation-card--compact' : ''}`}
    >
      {/* A person's page says its mode once, in the wording beside the Tip button. */}
      {!onProfile && (
        <div className="composer-topline">
          <span className="eyebrow">A little appreciation</span>
          {copy.formBadge && <Badge>{copy.formBadge}</Badge>}
        </div>
      )}
      {/* No browser form restoration: after Back, the controls must match React's state. */}
      <form
        ref={form}
        onSubmit={submit}
        noValidate
        autoComplete="off"
        {...(submitting ? { 'data-submitting': '' } : {})}
      >
        {onProfile ? (
          <h2>
            Tip {recipient}
            {business ? ` at ${business.name}` : ''}
          </h2>
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
          <legend className="sr-only">Choose an amount</legend>
          <p id={`${id}-currency`} className="sr-only">
            Amounts are in NGN.
          </p>
          <div className="amount-fit">
            <div
              className="amount-options"
              style={
                {
                  '--keys-small': layout.small,
                  '--keys-medium': layout.medium,
                  '--keys-large': layout.large,
                } as CSSProperties
              }
            >
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
                    choseAmount.current = true;
                    setCustom('');
                    setError('');
                    track('amount_selected', { surface: 'profile', handle });
                  }}
                  // Tapping the amount already shown is a choice too.
                  onClick={() => {
                    // A different amount is counted by onChange; this is only the one already shown.
                    if (
                      choseAmount.current ||
                      selection !== String(preset.minor)
                    )
                      return;
                    choseAmount.current = true;
                    track('amount_selected', { surface: 'profile', handle });
                  }}
                >
                  ₦{preset.label}
                </AmountChoice>
              ))}
            </div>
          </div>
          {error && selection !== 'other' && (
            <p className="tm-field-error" role="alert" id={`${id}-error`}>
              {error}
            </p>
          )}
        </fieldset>
        <InputField
          id={`${id}-custom`}
          label={`Other amount (${options.rangeText})`}
          inputMode="decimal"
          autoComplete="off"
          maxLength={16}
          placeholder={`e.g. ${options.example}`}
          value={selection === 'other' ? custom : ''}
          disabled={submitting}
          ref={customField}
          onChange={(event) => {
            if (!customCounted.current && event.target.value) {
              customCounted.current = true;
              track('custom_amount_entered', { surface: 'profile', handle });
            }
            setSelection('other');
            choseAmount.current = true;
            setCustom(event.target.value);
            setError('');
          }}
          error={selection === 'other' && error ? error : undefined}
        />
        {onProfile ? (
          <p className="tip-quote-live sr-only" aria-live="polite">
            {shown.kind === 'failed' ? shown.message : ''}
          </p>
        ) : (
          quoteArea
        )}
        {celebration && (
          <label className="tip-remember tip-celebrate" htmlFor={`${id}-join`}>
            <input
              id={`${id}-join`}
              type="checkbox"
              checked={joining}
              disabled={submitting}
              onChange={(event) => {
                setJoining(event.target.checked);
                draftKey.current = null;
              }}
            />
            <span>Add to the celebration</span>
          </label>
        )}
        <details
          className="composer-extras"
          open={extrasOpen}
          onToggle={(event) => setExtrasOpen(event.currentTarget.open)}
        >
          <summary
            // The payment moment stays still: nothing opens or closes while a tip starts.
            onClick={(event) => {
              if (submitting) event.preventDefault();
            }}
          >
            Add a message, reason or your name
          </summary>
          <div className="composer-extras__body">{extras}</div>
        </details>
        {notice && (
          <Notice tone="error" title="Not sent yet">
            {notice}
          </Notice>
        )}
        {/* A fixed bar on a phone's public page (CSS): still this form's one submit button. */}
        <TipAction
          partner={copy.formPartner}
          {...(onProfile
            ? {
                quote: quoteArea,
                notice: barNotice ?? copy.formDisclaimer,
              }
            : {})}
        >
          <Button
            className="composer-submit"
            type="submit"
            disabled={busy}
            aria-busy={busy}
          >
            {submitting
              ? 'Starting your tip…'
              : amount
                ? `Tip ${onProfile ? formatNaira(amount) : formatDemoAmount(amount)}`
                : 'Tip'}{' '}
            <Arrow />
          </Button>
        </TipAction>
        {(pilotNotice || copy.formDisclaimer) && (
          <p className="composer-disclaimer">
            {/* The mode wording: on a phone with the Tip bar, the bar carries it and CSS removes this
                copy, so it is seen and read once. A block of its own; outside live mode the pilot
                notice renders nothing, so no break after it. */}
            <span className="composer-disclaimer__mode">
              {pilotNotice}
              {copy.formDisclaimer && <>{copy.formDisclaimer}</>}
            </span>
          </p>
        )}
        {onProfile && copy.formTrust && (
          <p className="composer-trust">{copy.formTrust}</p>
        )}
      </form>
    </Card>
  );
}
